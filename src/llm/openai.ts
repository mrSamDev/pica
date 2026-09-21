import { z } from "zod";

import type { LLMClient } from "./client.ts";
import { fetchWithRetry, requestError } from "./retry.ts";

// Generic OpenAI-compatible chat client: api.openai.com and any self-hosted
// or third-party endpoint that mirrors the /chat/completions shape.
export interface OpenAIDeps {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const openAIResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
});

export function createOpenAILLM(deps: OpenAIDeps): LLMClient {
  const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    async review(prompt) {
      const options: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify({ model: deps.model, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(deps.timeoutMs),
      };

      const postOnce = async (): Promise<Response> => fetchImpl(`${baseUrl}/chat/completions`, options);
      // null = non-ok, unreadable, or schema-failing body (no usable content) — transient.
      const parseOnce = async (res: Response) => {
        if (!res.ok) return null;
        try {
          const parsed = openAIResponseSchema.safeParse(await res.json());
          return parsed.success ? parsed.data : null;
        } catch {
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
