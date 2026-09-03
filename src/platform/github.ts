import { z } from "zod";

import type { ExistingComment } from "../review/types.ts";
import { safeFetch, HttpError } from "./ssrf.ts";
import { createStaticTokenProvider, type TokenProvider } from "./token.ts";
import type { PlatformClient } from "./types.ts";

export interface GitHubDeps {
  // Static PAT (back-compat), or a tokenProvider for GitHub App install tokens.
  token?: string;
  tokenProvider?: TokenProvider;
  allowedHosts: ReadonlySet<string>;
  maxDiffBytes: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const API_BASE = "https://api.github.com";

const commentSchema = z.object({
  id: z.union([z.string(), z.number()]),
  path: z.string(),
  // GitHub review comments can carry line: null (file-level or outdated
  // comments). They are real comments whose location we cannot anchor, so we
  // skip them rather than failing the whole list.
  line: z.number().nullable(),
  body: z.string(),
});

const commentIdSchema = z.object({ id: z.union([z.string(), z.number()]) });

// GitHub review comments carry no resolved flag; a 404 means deleted, and
// in_reply_to marks a reply. Best-effort for the poller.
const commentStateSchema = z.object({ in_reply_to: z.number().nullable().optional() });

// A comment POST that returns an unparseable/bad-status body means the comment
// may have been created with a real server id we can no longer see. Store ""
// and the comment becomes unattributable forever (and "" collides on the
// unique platform+comment_id index), so fail loudly and let BullMQ retry.
function parseCreatedComment(body: string): string {
  const parsed = commentIdSchema.safeParse(JSON.parse(body));
  if (!parsed.success) {
    throw new Error("comment POST returned an unparseable response");
  }
  return String(parsed.data.id);
}

export function createGitHubClient(deps: GitHubDeps): PlatformClient {
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
      const url = `${API_BASE}/repos/${repo}/pulls/${prId}/comments`;
      let body: string;
      try {
        body = await safeFetch(url, {
          allowedHosts: deps.allowedHosts,
          maxBytes: 1_000_000,
          authToken: await getToken(),
          timeoutMs: deps.timeoutMs,
          fetchImpl: deps.fetchImpl,
        });
      } catch {
        // Upstream list failure is not "no comments". Rethrow so the review
        // worker retries instead of the repeat-human filter silently dropping
        // every existing comment.
        throw new Error(`failed to list comments for ${repo}#${prId}`);
      }
      // Parse per-item: one malformed/outdated comment must not void the whole
      // list (that would silently disable the no-repeat-human filter).
      const array = JSON.parse(body);
      if (!Array.isArray(array)) {
        return [];
      }
      const comments: ExistingComment[] = [];
      for (const raw of array) {
        const item = commentSchema.safeParse(raw);
        if (!item.success || item.data.line === null) continue;
        comments.push({ filePath: item.data.path, lineStart: item.data.line, lineEnd: item.data.line, category: "", message: item.data.body });
      }
      return comments;
    },
    async createInlineComment(repo, prId, target, content) {
      const url = `${API_BASE}/repos/${repo}/pulls/${prId}/comments`;
      const body = await safeFetch(url, {
        allowedHosts: deps.allowedHosts,
        maxBytes: 1_000_000,
        authToken: await getToken(),
        timeoutMs: deps.timeoutMs,
        fetchImpl: deps.fetchImpl,
        method: "POST",
        body: JSON.stringify({ body: content, commit_id: target.commitSha, path: target.path, line: target.line }),
      });
      return { id: parseCreatedComment(body) };
    },
    async createPrComment(repo, prId, content) {
      // PR comments are issue comments on GitHub.
      const url = `${API_BASE}/repos/${repo}/issues/${prId}/comments`;
      const body = await safeFetch(url, {
        allowedHosts: deps.allowedHosts,
        maxBytes: 1_000_000,
        authToken: await getToken(),
        timeoutMs: deps.timeoutMs,
        fetchImpl: deps.fetchImpl,
        method: "POST",
        body: JSON.stringify({ body: content }),
      });
      return { id: parseCreatedComment(body) };
    },
    async getCommentState(repo, prId, commentId) {
      const url = `${API_BASE}/repos/${repo}/pulls/${prId}/comments/${commentId}`;
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
        // ONLY a 404 means the comment is gone. A transient 5xx or network
        // error is not proof of deletion — rethrow so the poller skips this
        // comment this round instead of fabricating a terminal dismissal (H1).
        if (error instanceof HttpError && error.status === 404) {
          return { resolved: false, deleted: true, replyCount: 0 };
        }
        throw error;
      }
      const parsed = commentStateSchema.safeParse(JSON.parse(body));
      if (!parsed.success) {
        return { resolved: false, deleted: false, replyCount: 0 };
      }
      return { resolved: false, deleted: false, replyCount: parsed.data.in_reply_to ? 1 : 0 };
    },
  };
}
