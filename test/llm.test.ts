import { describe, expect, it } from "vitest";

import { createOpenRouterLLM } from "../src/llm/openrouter.ts";

describe("openrouter llm", () => {
  it("aborts a hung request after the timeout", async () => {
    const llm = createOpenRouterLLM({
      apiKey: "key",
      model: "model",
      timeoutMs: 1,
      fetchImpl: async (_input, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("no abort signal passed");
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
        throw new Error("unreachable");
      },
    });
    await expect(llm.review("prompt")).rejects.toThrow();
  });
});
