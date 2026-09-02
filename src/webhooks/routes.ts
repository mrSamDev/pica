import type { FastifyPluginAsync } from "fastify";

import { getRepoConfig, type Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { OutcomeQueue } from "../queue/outcome.ts";
import type { ReviewQueue } from "../queue/enqueue.ts";
import { isWebhookPayload, parsePlatform, toReviewRequest } from "./controller.ts";
import { handleOutcomeEvent, outcomeEventSchema } from "./outcome.ts";
import { verifySignature } from "./signature.ts";
import type { WebhookStore } from "./types.ts";

export interface WebhookDeps {
  config: Readonly<Config>;
  store: WebhookStore;
  queue: ReviewQueue;
  db: Db;
  outcomeQueue: OutcomeQueue;
}

export const webhookPlugin: FastifyPluginAsync<WebhookDeps> = async (app, deps) => {
  app.post<{ Params: { platform: string } }>("/webhooks/:platform", async (request, reply) => {
    const rawBody = request.rawBody ?? "";
    const header = request.headers["x-hub-signature-256"] ?? request.headers["x-hub-signature"];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!verifySignature(deps.config.WEBHOOK_SECRET, rawBody, signature)) {
      return reply.status(401).send({ error: "Invalid signature" });
    }

    const platform = parsePlatform(request.params.platform);
    const body = request.body;
    if (!isWebhookPayload(body)) {
      return reply.status(400).send({ error: "Invalid webhook payload" });
    }
    const repoConfig = getRepoConfig(deps.config, body.repo);
    const payload = toReviewRequest(body, platform, repoConfig);
    const eventKey = `webhook:${payload.prId}:${payload.commitSha}`;

    // Idempotency: a redelivered webhook must not create a second review.
    if (await deps.store.hasEvent(eventKey)) {
      return { received: true, deduped: true };
    }

    await deps.store.recordEvent({
      platform,
      eventKey,
      validated: true,
      processed: true,
    });
    const reviewId = await deps.store.createReview({
      repo: payload.repo,
      prId: payload.prId,
      commitSha: payload.commitSha,
      status: "queued",
      mode: repoConfig.mode,
    });
    await deps.queue.enqueue({ ...payload, reviewId });

    return { received: true };
  });

  app.post<{ Params: { platform: string } }>("/webhooks/outcomes/:platform", async (request, reply) => {
    const rawBody = request.rawBody ?? "";
    const header = request.headers["x-hub-signature-256"] ?? request.headers["x-hub-signature"];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!verifySignature(deps.config.WEBHOOK_SECRET, rawBody, signature)) {
      return reply.status(401).send({ error: "Invalid signature" });
    }

    const platform = parsePlatform(request.params.platform);
    const parsed = outcomeEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid outcome event" });
    }
    const event = { ...parsed.data, platform };
    const eventKey = `outcome:${platform}:${event.commentId}:${event.eventType}`;

    // Idempotency: a redelivered outcome event must not double-apply.
    if (await deps.store.hasEvent(eventKey)) {
      return { received: true, deduped: true };
    }
    await deps.store.recordEvent({ platform, eventKey, validated: true, processed: true });

    const result = await handleOutcomeEvent({ db: deps.db, queue: deps.outcomeQueue }, event);
    return { received: true, handled: result.handled };
  });
};
