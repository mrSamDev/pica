import { z } from "zod";

import type { ExistingComment } from "../review/types.ts";
import { safeFetch } from "./ssrf.ts";
import type { PlatformClient } from "./types.ts";

export interface GitHubDeps {
  token: string;
  allowedHosts: ReadonlySet<string>;
  maxDiffBytes: number;
  fetchImpl?: typeof fetch;
}

const API_BASE = "https://api.github.com";

const commentSchema = z.object({
  id: z.union([z.string(), z.number()]),
  path: z.string(),
  line: z.number(),
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
      const url = `${API_BASE}/repos/${repo}/pulls/${prId}/comments`;
      const body = await safeFetch(url, {
        allowedHosts: deps.allowedHosts,
        maxBytes: 1_000_000,
        authToken: deps.token,
        fetchImpl: deps.fetchImpl,
      });
      const parsed = z.array(commentSchema).safeParse(JSON.parse(body));
      if (!parsed.success) {
        return [];
      }
      return parsed.data.map((c) => ({ filePath: c.path, lineStart: c.line, lineEnd: c.line, category: "", message: c.body }) satisfies ExistingComment);
    },
    async createInlineComment(repo, prId, target, content) {
      const url = `${API_BASE}/repos/${repo}/pulls/${prId}/comments`;
      const body = await safeFetch(url, {
        allowedHosts: deps.allowedHosts,
        maxBytes: 1_000_000,
        authToken: deps.token,
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
        authToken: deps.token,
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
      return { resolved: false, deleted: false, replyCount: parsed.data.in_reply_to ? 1 : 0 };
    },
  };
}
