import { z } from "zod";

import type { ExistingComment } from "../review/types.ts";
import { safeFetch, HttpError } from "./ssrf.ts";
import { createStaticTokenProvider, type TokenProvider } from "./token.ts";
import type { PlatformClient } from "./types.ts";

export interface BitbucketDeps {
  // Static token (Bitbucket always uses a static App password; never refreshable).
  token?: string;
  tokenProvider?: TokenProvider;
  allowedHosts: ReadonlySet<string>;
  maxDiffBytes: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const API_BASE = "https://api.bitbucket.org/2.0";

const commentSchema = z.object({
  id: z.union([z.string(), z.number()]),
  content: z.object({ raw: z.string() }),
  inline: z.object({ path: z.string(), to: z.number().nullable() }).nullable().optional(),
});

const commentsResponseSchema = z.object({ values: z.array(commentSchema) });

const commentIdSchema = z.object({ id: z.union([z.string(), z.number()]) });

const commentStateSchema = z.object({
  resolved: z.boolean().optional(),
  deleted: z.boolean().optional(),
  replies: z.array(z.unknown()).optional(),
});

// A comment POST that returns an unparseable body means the comment may have
// been created with a real server id we can no longer see. Store "" and it is
// unattributable forever (and collides on the unique platform+comment_id
// index), so fail loudly and let BullMQ retry.
function parseCreatedComment(body: string): string {
  const parsed = commentIdSchema.safeParse(JSON.parse(body));
  if (!parsed.success) {
    throw new Error("comment POST returned an unparseable response");
  }
  return String(parsed.data.id);
}

export function createBitbucketClient(deps: BitbucketDeps): PlatformClient {
  const getToken: TokenProvider = deps.tokenProvider ?? (deps.token !== undefined ? createStaticTokenProvider(deps.token) : () => Promise.reject(new Error("platform token not configured")));
  return {
    async fetchDiff(diffHref) {
      return safeFetch(diffHref, {
        allowedHosts: deps.allowedHosts,
        maxBytes: deps.maxDiffBytes,
        authToken: await getToken(),
        timeoutMs: deps.timeoutMs,
        fetchImpl: deps.fetchImpl,
      });
    },
    async listComments(repo, prId) {
      const url = `${API_BASE}/repositories/${repo}/pullrequests/${prId}/comments`;
      const body = await safeFetch(url, {
        allowedHosts: deps.allowedHosts,
        maxBytes: 1_000_000,
        authToken: await getToken(),
        timeoutMs: deps.timeoutMs,
        fetchImpl: deps.fetchImpl,
      });
      // Parse per-item: a file-level or malformed comment must not void the
      // whole list (that would silently disable the no-repeat-human filter).
      const parsed = commentsResponseSchema.safeParse(JSON.parse(body));
      if (!parsed.success) {
        return [];
      }
      const comments: ExistingComment[] = [];
      for (const c of parsed.data.values) {
        const item = commentSchema.safeParse(c);
        if (!item.success || !item.data.inline || item.data.inline.to === null) continue;
        comments.push({ filePath: item.data.inline.path, lineStart: item.data.inline.to, lineEnd: item.data.inline.to, category: "", message: item.data.content.raw });
      }
      return comments;
    },
    async createInlineComment(repo, prId, target, content) {
      const url = `${API_BASE}/repositories/${repo}/pullrequests/${prId}/comments`;
      const body = await safeFetch(url, {
        allowedHosts: deps.allowedHosts,
        maxBytes: 1_000_000,
        authToken: await getToken(),
        timeoutMs: deps.timeoutMs,
        fetchImpl: deps.fetchImpl,
        method: "POST",
        body: JSON.stringify({ content: { raw: content }, inline: { path: target.path, to: target.line } }),
      });
      return { id: parseCreatedComment(body) };
    },
    async createPrComment(repo, prId, content) {
      const url = `${API_BASE}/repositories/${repo}/pullrequests/${prId}/comments`;
      const body = await safeFetch(url, {
        allowedHosts: deps.allowedHosts,
        maxBytes: 1_000_000,
        authToken: await getToken(),
        timeoutMs: deps.timeoutMs,
        fetchImpl: deps.fetchImpl,
        method: "POST",
        body: JSON.stringify({ content: { raw: content } }),
      });
      return { id: parseCreatedComment(body) };
    },
    async getCommentState(repo, prId, commentId) {
      const url = `${API_BASE}/repositories/${repo}/pullrequests/${prId}/comments/${commentId}`;
      let body: string;
      try {
        body = await safeFetch(url, {
          allowedHosts: deps.allowedHosts,
          maxBytes: 1_000_000,
          authToken: await getToken(),
          timeoutMs: deps.timeoutMs,
          fetchImpl: deps.fetchImpl,
        });
      } catch (error) {
        // Same deletion contract as src/platform/github.ts: only a 404 proves
        // the comment is gone; a transient 5xx is retried, never fabricated
        // as a terminal dismissal (H1).
        if (error instanceof HttpError && error.status === 404) {
          return { resolved: false, deleted: true, replyCount: 0 };
        }
        throw error;
      }
      const parsed = commentStateSchema.safeParse(JSON.parse(body));
      if (!parsed.success) {
        return { resolved: false, deleted: false, replyCount: 0 };
      }
      return {
        resolved: parsed.data.resolved ?? false,
        deleted: parsed.data.deleted ?? false,
        replyCount: parsed.data.replies?.length ?? 0,
      };
    },
  };
}
