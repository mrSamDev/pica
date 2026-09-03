import { describe, expect, it } from "vitest";

import { safeFetch } from "../src/platform/ssrf.ts";

const allowed = new Set(["api.github.com", "github.com"]);

function jsonResponse(body: string, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(body, {
    status: init?.status ?? 200,
    headers: init?.headers,
  });
}

describe("ssrf", () => {
  it("blocks disallowed host before fetching", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string | Request | URL) => {
      calls.push(String(input));
      return jsonResponse("ok");
    };
    await expect(safeFetch("https://evil.example.com/secret", { allowedHosts: allowed, maxBytes: 1000, fetchImpl })).rejects.toThrow(/Host not allowed/);
    expect(calls).toHaveLength(0);
  });

  it("pins against redirect to arbitrary host", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string | Request | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://api.github.com")) {
        return jsonResponse("", { status: 302, headers: { location: "https://evil.example.com/steal" } });
      }
      return jsonResponse("ok");
    };
    await expect(safeFetch("https://api.github.com/repos/x", { allowedHosts: allowed, maxBytes: 1000, fetchImpl })).rejects.toThrow(/Host not allowed/);
    // The trusted host was fetched once; the untrusted redirect target never was.
    expect(calls).toEqual(["https://api.github.com/repos/x"]);
  });

  it("never attaches auth token to untrusted URL", async () => {
    const requested: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = async (input: string | Request | URL, init?: RequestInit) => {
      const url = String(input);
      // SAFETY: RequestInit.headers is a HeadersInit; we only read the Authorization key we set.
      const headers = init?.headers as Record<string, string> | undefined;
      requested.push({ url, auth: headers?.Authorization ?? null });
      if (url.startsWith("https://api.github.com")) {
        return jsonResponse("", { status: 302, headers: { location: "https://evil.example.com/steal" } });
      }
      return jsonResponse("ok");
    };
    await expect(safeFetch("https://api.github.com/repos/x", { allowedHosts: allowed, maxBytes: 1000, authToken: "secret-token", fetchImpl })).rejects.toThrow(/Host not allowed/);
    // The untrusted host was never requested, so the token was never sent to it.
    expect(requested.some((r) => r.url.includes("evil.example.com"))).toBe(false);
    // The trusted host did receive the token.
    expect(requested[0]?.auth).toBe("Bearer secret-token");
  });

  it("aborts early on content-length over cap", async () => {
    const fetchImpl = async () => jsonResponse("x".repeat(5000), { headers: { "content-length": "5000" } });
    await expect(safeFetch("https://api.github.com/repos/x", { allowedHosts: allowed, maxBytes: 100, fetchImpl })).rejects.toThrow(/Response too large/);
  });

  it("aborts on streamed body over cap", async () => {
    const fetchImpl = async () => jsonResponse("x".repeat(5000));
    await expect(safeFetch("https://api.github.com/repos/x", { allowedHosts: allowed, maxBytes: 100, fetchImpl })).rejects.toThrow(/Response too large/);
  });

  it("throws on a non-2xx status instead of treating error JSON as a body", async () => {
    // A 404 returns an error JSON body; without the status check safeFetch would
    // hand that JSON back as the successful response (a dead diff/comment path).
    const fetchImpl = async () => jsonResponse('{"message":"Not Found"}', { status: 404 });
    await expect(safeFetch("https://api.github.com/repos/x", { allowedHosts: allowed, maxBytes: 1000, fetchImpl })).rejects.toThrow(/status 404/);
    const five = async () => jsonResponse('{"error":"upstream"}', { status: 502 });
    await expect(safeFetch("https://api.github.com/repos/x", { allowedHosts: allowed, maxBytes: 1000, fetchImpl: five })).rejects.toThrow(/status 502/);
  });
});
