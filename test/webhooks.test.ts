import { createHmac } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";
import type { Db } from "../src/db/client.ts";
import { createLogger } from "../src/observability/logger.ts";
import type { OutcomeQueue } from "../src/queue/outcome.ts";
import type { ReviewQueue } from "../src/queue/enqueue.ts";
import { verifySignature } from "../src/webhooks/signature.ts";
import { webhookPlugin } from "../src/webhooks/routes.ts";
import type { WebhookStore } from "../src/webhooks/types.ts";

const config = loadConfig({
  DATABASE_URL: "postgres://localhost:5432/pica",
  REDIS_URL: "redis://localhost:6379",
  WEBHOOK_SECRET: "test-webhook-secret",
  LLM_API_KEY: "test-llm-key",
  PLATFORM_TOKEN: "test-platform-token",
  LOG_LEVEL: "silent",
});
const logger = createLogger(config);

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function makeStore(): WebhookStore & { events: unknown[]; reviews: unknown[] } {
  const events: unknown[] = [];
  const reviews: unknown[] = [];
  return {
    events,
    reviews,
    async hasEvent() {
      return false;
    },
    async recordEvent(event) {
      events.push(event);
    },
    async createReview(review) {
      reviews.push(review);
      return "review-1";
    },
  };
}

function makeQueue(): ReviewQueue & { enqueued: unknown[] } {
  const enqueued: unknown[] = [];
  return {
    enqueued,
    async enqueue(request) {
      enqueued.push(request);
    },
  };
}

function makeApp(store: WebhookStore, queue: ReviewQueue) {
  const app = Fastify({ loggerInstance: logger });
  app.addContentTypeParser("application/json", { parseAs: "string" }, async (request: FastifyRequest, body: string) => {
    // SAFETY: parseAs: "string" guarantees body is a string
    const raw = body as string;
    request.rawBody = raw;
    return JSON.parse(raw);
  });
  // SAFETY: the outcome route is not exercised in these HMAC tests; a stub db
  // and queue satisfy the plugin deps without touching a real database.
  const db = {} as Db;
  const outcomeQueue: OutcomeQueue = { enqueue: async () => {} };
  app.register(webhookPlugin, { config, store, queue, db, outcomeQueue });
  return app;
}

const payload = JSON.stringify({
  repo: "owner/repo",
  prId: "42",
  commitSha: "abc123",
  diffHref: "https://api.github.com/repos/owner/repo/pulls/42",
});

describe("webhook HMAC", () => {
  it("valid signature accepted", async () => {
    expect(verifySignature(config.WEBHOOK_SECRET, payload, sign(config.WEBHOOK_SECRET, payload))).toBe(true);

    const store = makeStore();
    const queue = makeQueue();
    const app = makeApp(store, queue);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(config.WEBHOOK_SECRET, payload) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(queue.enqueued).toHaveLength(1);
    expect(store.events).toHaveLength(1);
    expect(store.reviews).toHaveLength(1);
    await app.close();
  });

  it("invalid signature rejected with 401", async () => {
    const store = makeStore();
    const queue = makeQueue();
    const app = makeApp(store, queue);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign("wrong-secret", payload) },
    });
    expect(res.statusCode).toBe(401);
    expect(queue.enqueued).toHaveLength(0);
    await app.close();
  });

  it("timing-safe: length mismatch returns false without throwing", () => {
    // A signature of a different length must not throw (timingSafeEqual would
    // throw on unequal-length buffers) and must be rejected.
    const short = "sha256=abcd";
    expect(verifySignature(config.WEBHOOK_SECRET, payload, short)).toBe(false);
    expect(verifySignature(config.WEBHOOK_SECRET, payload, undefined)).toBe(false);
    expect(verifySignature(config.WEBHOOK_SECRET, payload, "not-a-signature")).toBe(false);
  });

  it("raw body captured before JSON parse", async () => {
    // The signature is computed over the exact raw bytes. If the route
    // re-serialized the parsed body, the signature would not match.
    const store = makeStore();
    const queue = makeQueue();
    const app = makeApp(store, queue);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(config.WEBHOOK_SECRET, payload) },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
