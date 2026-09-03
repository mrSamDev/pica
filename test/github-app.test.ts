import { describe, expect, it, beforeAll, vi } from "vitest";
import crypto from "node:crypto";

import { createAppTokenProvider, createStaticTokenProvider, createPlatformTokenProvider } from "../src/platform/token.ts";
import type { PlatformTokenConfig } from "../src/platform/token.ts";

let publicKey: crypto.KeyObject;
let privateKey: crypto.KeyObject;

beforeAll(() => {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
});

const privatePem = (): string => privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const appDeps = (overrides: Partial<Parameters<typeof createAppTokenProvider>[0]> = {}) => ({
  appId: "123456",
  privateKeyPem: privatePem(),
  installationId: "789",
  allowedHosts: new Set(["api.github.com", "github.com"]),
  ...overrides,
});

function tokenResponse(expiresInMs: number, token = "inst-token-abc"): Response {
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
  return new Response(JSON.stringify({ token, expires_at: expiresAt }), { status: 200 });
}

describe("createStaticTokenProvider", () => {
  it("returns the given token", async () => {
    const provider = createStaticTokenProvider("static-token");
    expect(await provider()).toBe("static-token");
    expect(await provider()).toBe("static-token");
  });
});

describe("createAppTokenProvider", () => {
  it("signs a valid RS256 JWT with correct iss/iat/exp claims", async () => {
    let receivedAuth: string | undefined;
    const provider = createAppTokenProvider(
      appDeps({
        fetchImpl: async (_url, init) => {
          // SAFETY: safeFetch attaches a plain object for headers; we capture
          // only the Authorization value for the assertion below.
          const headers = (init?.headers ?? {}) as Record<string, string>;
          receivedAuth = headers["Authorization"];
          return tokenResponse(3_600_000);
        },
      }),
    );

    await provider();
    if (!receivedAuth) {
      throw new Error("expected an Authorization header from the mocked fetch");
    }
    const bearer = receivedAuth.slice("Bearer ".length);
    const parts = bearer.split(".");
    // SAFETY: an RS256 JWT is exactly three dot-separated segments, and we built it.
    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());

    expect(header.alg).toBe("RS256");
    expect(payload.iss).toBe(123456);
    expect(payload.exp - payload.iat).toBe(660); // 11 min window (600s ttl + 60s skew)
    expect(payload.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 600);

    // Signature verifies against the app's public key.
    const data = Buffer.from(`${headerB64}.${payloadB64}`);
    const ok = crypto.verify("RSA-SHA256", data, publicKey, Buffer.from(sigB64, "base64url"));
    expect(ok).toBe(true);
  });

  it("POSTs to the installation access_tokens endpoint and returns the token", async () => {
    let received: { url: string; method?: string; body?: string } | undefined;
    const provider = createAppTokenProvider(
      appDeps({
        fetchImpl: async (url, init) => {
          received = {
            url: String(url),
            method: init?.method,
            body: String(init?.body ?? ""),
          };
          return tokenResponse(3_600_000, "installation-token-1");
        },
      }),
    );

    await expect(provider()).resolves.toBe("installation-token-1");
    expect(received?.url).toBe("https://api.github.com/app/installations/789/access_tokens");
    expect(received?.method).toBe("POST");
    expect(JSON.parse(received!.body!)).toEqual({});
  });

  it("caches a valid token and does not refetch while fresh", async () => {
    let calls = 0;
    const provider = createAppTokenProvider(
      appDeps({
        fetchImpl: async () => {
          calls++;
          return tokenResponse(3_600_000, `tok-${calls}`);
        },
      }),
    );

    const first = await provider();
    const second = await provider();
    expect(first).toBe("tok-1");
    expect(second).toBe("tok-1");
    expect(calls).toBe(1);
  });

  it("single-flights concurrent calls", async () => {
    let calls = 0;
    const provider = createAppTokenProvider(
      appDeps({
        fetchImpl: async () => {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return tokenResponse(3_600_000, `tok-${calls}`);
        },
      }),
    );

    const results = await Promise.all([provider(), provider(), provider()]);
    expect(calls).toBe(1);
    expect(new Set(results).size).toBe(1);
  });

  it("refetches once the token approaches its expiry", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const provider = createAppTokenProvider(
        appDeps({
          fetchImpl: async () => {
            calls++;
            return tokenResponse(3_600_000, `tok-${calls}`);
          },
        }),
      );

      expect(await provider()).toBe("tok-1");
      // Token valid 60 min, refresh margin 5 min. Advance to the margin edge.
      vi.setSystemTime(Date.now() + 55 * 60 * 1000);
      expect(await provider()).toBe("tok-2");
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache a failed fetch so the next call retries", async () => {
    let calls = 0;
    const provider = createAppTokenProvider(
      appDeps({
        fetchImpl: async () => {
          calls++;
          if (calls === 1) return new Response("{} bad", { status: 401 });
          return tokenResponse(3_600_000, "recovered-token");
        },
      }),
    );

    await expect(provider()).rejects.toThrow();
    expect(calls).toBe(1);
    await expect(provider()).resolves.toBe("recovered-token");
    expect(calls).toBe(2);
  });

  it("blocks a non-allowlisted API host via the SSRF guard", async () => {
    const provider = createAppTokenProvider(appDeps({ allowedHosts: new Set(["github.com"]) }));
    // api.github.com is not allowlisted, so the fetch is rejected before it starts.
    await expect(provider()).rejects.toThrow(/Host not allowed: api\.github\.com/);
  });

  it("does not leak the private key in sign/parse error messages", async () => {
    const secretSnippet = "GARBAGE_TRAILING_SECRET_EXTRA";
    const provider = createAppTokenProvider(appDeps({ privateKeyPem: `MIIB not-a-real-pem ${secretSnippet}` }));
    try {
      await provider();
      expect.unreachable("should throw for an invalid private key");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secretSnippet);
    }
  });
});

describe("createPlatformTokenProvider", () => {
  const base = (): PlatformTokenConfig => ({
    PLATFORM: "github",
    PLATFORM_TOKEN: "pat-token",
    GITHUB_APP_ID: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    GITHUB_INSTALLATION_ID: undefined,
    ALLOWED_HOSTS: new Set(["api.github.com"]),
  });

  it("uses a static token provider when no app credentials are set", async () => {
    const provider = createPlatformTokenProvider(base());
    expect(await provider()).toBe("pat-token");
  });

  it("uses the app token provider when GitHub app credentials are set", async () => {
    const config = base();
    config.GITHUB_APP_ID = "123456";
    config.GITHUB_APP_PRIVATE_KEY = privatePem();
    config.GITHUB_INSTALLATION_ID = "789";
    const provider = createPlatformTokenProvider(config, {
      fetchImpl: async () => tokenResponse(3_600_000, "app-token"),
    });
    await expect(provider()).resolves.toBe("app-token");
  });
});
