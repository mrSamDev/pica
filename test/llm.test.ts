import { describe, expect, it } from "vitest";

import { createOpenRouterLLM } from "../src/llm/openrouter.ts";

// Captures the outgoing request body as a string so the reasoning-flag shape
// is asserted without depending on a concrete payload type.
function llmWithBodyCapture(reasoning: boolean) {
  let body = "";
  const llm = createOpenRouterLLM({
    apiKey: "key",
    model: "model",
    timeoutMs: 5000,
    reasoning,
    fetchImpl: async (_input, init) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    },
  });
  return { llm, body: () => body };
}

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

  it("sends reasoning param only when enabled", async () => {
    const on = llmWithBodyCapture(true);
    await on.llm.review("prompt");
    expect(on.body()).toContain('"reasoning":{"enabled":true}');

    const off = llmWithBodyCapture(false);
    await off.llm.review("prompt");
    expect(off.body()).not.toContain("reasoning");
    expect(off.body()).toContain('"model":"model"');
  });

  it("throws on empty content instead of returning a blank review", async () => {
    const llm = createOpenRouterLLM({
      apiKey: "key",
      model: "model",
      timeoutMs: 5000,
      reasoning: true,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 }),
    });
    await expect(llm.review("prompt")).rejects.toThrow(/content/);
  });
});
