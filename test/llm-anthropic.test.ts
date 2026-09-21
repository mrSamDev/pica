import { describe, expect, it } from "vitest";

import { createAnthropicLLM } from "../src/llm/anthropic.ts";

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

function okBody(text = "ok"): string {
  return JSON.stringify({ content: [{ type: "text", text }] });
}

describe("anthropic llm", () => {
  it("posts to /v1/messages with anthropic headers and max_tokens", async () => {
    const { fetchImpl, calls } = captureFetch(() => new Response(okBody(), { status: 200 }));
    const llm = createAnthropicLLM({ apiKey: "key", model: "claude-x", timeoutMs: 5000, fetchImpl });
    expect(await llm.review("prompt")).toBe("ok");
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("x-api-key")).toBe("key");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.model).toBe("claude-x");
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages).toEqual([{ role: "user", content: "prompt" }]);
  });

  it("honors a custom baseUrl", async () => {
    const { fetchImpl, calls } = captureFetch(() => new Response(okBody(), { status: 200 }));
    const llm = createAnthropicLLM({ apiKey: "key", model: "m", timeoutMs: 5000, baseUrl: "http://proxy.internal/v1", fetchImpl });
    await llm.review("prompt");
    expect(calls[0]?.url).toBe("http://proxy.internal/v1/messages");
  });

  it("joins multiple text blocks and skips thinking blocks", async () => {
    const body = JSON.stringify({
      content: [
        { type: "thinking", thinking: "pondering" },
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    });
    const llm = createAnthropicLLM({ apiKey: "key", model: "m", timeoutMs: 5000, fetchImpl: async () => new Response(body, { status: 200 }) });
    expect(await llm.review("prompt")).toBe("line one\nline two");
  });

  it("retries a 429 and succeeds on the next attempt", async () => {
    let attempts = 0;
    const llm = createAnthropicLLM({
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

  it("fails fast on a terminal 401 without retrying", async () => {
    let attempts = 0;
    const llm = createAnthropicLLM({
      apiKey: "key",
      model: "m",
      timeoutMs: 5000,
      fetchImpl: async () => {
        attempts++;
        return new Response("invalid api key", { status: 401 });
      },
    });
    await expect(llm.review("prompt")).rejects.toThrow(/401/);
    expect(attempts).toBe(1);
  });

  it("throws when an ok body has no text block", async () => {
    const llm = createAnthropicLLM({
      apiKey: "key",
      model: "m",
      timeoutMs: 5000,
      fetchImpl: async () => new Response(JSON.stringify({ content: [{ type: "thinking", thinking: "pondering" }] }), { status: 200 }),
    });
    await expect(llm.review("prompt")).rejects.toThrow(/content/);
  });
});
