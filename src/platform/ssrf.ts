export interface SafeFetchOptions {
  allowedHosts: ReadonlySet<string>;
  maxBytes: number;
  authToken?: string;
  fetchImpl?: typeof fetch;
  method?: string;
  body?: string;
}

const MAX_REDIRECTS = 3;

export function isHostAllowed(hostname: string, allowedHosts: ReadonlySet<string>): boolean {
  return allowedHosts.has(hostname.toLowerCase());
}

/**
 * Fetch a URL with SSRF protection: host allowlist checked on every hop,
 * redirects pinned (a trusted host 302ing to an arbitrary host is blocked),
 * auth token attached only to allowlisted hosts, and a byte budget enforced
 * before the body is fully buffered.
 */
export async function safeFetch(url: string, options: SafeFetchOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const hostname = new URL(currentUrl).hostname;
    if (!isHostAllowed(hostname, options.allowedHosts)) {
      throw new Error(`Host not allowed: ${hostname}`);
    }

    const headers: Record<string, string> = {};
    if (options.authToken) {
      headers["Authorization"] = `Bearer ${options.authToken}`;
    }
    if (options.body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetchImpl(currentUrl, {
      headers,
      redirect: "manual",
      method: options.method ?? "GET",
      body: options.body,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("Redirect without location");
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
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
}
