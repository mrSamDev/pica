import { z } from "zod";

import type { LLMClient } from "./client.ts";

export interface OpenRouterDeps {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

const openRouterResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

export function createOpenRouterLLM(deps: OpenRouterDeps): LLMClient {
  const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    async review(prompt) {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify({
          model: deps.model,
          messages: [{ role: "user", content: prompt }],
        }),
        // A hung provider must not hold a review worker forever.
        signal: AbortSignal.timeout(deps.timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`LLM request failed: ${response.status}`);
      }

      const parsed = openRouterResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("LLM response missing content");
      }
      return parsed.data.choices[0]?.message.content ?? "";
    },
  };
}
