import { createHmac } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/observability/logger.ts";
import type { OutcomeQueue } from "../src/queue/outcome.ts";
import type { ReviewQueue } from "../src/queue/enqueue.ts";
import { webhookPlugin } from "../src/webhooks/routes.ts";
import type { WebhookDeps, WebhookStore } from "../src/webhooks/types.ts";

const config = loadConfig({
  DATABASE_URL: "postgres://localhost:5432/pica",
  REDIS_URL: "redis://localhost:6379",
  WEBHOOK_SECRET: "test-webhook-secret",
  LLM_API_KEY: "test-llm-key",
  PLATFORM_TOKEN: "test-platform-token",
  LOG_LEVEL: "silent",
});
const logger = createLogger(config);

function sign(body: string): string {
  return `sha256=${createHmac("sha256", config.WEBHOOK_SECRET).update(body).digest("hex")}`;
}

function makeStore(): WebhookStore & { events: unknown[]; reviews: unknown[] } {
  const events: unknown[] = [];
  const reviews: unknown[] = [];
  const eventKeys = new Set<string>();
  return {
    events,
    reviews,
    async hasEvent(eventKey) {
      return eventKeys.has(eventKey);
    },
    async recordEvent(event) {
      events.push(event);
      eventKeys.add(event.eventKey);
    },
    async createReview(review) {
      reviews.push(review);
      return "review-1";
    },
  };
}

function makeQueue(failEnqueue = false): ReviewQueue & { enqueued: unknown[] } {
  const enqueued: unknown[] = [];
  return {
    enqueued,
    async enqueue(request) {
      if (failEnqueue) {
        throw new Error("queue down");
      }
      enqueued.push(request);
    },
  };
}

// posted_comments lookups return nothing: outcome events must not crash and
// must not enqueue. The handled:true path lives in test/outcome-queue.test.ts
// against a real database.
function makeOutcomeQueue(): OutcomeQueue & { enqueued: unknown[] } {
  const enqueued: unknown[] = [];
  return {
    enqueued,
    async enqueue(job) {
      enqueued.push(job);
    },
  };
}

function makeApp(store: WebhookStore, queue: ReviewQueue, findFinding: WebhookDeps["findFinding"] = async () => null) {
  const app = Fastify({ loggerInstance: logger });
  app.addContentTypeParser("application/json", { parseAs: "string" }, async (request: FastifyRequest, body: string) => {
    // SAFETY: parseAs: "string" guarantees body is a string
    const raw = body as string;
    request.rawBody = raw;
    return JSON.parse(raw);
  });
  const outcomeQueue = makeOutcomeQueue();
  // posted_comments lookups resolve empty unless the test injects a lookup that
  // throws or returns a finding; the handled:true path lives in outcome-queue.test.ts.
  app.register(webhookPlugin, { config, store, queue, findFinding, outcomeQueue });
  return { app, outcomeQueue };
}

async function post(app: ReturnType<typeof makeApp>["app"], body: string, eventName: string) {
  const res = await app.inject({
    method: "POST",
    url: "/webhooks/github",
    payload: body,
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(body), "x-github-event": eventName },
  });
  return res;
}

const pullRequestOpened = JSON.stringify({
  action: "opened",
  pull_request: { number: 42, head: { sha: "abc123" }, diff_url: "https://github.com/owner/repo/pull/42.diff" },
  repository: { full_name: "owner/repo" },
});

const reviewCommentCreated = JSON.stringify({
  action: "created",
  comment: { id: 997, body: "dismiss: false positive", in_reply_to_id: null, user: { login: "alice" } },
  pull_request: { number: 42 },
  repository: { full_name: "owner/repo" },
});

const threadResolved = JSON.stringify({
  action: "resolved",
  thread: {
    comments: [
      { id: 11, in_reply_to_id: null },
      { id: 12, in_reply_to_id: 11 },
    ],
  },
  pull_request: { number: 42 },
  repository: { full_name: "owner/repo" },
});

describe("GitHub native webhooks", () => {
  it("ping answers 200 so the webhook UI shows a green delivery", async () => {
    const { app, outcomeQueue } = makeApp(makeStore(), makeQueue());
    const res = await post(app, JSON.stringify({ zen: "Keep it logically awesome." }), "ping");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, pinged: true });
    expect(outcomeQueue.enqueued).toHaveLength(0);
    await app.close();
  });

  it("pull_request opened enqueues a review with the normalized payload", async () => {
    const store = makeStore();
    const queue = makeQueue();
    const { app } = makeApp(store, queue);
    const res = await post(app, pullRequestOpened, "pull_request");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]).toMatchObject({ repo: "owner/repo", prId: "42", commitSha: "abc123", diffHref: "https://github.com/owner/repo/pull/42.diff", platform: "github" });
    expect(store.reviews).toHaveLength(1);
    await app.close();
  });

  it("pull_request closed is ignored without touching store or queue", async () => {
    const store = makeStore();
    const queue = makeQueue();
    const { app } = makeApp(store, queue);
    const res = await post(app, JSON.stringify({ action: "closed", pull_request: { number: 42, head: { sha: "abc123" }, diff_url: "https://github.com/owner/repo/pull/42.diff" }, repository: { full_name: "owner/repo" } }), "pull_request");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, ignored: true });
    expect(store.events).toHaveLength(0);
    expect(queue.enqueued).toHaveLength(0);
    await app.close();
  });

  it("malformed pull_request body answers 400", async () => {
    const { app } = makeApp(makeStore(), makeQueue());
    const res = await post(app, JSON.stringify({ action: "opened", pull_request: { number: 42 }, repository: { full_name: "owner/repo" } }), "pull_request");
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("bad signature stays 401 even for GitHub deliveries", async () => {
    const { app } = makeApp(makeStore(), makeQueue());
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: pullRequestOpened,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign("wrong"), "x-github-event": "pull_request" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("push is ignored (no prId exists on a branch push)", async () => {
    const { app } = makeApp(makeStore(), makeQueue());
    const res = await post(app, JSON.stringify({ ref: "refs/heads/main", repository: { full_name: "owner/repo" } }), "push");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, ignored: true });
    await app.close();
  });

  it("review comment created records a comment_created outcome event", async () => {
    const store = makeStore();
    const queue = makeQueue();
    const { app } = makeApp(store, queue);
    const res = await post(app, reviewCommentCreated, "pull_request_review_comment");
    expect(res.statusCode).toBe(200);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ platform: "github", eventKey: "outcome:github:997:comment_created" });
    expect(queue.enqueued).toHaveLength(0);
    await app.close();
  });

  it("review comment edited is ignored", async () => {
    const store = makeStore();
    const { app } = makeApp(store, makeQueue());
    const res = await post(app, JSON.stringify({ action: "edited", comment: { id: 997, body: "dismiss: fp", in_reply_to_id: null, user: { login: "alice" } }, pull_request: { number: 42 }, repository: { full_name: "owner/repo" } }), "pull_request_review_comment");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, ignored: true });
    expect(store.events).toHaveLength(0);
    await app.close();
  });

  it("review comment deleted records a comment_deleted outcome event", async () => {
    const store = makeStore();
    const { app } = makeApp(store, makeQueue());
    const res = await post(app, JSON.stringify({ action: "deleted", comment: { id: 998, in_reply_to_id: null }, pull_request: { number: 42 }, repository: { full_name: "owner/repo" } }), "pull_request_review_comment");
    expect(res.statusCode).toBe(200);
    expect(store.events[0]).toMatchObject({ eventKey: "outcome:github:998:comment_deleted" });
    await app.close();
  });

  it("resolved thread fans out one outcome event per comment", async () => {
    const store = makeStore();
    const { app } = makeApp(store, makeQueue());
    const res = await post(app, threadResolved, "pull_request_review_thread");
    expect(res.statusCode).toBe(200);
    // SAFETY: makeStore records events with an eventKey field; the assertion
    // narrows the stored entry to read only that key.
    expect(store.events.map((event) => (event as { eventKey: string }).eventKey)).toEqual(["outcome:github:11:comment_resolved", "outcome:github:12:comment_resolved"]);
    await app.close();
  });

  it("unresolved thread is ignored (resolved is terminal, no inverse transition)", async () => {
    const store = makeStore();
    const { app } = makeApp(store, makeQueue());
    const res = await post(app, JSON.stringify({ action: "unresolved", thread: { comments: [{ id: 11, in_reply_to_id: null }] }, pull_request: { number: 42 }, repository: { full_name: "owner/repo" } }), "pull_request_review_thread");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, ignored: true });
    expect(store.events).toHaveLength(0);
    await app.close();
  });

  it("unknown event names are ignored, not 400", async () => {
    const { app } = makeApp(makeStore(), makeQueue());
    const res = await post(app, JSON.stringify({ action: "created", issue: { number: 7 } }), "issues");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, ignored: true });
    await app.close();
  });

  it("normalized payload without the GitHub event header still works (bridge senders)", async () => {
    const store = makeStore();
    const queue = makeQueue();
    const { app } = makeApp(store, queue);
    const payload = JSON.stringify({ repo: "owner/repo", prId: "42", commitSha: "abc123", diffHref: "https://api.github.com/repos/owner/repo/pulls/42" });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(payload) },
    });
    expect(res.statusCode).toBe(200);
    expect(queue.enqueued).toHaveLength(1);
    await app.close();
  });

  it("redelivered event is deduped, not queued twice", async () => {
    const store = makeStore();
    const queue = makeQueue();
    const { app } = makeApp(store, queue);
    await post(app, pullRequestOpened, "pull_request");
    const res = await post(app, pullRequestOpened, "pull_request");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, deduped: true });
    expect(queue.enqueued).toHaveLength(1);
    await app.close();
  });

  it("enqueue failure does not burn the dedup claim", async () => {
    const store = makeStore();
    const { app } = makeApp(store, makeQueue(true));
    const res = await post(app, pullRequestOpened, "pull_request");
    expect(res.statusCode).toBe(500);
    expect(store.events).toHaveLength(0);
    await app.close();
  });

  it("partial thread fanout: a failing comment is not claimed", async () => {
    const store = makeStore();
    const { app } = makeApp(store, makeQueue(), async (_platform, commentId) => {
      if (commentId === "12") throw new Error("db down");
      return null;
    });
    const res = await post(app, threadResolved, "pull_request_review_thread");
    expect(res.statusCode).toBe(500);
    // comment 11 applied+claimed; comment 12 threw before being claimed, so
    // redelivering the thread retries only comment 12.
    // SAFETY: WebhookEventRecord.eventKey is the only field read off each element.
    const keys = store.events.map((event) => (event as { eventKey: string }).eventKey);
    expect(keys).toEqual(["outcome:github:11:comment_resolved"]);
    await app.close();
  });

  it("github event header on a bitbucket route falls through to the normalized path", async () => {
    const store = makeStore();
    const { app } = makeApp(store, makeQueue());
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/bitbucket",
      payload: pullRequestOpened,
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(pullRequestOpened), "x-github-event": "pull_request" },
    });
    expect(res.statusCode).toBe(400);
    expect(store.events).toHaveLength(0);
    await app.close();
  });
});
