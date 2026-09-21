import { describe, expect, it } from "vitest";

import { createOpenAILLM } from "../src/llm/openai.ts";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function captureFetch(responder: (call: CapturedCall) => Response) {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return Promise.resolve(responder(call));
  };
  return { fetchImpl, calls };
}

function okBody(): string {
  return JSON.stringify({ choices: [{ message: { content: "ok" } }] });
}

describe("openai-compatible llm", () => {
  it("posts to the default api.openai.com endpoint with bearer auth", async () => {
    const { fetchImpl, calls } = captureFetch(() => new Response(okBody(), { status: 200 }));
    const llm = createOpenAILLM({ apiKey: "key", model: "gpt-x", timeoutMs: 5000, fetchImpl });
    expect(await llm.review("prompt")).toBe("ok");
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer key");
    expect(String(calls[0]?.init.body)).toContain('"model":"gpt-x"');
  });

  it("honors a custom baseUrl", async () => {
    const { fetchImpl, calls } = captureFetch(() => new Response(okBody(), { status: 200 }));
    const llm = createOpenAILLM({ apiKey: "key", model: "m", timeoutMs: 5000, baseUrl: "http://llm.internal:8080/v1", fetchImpl });
    await llm.review("prompt");
    expect(calls[0]?.url).toBe("http://llm.internal:8080/v1/chat/completions");
  });

  it("retries a 429 and succeeds on the next attempt", async () => {
    let attempts = 0;
    const llm = createOpenAILLM({
      apiKey: "key",
      model: "m",
      timeoutMs: 5000,
      fetchImpl: async () => {
        attempts++;
        if (attempts === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
        return new Response(okBody(), { status: 200 });
      },
    });
    expect(await llm.review("prompt")).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("fails fast on a terminal 404 without retrying", async () => {
    let attempts = 0;
    const llm = createOpenAILLM({
      apiKey: "key",
      model: "m",
      timeoutMs: 5000,
      fetchImpl: async () => {
        attempts++;
        return new Response("model not found", { status: 404 });
      },
    });
    await expect(llm.review("prompt")).rejects.toThrow(/404/);
    expect(attempts).toBe(1);
  });

  it("throws when an ok body has no usable content", async () => {
    const llm = createOpenAILLM({
      apiKey: "key",
      model: "m",
      timeoutMs: 5000,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 }),
    });
    await expect(llm.review("prompt")).rejects.toThrow(/content/);
  });
});
