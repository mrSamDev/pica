import { describe, expect, it } from "vitest";

import { createLLMClient } from "../src/llm/factory.ts";

// Routes by provider shape, not implementation detail: each provider's
// request reaches a distinguishable URL + header set.
function respond(url: string): Response {
  if (url.includes("/api/chat")) {
    return new Response(JSON.stringify({ message: { role: "assistant", content: `url:${url}` } }), { status: 200 });
  }
  if (url.endsWith("/v1/messages")) {
    return new Response(JSON.stringify({ content: [{ type: "text", text: `url:${url}` }] }), { status: 200 });
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: `url:${url}` } }] }), { status: 200 });
}

function client(provider: "openrouter" | "ollama" | "openai" | "anthropic", baseUrl?: string) {
  return createLLMClient({
    provider,
    apiKey: "key",
    model: "m",
    timeoutMs: 5000,
    baseUrl,
    reasoning: true,
    fetchImpl: (input) => Promise.resolve(respond(String(input))),
  });
}

describe("llm factory", () => {
  it("routes each provider to its endpoint shape", async () => {
    expect(await client("openrouter").review("p")).toMatch(/openrouter\.ai/);
    expect(await client("openai").review("p")).toMatch(/api\.openai\.com/);
    expect(await client("ollama").review("p")).toMatch(/\/api\/chat/);
    expect(await client("anthropic").review("p")).toMatch(/\/v1\/messages/);
  });

  it("passes a custom baseUrl through to every provider", async () => {
    expect(await client("openrouter", "http://or.internal/v1").review("p")).toMatch(/or\.internal/);
    expect(await client("openai", "http://oi.internal/v1").review("p")).toMatch(/oi\.internal/);
    expect(await client("ollama", "http://ol.internal:11434").review("p")).toMatch(/ol\.internal/);
    expect(await client("anthropic", "http://an.internal/v1").review("p")).toMatch(/an\.internal/);
  });

  it("openrouter sends the reasoning flag, others never do", async () => {
    const bodies: string[] = [];
    const capture = (provider: "openrouter" | "openai") =>
      createLLMClient({
        provider,
        apiKey: "key",
        model: "m",
        timeoutMs: 5000,
        reasoning: true,
        fetchImpl: (_input, init) => {
          bodies.push(String(init?.body ?? ""));
          return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }));
        },
      });

    await capture("openrouter").review("p");
    await capture("openai").review("p");
    expect(bodies[0]).toContain('"reasoning":{"enabled":true}');
    expect(bodies[1]).not.toContain("reasoning");
  });

  it("fails fast without a key for keyed providers and runs ollama keyless", () => {
    for (const provider of ["openrouter", "openai", "anthropic"] as const) {
      expect(() => createLLMClient({ provider, model: "m", timeoutMs: 5000 })).toThrow(/LLM_API_KEY/);
    }
    expect(() => createLLMClient({ provider: "ollama", model: "m", timeoutMs: 5000 })).not.toThrow();
  });
});
