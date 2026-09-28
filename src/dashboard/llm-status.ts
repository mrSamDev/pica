import type { LLMClient } from "../llm/client.ts";

// A failed probe must not hold the dashboard request open for the provider's
// full review timeout (60s) times the retry attempts. Manual checks are cheap.
const PROBE_TIMEOUT_MS = 15_000;
// Reuses the exact request path a review takes, so a green status means reviews
// can run. Known false negative: a reasoning model that returns empty content
// fails the content schema and reports "unreachable" — acceptable for v1.
const PROBE_PROMPT = "Reply with the single word: OK";

export interface LlmProbeMeta {
  provider: string;
  model: string;
}

export interface LlmStatus {
  provider: string;
  model: string;
  reachable: boolean;
  latencyMs: number | null;
  checkedAt: string;
  error: string | null;
}

export interface LlmStatusProbe {
  get(): LlmStatus | null;
  check(): Promise<LlmStatus>;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`LLM probe timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function probe(llm: LLMClient, meta: LlmProbeMeta): Promise<LlmStatus> {
  const startedAt = Date.now();
  try {
    const review = llm.review(PROBE_PROMPT);
    // The probe may time out before review settles; keep the abandoned
    // rejection handled so it cannot crash the process.
    review.catch(() => undefined);
    await withTimeout(review, PROBE_TIMEOUT_MS);
    return { provider: meta.provider, model: meta.model, reachable: true, latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString(), error: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { provider: meta.provider, model: meta.model, reachable: false, latencyMs: null, checkedAt: new Date().toISOString(), error: reason };
  }
}

// Last result lives in the closure so the 3s dashboard poll can read it
// without re-probing the provider on every tick.
export function createLlmStatusProbe(llm: LLMClient, meta: LlmProbeMeta): LlmStatusProbe {
  let latest: LlmStatus | null = null;
  let inFlight: Promise<LlmStatus> | null = null;
  return {
    get: () => latest,
    // Concurrent checks (multiple tabs) share one request instead of paying
    // for a model round-trip each.
    check: () => {
      if (inFlight) return inFlight;
      inFlight = probe(llm, meta)
        .then((status) => {
          latest = status;
          return status;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
