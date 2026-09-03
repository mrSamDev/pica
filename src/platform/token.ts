import crypto from "node:crypto";
import { z } from "zod";

import { safeFetch } from "./ssrf.ts";

/**
 * Supplies an auth token for a platform API call. A static provider returns a
 * fixed PAT; a GitHub App provider mints short-lived installation tokens and
 * refreshes them transparently. The abstraction exists because an installation
 * token expires hourly, so it cannot be read once at boot.
 */
export type TokenProvider = () => Promise<string>;

/** GitHub App auth: a never-expiring static token. */
export function createStaticTokenProvider(token: string): TokenProvider {
  return async () => token;
}

export interface AppTokenDeps {
  appId: string;
  // Raw PEM, or its base64 encoding (docker-compose single-line friendly).
  privateKeyPem: string;
  installationId: string;
  allowedHosts: ReadonlySet<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  clock?: () => number;
}

const API_BASE = "https://api.github.com";
// GitHub requires exp at most 10 minutes out; 60s is subtracted from iat to
// absorb clock drift between us and GitHub.
const JWT_TTL_SECONDS = 600;
const CLOCK_SKEW_SECONDS = 60;
// Refetch when the cached token has under this much lifetime left. A stale
// token would fail mid-review, and reviews are batched, so refresh early.
const REFRESH_MARGIN_MS = 5 * 60_000;

const tokenResponseSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string(),
});

function decodePrivateKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("-----BEGIN")) {
    return value;
  }
  // Assume base64 of the PEM. Throws a clear error if that is not what we got.
  return Buffer.from(value, "base64").toString("utf8");
}

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Sign an RS256 JWT for the app (RFC 7519). GitHub verifies the signature
 * against the app's stored public key to authorize fetching an installation
 * token.
 */
function signJwt(appId: number, keyPem: string, now: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: appId,
      iat: Math.floor(now / 1000) - CLOCK_SKEW_SECONDS,
      exp: Math.floor(now / 1000) + JWT_TTL_SECONDS,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const privateKey = crypto.createPrivateKey(decodePrivateKey(keyPem));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

/**
 * A token provider backed by a GitHub App installation. Caches the installation
 * token until it nears expiry, single-flights concurrent requests so a burst of
 * reviews triggers one token fetch, and never caches a failure so a transient
 * 401/5xx is retried on the next call.
 */
export function createAppTokenProvider(deps: AppTokenDeps): TokenProvider {
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    const now = (deps.clock ?? Date.now)();
    const jwt = signJwt(Number(deps.appId), deps.privateKeyPem, now);
    const body = await safeFetch(`${API_BASE}/app/installations/${deps.installationId}/access_tokens`, {
      allowedHosts: deps.allowedHosts,
      maxBytes: 10_000,
      authToken: jwt,
      method: "POST",
      body: "{}",
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs,
    });
    const parsed = tokenResponseSchema.parse(JSON.parse(body));
    const expiresAt = Date.parse(parsed.expires_at);
    cached = { token: parsed.token, expiresAt };
    return parsed.token;
  }

  return async (): Promise<string> => {
    const now = (deps.clock ?? Date.now)();
    if (cached && cached.expiresAt - now > REFRESH_MARGIN_MS) {
      return cached.token;
    }
    if (!inflight) {
      // A rejected fetch clears the shared promise so the next caller retries.
      inflight = fetchToken().finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  };
}

/**
 * Choose the token source from config: GitHub App installation auth when the
 * app credentials are present (GitHub only), else a static platform token.
 * Config validation guarantees one of the two is configured.
 */
/** The subset of Config the token factory reads (keeps this module decoupled). */
export interface PlatformTokenConfig {
  PLATFORM: "github" | "bitbucket";
  PLATFORM_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_INSTALLATION_ID?: string;
  ALLOWED_HOSTS: Iterable<string>;
  PLATFORM_TIMEOUT_MS?: number;
}

export function createPlatformTokenProvider(
  config: PlatformTokenConfig,
  // Test seam: inject a mock fetch/clock so the app-token path is testable
  // without network. Prod callers omit it.
  overrides: { fetchImpl?: typeof fetch; clock?: () => number } = {},
): TokenProvider {
  if (config.PLATFORM === "github" && config.GITHUB_APP_ID && config.GITHUB_APP_PRIVATE_KEY && config.GITHUB_INSTALLATION_ID) {
    return createAppTokenProvider({
      appId: config.GITHUB_APP_ID,
      privateKeyPem: config.GITHUB_APP_PRIVATE_KEY,
      installationId: config.GITHUB_INSTALLATION_ID,
      allowedHosts: new Set(config.ALLOWED_HOSTS),
      fetchImpl: overrides.fetchImpl,
      clock: overrides.clock,
      timeoutMs: config.PLATFORM_TIMEOUT_MS,
    });
  }
  return createStaticTokenProvider(config.PLATFORM_TOKEN ?? "");
}
