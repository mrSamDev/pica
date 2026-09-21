import { z } from "zod";

import type { LLMClient } from "./client.ts";
import { fetchWithRetry, requestError } from "./retry.ts";

// Anthropic Messages API (/v1/messages). max_tokens is mandatory there.
export interface AnthropicDeps {
  apiKey: string;
  model: string;
  timeoutMs: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
// Fits a full review JSON with headroom for haiku-class output limits.
const MAX_TOKENS = 4096;
const API_VERSION = "2023-06-01";

// Thinking models interleave {type:"thinking"} blocks before text; accept any
// block shape and pick the text ones, so the parse never fails on a valid body.
const anthropicResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).min(1),
});

function extractText(blocks: Array<{ type: string; text?: string }>): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

export function createAnthropicLLM(deps: AnthropicDeps): LLMClient {
  const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    async review(prompt) {
      const options: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": deps.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({ model: deps.model, max_tokens: MAX_TOKENS, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(deps.timeoutMs),
      };

      const postOnce = async (): Promise<Response> => fetchImpl(`${baseUrl}/messages`, options);
      // null = non-ok, unreadable, or a body with no text block — transient.
      const parseOnce = async (res: Response) => {
        if (!res.ok) return null;
        try {
          const parsed = anthropicResponseSchema.safeParse(await res.json());
          return parsed.success && extractText(parsed.data.content).length > 0 ? parsed.data : null;
        } catch {
          return null;
        }
      };

      const { response, parsed } = await fetchWithRetry(postOnce, parseOnce);

      if (!response.ok) throw await requestError(response);
      if (!parsed) throw new Error("LLM response missing content");
      return extractText(parsed.content);
    },
  };
}
