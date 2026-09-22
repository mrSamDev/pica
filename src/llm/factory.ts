import type { LLMClient } from "./client.ts";
import { createAnthropicLLM } from "./anthropic.ts";
import { createOllamaLLM } from "./ollama.ts";
import { createOpenAILLM } from "./openai.ts";
import { createOpenRouterLLM } from "./openrouter.ts";

export type LLMProvider = "openrouter" | "ollama" | "openai" | "anthropic";

export interface LLMFactoryDeps {
  provider: LLMProvider;
  // Config validation enforces this for non-ollama providers; the guard below
  // also covers direct factory use.
  apiKey?: string;
  model: string;
  timeoutMs: number;
  baseUrl?: string;
  // OpenRouter-only param; other providers ignore it.
  reasoning?: boolean;
  fetchImpl?: typeof fetch;
}

export function createLLMClient(deps: LLMFactoryDeps): LLMClient {
  if (deps.provider !== "ollama" && !deps.apiKey) {
    throw new Error(`LLM_API_KEY is required for provider "${deps.provider}" (only ollama runs keyless)`);
  }
  // SAFETY: the guard above proved the key exists for every non-ollama provider.
  const apiKey = deps.apiKey as string;

  if (deps.provider === "openrouter") {
    return createOpenRouterLLM({ apiKey, model: deps.model, timeoutMs: deps.timeoutMs, baseUrl: deps.baseUrl, reasoning: deps.reasoning, fetchImpl: deps.fetchImpl });
  }
  if (deps.provider === "openai") {
    return createOpenAILLM({ apiKey, model: deps.model, timeoutMs: deps.timeoutMs, baseUrl: deps.baseUrl, fetchImpl: deps.fetchImpl });
  }
  if (deps.provider === "anthropic") {
    return createAnthropicLLM({ apiKey, model: deps.model, timeoutMs: deps.timeoutMs, baseUrl: deps.baseUrl, fetchImpl: deps.fetchImpl });
  }
  return createOllamaLLM({ model: deps.model, timeoutMs: deps.timeoutMs, baseUrl: deps.baseUrl, fetchImpl: deps.fetchImpl });
}
