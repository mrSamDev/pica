import { z } from "zod";

import type { LLMClient } from "./client.ts";
import { fetchWithRetry, requestError } from "./retry.ts";

// Ollama's native /api/chat (no OpenAI shim): no auth, single message response.
export interface OllamaDeps {
  model: string;
  timeoutMs: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "http://localhost:11434";

const ollamaResponseSchema = z.object({
  message: z.object({ content: z.string() }),
});

export function createOllamaLLM(deps: OllamaDeps): LLMClient {
  const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    async review(prompt) {
      const options: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: deps.model, stream: false, messages: [{ role: "user", content: prompt }] }),
        // A hung model must not hold a review worker forever.
        signal: AbortSignal.timeout(deps.timeoutMs),
      };

      const postOnce = async (): Promise<Response> => fetchImpl(`${baseUrl}/api/chat`, options);
      // null = non-ok, unreadable, or schema-failing body — transient.
      const parseOnce = async (res: Response) => {
        if (!res.ok) return null;
        try {
          const parsed = ollamaResponseSchema.safeParse(await res.json());
          return parsed.success ? parsed.data : null;
        } catch {
          return null;
        }
      };

      const { response, parsed } = await fetchWithRetry(postOnce, parseOnce);

      if (!response.ok) throw await requestError(response);
      if (!parsed) throw new Error("LLM response missing content");
      return parsed.message.content;
    },
  };
}
