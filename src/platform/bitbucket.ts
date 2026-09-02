import { z } from "zod";

import type { ExistingComment } from "../review/types.ts";
import { safeFetch } from "./ssrf.ts";
import type { PlatformClient } from "./types.ts";

export interface BitbucketDeps {
  token: string;
  allowedHosts: ReadonlySet<string>;
  maxDiffBytes: number;
  fetchImpl?: typeof fetch;
}

const API_BASE = "https://api.bitbucket.org/2.0";

const commentSchema = z.object({
  id: z.union([z.string(), z.number()]),
  content: z.object({ raw: z.string() }),
  inline: z.object({ path: z.string(), to: z.number() }),
});

const commentsResponseSchema = z.object({ values: z.array(commentSchema) });

const commentIdSchema = z.object({ id: z.union([z.string(), z.number()]) });

const commentStateSchema = z.object({
  resolved: z.boolean().optional(),
  deleted: z.boolean().optional(),
  replies: z.array(z.unknown()).optional(),
});

export function createBitbucketClient(deps: BitbucketDeps): PlatformClient {
  return {
    async fetchDiff(diffHref) {
      return safeFetch(diffHref, {
        allowedHosts: deps.allowedHosts,
        maxBytes: deps.maxDiffBytes,
        authToken: deps.token,
        fetchImpl: deps.fetchImpl,
      });
    },
    async listComments(repo, prId) {
      const url = `${API_BASE}/repositories/${repo}/pullrequests/${prId}/comments`;
      const body = await safeFetch(url, {
        allowedHosts: deps.allowedHosts,
        maxBytes: 1_000_000,
        authToken: deps.token,
        fetchImpl: deps.fetchImpl,
      });
      const parsed = commentsResponseSchema.safeParse(JSON.parse(body));
      if (!parsed.success) {
        return [];
      }
      return parsed.data.values.map((c) => ({ filePath: c.inline.path, lineStart: c.inline.to, lineEnd: c.inline.to, category: "", message: c.content.raw }) satisfies ExistingComment);
    },
    async createInlineComment(repo, prId, target, content) {
      const url = `${API_BASE}/repositories/${repo}/pullrequests/${prId}/comments`;
      const body = await safeFetch(url, {
        allowedHosts: deps.allowedHosts,
        maxBytes: 1_000_000,
        authToken: deps.token,
        fetchImpl: deps.fetchImpl,
        method: "POST",
        body: JSON.stringify({ content: { raw: content }, inline: { path: target.path, to: target.line } }),
      });
      const parsed = commentIdSchema.safeParse(JSON.parse(body));
      return { id: parsed.success ? String(parsed.data.id) : "" };
    },
    async createPrComment(repo, prId, content) {
      const url = `${API_BASE}/repositories/${repo}/pullrequests/${prId}/comments`;
      const body = await safeFetch(url, {
        allowedHosts: deps.allowedHosts,
        maxBytes: 1_000_000,
        authToken: deps.token,
        fetchImpl: deps.fetchImpl,
        method: "POST",
        body: JSON.stringify({ content: { raw: content } }),
      });
      const parsed = commentIdSchema.safeParse(JSON.parse(body));
      return { id: parsed.success ? String(parsed.data.id) : "" };
    },
    async getCommentState(repo, prId, commentId) {
      const url = `${API_BASE}/repositories/${repo}/pullrequests/${prId}/comments/${commentId}`;
      let body: string;
      try {
        body = await safeFetch(url, {
          allowedHosts: deps.allowedHosts,
          maxBytes: 1_000_000,
          authToken: deps.token,
          fetchImpl: deps.fetchImpl,
        });
      } catch {
        // 404 or network error: the comment is gone.
        return { resolved: false, deleted: true, replyCount: 0 };
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
