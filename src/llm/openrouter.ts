import { z } from "zod";

import type { LLMClient } from "./client.ts";
import { fetchWithRetry, requestError } from "./retry.ts";

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
      // Parses a fresh response body once into the choices data; null = non-ok,
      // unreadable, or schema-failing body (no usable content) — transient.
      const parseOnce = async (res: Response) => {
        if (!res.ok) return null;
        try {
          const parsed = openRouterResponseSchema.safeParse(await res.json());
          return parsed.success ? parsed.data : null;
        } catch {
          // Malformed JSON on an ok body (proxy error page, truncated stream)
          // is the same transient class as a schema failure.
          return null;
        }
      };

      const { response, parsed } = await fetchWithRetry(postOnce, parseOnce);

      if (!response.ok) throw await requestError(response);
      if (!parsed) throw new Error("LLM response missing content");
      return parsed.choices[0]?.message.content ?? "";
    },
  };
}
