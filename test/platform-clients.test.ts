import { describe, expect, it } from "vitest";

import { createGitHubClient } from "../src/platform/github.ts";
import { createBitbucketClient } from "../src/platform/bitbucket.ts";

const allowed = new Set(["api.github.com", "api.bitbucket.org"]);

function resp(body: string, status = 200): Response {
  return new Response(body, { status });
}

const target = { path: "src/a.ts", line: 1, commitSha: "abc" };

describe("platform clients: comment POST", () => {
  it("throws on an unparseable comment POST instead of storing id '' (unattributable comment)", async () => {
    const gh = createGitHubClient({ token: "t", allowedHosts: allowed, maxDiffBytes: 1000, fetchImpl: async () => resp("{}") });
    await expect(gh.createInlineComment("r", "1", target, "hi")).rejects.toThrow(/unparseable/);
    await expect(gh.createPrComment("r", "1", "summary")).rejects.toThrow(/unparseable/);

    const bb = createBitbucketClient({ token: "t", allowedHosts: allowed, maxDiffBytes: 1000, fetchImpl: async () => resp("{}") });
    await expect(bb.createInlineComment("r", "1", target, "hi")).rejects.toThrow(/unparseable/);
    await expect(bb.createPrComment("r", "1", "summary")).rejects.toThrow(/unparseable/);
  });

  it("returns the real server id on a well-formed comment POST", async () => {
    const gh = createGitHubClient({ token: "t", allowedHosts: allowed, maxDiffBytes: 1000, fetchImpl: async () => resp('{"id": 123}') });
    expect((await gh.createInlineComment("r", "1", target, "hi")).id).toBe("123");
    expect((await gh.createPrComment("r", "1", "summary")).id).toBe("123");

    const bb = createBitbucketClient({ token: "t", allowedHosts: allowed, maxDiffBytes: 1000, fetchImpl: async () => resp('{"id": "xyz"}') });
    expect((await bb.createInlineComment("r", "1", target, "hi")).id).toBe("xyz");
    expect((await bb.createPrComment("r", "1", "summary")).id).toBe("xyz");
  });
});

describe("platform clients: listComments (M1: per-item parse, skip non-anchorable comments)", () => {
  it("github: keeps anchorable comments, skips line:null comments instead of voiding the list", async () => {
    const body = JSON.stringify([
      { id: 1, path: "src/a.ts", line: 4, body: "review" },
      { id: 2, path: "src/b.ts", line: null, body: "file-level comment" },
      { id: 3, path: "src/c.ts", line: 9, body: "another" },
    ]);
    const gh = createGitHubClient({ token: "t", allowedHosts: allowed, maxDiffBytes: 1000, fetchImpl: async () => resp(body) });
    const comments = await gh.listComments("r", "1");
    expect(comments).toHaveLength(2);
    expect(comments.map((c) => c.filePath)).toEqual(["src/a.ts", "src/c.ts"]);
  });

  it("github: a single malformed comment is skipped without dropping the valid ones", async () => {
    const body = JSON.stringify([
      { id: 1, path: "src/a.ts", line: 4, body: "review" },
      { id: 2, path: "src/missing.ts" },
      { id: 3, path: "src/c.ts", line: 9, body: "another" },
    ]);
    const gh = createGitHubClient({ token: "t", allowedHosts: allowed, maxDiffBytes: 1000, fetchImpl: async () => resp(body) });
    expect(await gh.listComments("r", "1")).toHaveLength(2);
  });

  it("bitbucket: keeps inline comments, skips file-level (to:null) and non-inline ones", async () => {
    const body = JSON.stringify({
      values: [
        { id: 1, content: { raw: "a" }, inline: { path: "src/a.ts", to: 4 } },
        { id: 2, content: { raw: "b" }, inline: { path: "src/b.ts", to: null } },
        { id: 3, content: { raw: "c" } },
        { id: 4, content: { raw: "d" }, inline: { path: "src/d.ts", to: 8 } },
      ],
    });
    const bb = createBitbucketClient({ token: "t", allowedHosts: allowed, maxDiffBytes: 1000, fetchImpl: async () => resp(body) });
    const comments = await bb.listComments("r", "1");
    expect(comments).toHaveLength(2);
    expect(comments.map((c) => c.filePath)).toEqual(["src/a.ts", "src/d.ts"]);
  });

  it("listComments: an empty response yields no comments", async () => {
    const gh = createGitHubClient({ token: "t", allowedHosts: allowed, maxDiffBytes: 1000, fetchImpl: async () => resp("[]") });
    expect(await gh.listComments("r", "1")).toHaveLength(0);
    const bb = createBitbucketClient({ token: "t", allowedHosts: allowed, maxDiffBytes: 1000, fetchImpl: async () => resp('{"values": []}') });
    expect(await bb.listComments("r", "1")).toHaveLength(0);
  });
});

describe("platform clients: getCommentState (H1: only 404 means deleted)", () => {
  it("github: 404 -> deleted; a transient 5xx does NOT fabricate a dismissal", async () => {
    const gh404 = createGitHubClient({ token: "t", allowedHosts: allowed, maxDiffBytes: 1000, fetchImpl: async () => resp('{"message":"Not Found"}', 404) });
    expect(await gh404.getCommentState("r", "1", "c")).toEqual({ resolved: false, deleted: true, replyCount: 0 });

    const gh502 = createGitHubClient({ token: "t", allowedHosts: allowed, maxDiffBytes: 1000, fetchImpl: async () => resp('{"error":"upstream"}', 502) });
    await expect(gh502.getCommentState("r", "1", "c")).rejects.toThrow(/502/);
  });

  it("bitbucket: 404 -> deleted; a transient 5xx does NOT fabricate a dismissal", async () => {
    const bb404 = createBitbucketClient({ token: "t", allowedHosts: allowed, maxDiffBytes: 1000, fetchImpl: async () => resp('{"type":"error"}', 404) });
    expect(await bb404.getCommentState("r", "1", "c")).toEqual({ resolved: false, deleted: true, replyCount: 0 });

    const bb502 = createBitbucketClient({ token: "t", allowedHosts: allowed, maxDiffBytes: 1000, fetchImpl: async () => resp('{"error":"upstream"}', 502) });
    await expect(bb502.getCommentState("r", "1", "c")).rejects.toThrow(/502/);
  });
});
