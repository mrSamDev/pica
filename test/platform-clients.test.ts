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
