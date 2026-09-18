export interface SafeFetchOptions {
  allowedHosts: ReadonlySet<string>;
  maxBytes: number;
  authToken?: string;
  accept?: string;
  fetchImpl?: typeof fetch;
  method?: string;
  body?: string;
  // Abort a request that hangs, so a stuck platform endpoint cannot hold a
  // review/outcome worker forever (H3). Defaulted high; LLM calls set their
  // own explicit timeout separately.
  timeoutMs?: number;
}

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 60_000;

// An HTTP status response (4xx/5xx). Carries the status so callers can
// distinguish "not found" (404: a resource genuinely no longer exists) from a
// transient upstream failure (5xx) — e.g. the poller must treat only 404 as a
// deleted comment, never a 502 blip.
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message = `Request failed with status ${status}`) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function isHostAllowed(hostname: string, allowedHosts: ReadonlySet<string>): boolean {
  return allowedHosts.has(hostname.toLowerCase());
}

/**
 * Fetch a URL with SSRF protection: host allowlist checked on every hop,
 * redirects pinned (a trusted host 302ing to an arbitrary host is blocked),
 * auth token attached only to allowlisted hosts, a byte budget enforced before
 * the body is fully buffered, and a wall-clock timeout that aborts a hung call.
 */
export async function safeFetch(url: string, options: SafeFetchOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // The timeout is the caller's concern, not something that must keep the
  // process alive (e.g. during shutdown).
  timer.unref?.();
  let currentUrl = url;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const hostname = new URL(currentUrl).hostname;
      if (!isHostAllowed(hostname, options.allowedHosts)) {
        throw new Error(`Host not allowed: ${hostname}`);
      }

      const headers: Record<string, string> = {};
      if (options.authToken) {
        headers["Authorization"] = `Bearer ${options.authToken}`;
      }
      if (options.accept) {
        headers["Accept"] = options.accept;
      }
      if (options.body) {
        headers["Content-Type"] = "application/json";
      }

      const response = await fetchImpl(currentUrl, {
        headers,
        redirect: "manual",
        method: options.method ?? "GET",
        body: options.body,
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error("Redirect without location");
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      // 4xx/5xx statuses are errors, not bodies: an error JSON payload must never
      // be parsed as a successful response (a 404 diff read as "no diff", or a
      // 404 comment state read as "not deleted" so the dismissal path never
      // fires). HttpError carries the status so callers can tell a 404 (gone)
      // from a transient 5xx/network failure.
      if (response.status >= 400) {
        throw new HttpError(response.status);
      }

      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > options.maxBytes) {
        throw new Error("Response too large");
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > options.maxBytes) {
          await reader.cancel();
          throw new Error("Response too large");
        }
        chunks.push(value);
      }

      return Buffer.concat(chunks).toString("utf8");
    }

    throw new Error("Too many redirects");
  } catch (error) {
    // A timed-out abort surfaces as whatever the fetch impl threw; report a
    // stable, searchable error instead of an ad-hoc AbortError message. HTTP
    // status errors (HttpError) are real responses, never a timeout.
    if (controller.signal.aborted && !(error instanceof HttpError)) {
      throw new Error("Request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
