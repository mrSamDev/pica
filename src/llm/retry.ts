// Shared retry behavior for every LLM provider client: providers behind
// free tiers / proxies answer 429s and brief 5xx blips; retry those inline
// instead of failing the review to the DLQ. A terminal model error (404)
// must still fail fast.
// Terminal model errors (404, 401) must fail fast, not retry.
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 10_000;

function retryDelayMs(status: number, retryAfterHeader: string | null, attempt: number): number {
  // Retry-After (seconds) wins when present; cap it so a long value can't
  // hold a review worker hostage.
  const retryAfter = Number(retryAfterHeader ?? "0");
  if (retryAfter > 0) return Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS);
  return Math.min(1000 * attempt, MAX_RETRY_DELAY_MS);
}

export interface RetryResult<T> {
  response: Response;
  // null = the response is not usable: a non-ok status, an unreadable body, or
  // a schema failure (empty reasoning turn) — the transient class.
  parsed: T | null;
}

export async function fetchWithRetry<T>(post: () => Promise<Response>, parse: (response: Response) => Promise<T | null>): Promise<RetryResult<T>> {
  let response = await post();
  let parsed = await parse(response);
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
    const retryable = response.ok ? parsed === null : RETRYABLE_STATUSES.has(response.status);
    if (!retryable) break;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response.status, response.headers.get("retry-after"), attempt - 1)));
    response = await post();
    parsed = await parse(response);
  }
  return { response, parsed };
}

export async function requestError(response: Response): Promise<Error> {
  const detail = await response.text().catch(() => "");
  return new Error(`LLM request failed: ${response.status}: ${detail.slice(0, 200)}`);
}
