import { z } from "zod";

import type { LLMClient } from "./client.ts";

export interface OpenRouterDeps {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseUrl?: string;
  // Ask the provider for chain-of-thought; ignored by models without it. Only
  // sent when enabled so a non-reasoning/free model never gets an unknown param.
  reasoning?: boolean;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

// Free-tier models get upstream rate limits (429) and brief provider blips
// (5xx). Retry those inline instead of failing the review to the DLQ — a
// terminal model error (404) must still fail fast.
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 10_000;

function retryDelayMs(status: number, retryAfterHeader: string | null, attempt: number): number {
  // OpenRouter sends Retry-After (seconds) on 429s; cap it so a long value
  // can't hold a worker hostage.
  const retryAfter = Number(retryAfterHeader ?? "0");
  if (retryAfter > 0) return Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS);
  return Math.min(1000 * attempt, MAX_RETRY_DELAY_MS);
}

// The review output we consume lives in content regardless of reasoning.
const openRouterMessageSchema = z.object({
  content: z.string(),
  reasoning_details: z.array(z.unknown()).optional(),
});

const openRouterResponseSchema = z.object({
  choices: z.array(z.object({ message: openRouterMessageSchema })).min(1),
});

interface ChatBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  reasoning?: { enabled: boolean };
}

export function createOpenRouterLLM(deps: OpenRouterDeps): LLMClient {
  const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    async review(prompt) {
      const body: ChatBody = { model: deps.model, messages: [{ role: "user", content: prompt }] };
      if (deps.reasoning) {
        body.reasoning = { enabled: true };
      }
      const options: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify(body),
        // A hung provider must not hold a review worker forever.
        signal: AbortSignal.timeout(deps.timeoutMs),
      };

      const postOnce = async (): Promise<Response> => fetchImpl(`${baseUrl}/chat/completions`, options);
      // Parses a fresh response body once. null = non-ok response; a
      // safeParse failure on an ok body means the model returned no usable
      // content (free-tier content filter, empty reasoning turn) — transient.
      const parseOnce = async (res: Response) => {
        if (!res.ok) return null;
        return openRouterResponseSchema.safeParse(await res.json());
      };

      let response = await postOnce();
      let parsed = await parseOnce(response);
      for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
        const retryable = response.ok ? !parsed?.success : RETRYABLE_STATUSES.has(response.status);
        if (!retryable) break;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response.status, response.headers.get("retry-after"), attempt - 1)));
        response = await postOnce();
        parsed = await parseOnce(response);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`LLM request failed: ${response.status}: ${detail.slice(0, 200)}`);
      }

      if (!parsed || !parsed.success) {
        throw new Error("LLM response missing content");
      }
      return parsed.data.choices[0]?.message.content ?? "";
    },
  };
}
