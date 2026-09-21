import type { LLMClient } from "./client.ts";
import { createAnthropicLLM } from "./anthropic.ts";
import { createOllamaLLM } from "./ollama.ts";
import { createOpenAILLM } from "./openai.ts";
import { createOpenRouterLLM } from "./openrouter.ts";

export type LLMProvider = "openrouter" | "ollama" | "openai" | "anthropic";

export interface LLMFactoryDeps {
  provider: LLMProvider;
  // Required for openrouter/openai/anthropic; unused for ollama (config
  // validation enforces the non-ollama requirement).
  apiKey?: string;
  model: string;
  timeoutMs: number;
  baseUrl?: string;
  reasoning?: boolean;
  fetchImpl?: typeof fetch;
}

export function createLLMClient(deps: LLMFactoryDeps): LLMClient {
  switch (deps.provider) {
    case "openrouter":
      return createOpenRouterLLM({ apiKey: deps.apiKey ?? "", model: deps.model, timeoutMs: deps.timeoutMs, baseUrl: deps.baseUrl, reasoning: deps.reasoning, fetchImpl: deps.fetchImpl });
    case "openai":
      return createOpenAILLM({ apiKey: deps.apiKey ?? "", model: deps.model, timeoutMs: deps.timeoutMs, baseUrl: deps.baseUrl, fetchImpl: deps.fetchImpl });
    case "ollama":
      return createOllamaLLM({ model: deps.model, timeoutMs: deps.timeoutMs, baseUrl: deps.baseUrl, fetchImpl: deps.fetchImpl });
    case "anthropic":
      return createAnthropicLLM({ apiKey: deps.apiKey ?? "", model: deps.model, timeoutMs: deps.timeoutMs, baseUrl: deps.baseUrl, fetchImpl: deps.fetchImpl });
  }
}
