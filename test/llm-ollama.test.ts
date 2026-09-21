import { describe, expect, it } from "vitest";

import { createOllamaLLM } from "../src/llm/ollama.ts";

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
  return JSON.stringify({ message: { role: "assistant", content: "ok" } });
}

describe("ollama llm", () => {
  it("posts to the native /api/chat without auth and parses the message", async () => {
    const { fetchImpl, calls } = captureFetch(() => new Response(okBody(), { status: 200 }));
    const llm = createOllamaLLM({ model: "qwen3:8b", timeoutMs: 5000, fetchImpl });
    expect(await llm.review("prompt")).toBe("ok");
    expect(calls[0]?.url).toBe("http://localhost:11434/api/chat");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBeNull();
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.stream).toBe(false);
    expect(body.model).toBe("qwen3:8b");
  });

  it("honors a custom baseUrl (remote ollama host)", async () => {
    const { fetchImpl, calls } = captureFetch(() => new Response(okBody(), { status: 200 }));
    const llm = createOllamaLLM({ model: "m", timeoutMs: 5000, baseUrl: "http://ollama.internal:11434", fetchImpl });
    await llm.review("prompt");
    expect(calls[0]?.url).toBe("http://ollama.internal:11434/api/chat");
  });

  it("retries a transient 500 and succeeds on the next attempt", async () => {
    let attempts = 0;
    const llm = createOllamaLLM({
      model: "m",
      timeoutMs: 5000,
      fetchImpl: async () => {
        attempts++;
        if (attempts === 1) return new Response("model load failed", { status: 500 });
        return new Response(okBody(), { status: 200 });
      },
    });
    expect(await llm.review("prompt")).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("fails fast on a terminal 404 (model not pulled)", async () => {
    let attempts = 0;
    const llm = createOllamaLLM({
      model: "missing-model",
      timeoutMs: 5000,
      fetchImpl: async () => {
        attempts++;
        return new Response('{"error":"model not found"}', { status: 404 });
      },
    });
    await expect(llm.review("prompt")).rejects.toThrow(/404/);
    expect(attempts).toBe(1);
  });

  it("throws when an ok body has no message content", async () => {
    const llm = createOllamaLLM({
      model: "m",
      timeoutMs: 5000,
      fetchImpl: async () => new Response(JSON.stringify({ message: {} }), { status: 200 }),
    });
    await expect(llm.review("prompt")).rejects.toThrow(/content/);
  });
});
