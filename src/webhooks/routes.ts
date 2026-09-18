import type { FastifyPluginAsync } from "fastify";

import { isWebhookPayload, parsePlatform } from "./controller.ts";
import { handleGitHubDelivery } from "./github.ts";
import { handleReviewRequest } from "./handlers.ts";
import { handleOutcomeEvent, outcomeEventSchema } from "./outcome.ts";
import { verifySignature } from "./signature.ts";
import type { WebhookDeps } from "./types.ts";

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isValidSignature(deps: WebhookDeps, request: { rawBody?: string } & { headers: Record<string, string | string[] | undefined> }): boolean {
  const rawBody = request.rawBody ?? "";
  const header = request.headers["x-hub-signature-256"] ?? request.headers["x-hub-signature"];
  const signature = Array.isArray(header) ? header[0] : header;
  return verifySignature(deps.config.WEBHOOK_SECRET, rawBody, signature);
}

export const webhookPlugin: FastifyPluginAsync<WebhookDeps> = async (app, deps) => {
  app.post<{ Params: { platform: string } }>("/webhooks/:platform", async (request, reply) => {
    if (!isValidSignature(deps, request)) {
      return reply.status(401).send({ error: "Invalid signature" });
    }

    const platform = parsePlatform(request.params.platform);
    const eventName = singleHeader(request.headers["x-github-event"]);
    // Native GitHub events are only valid on the github route; a bitbucket
    // delivery carrying x-github-event falls through to the normalized path.
    if (platform === "github" && eventName !== undefined) {
      return handleGitHubDelivery(deps, platform, eventName, request, reply);
    }

    // Normalized sender (bridge/CI) without GitHub's event header.
    if (!isWebhookPayload(request.body)) {
      return reply.status(400).send({ error: "Invalid webhook payload" });
    }
    return handleReviewRequest(deps, platform, request.body);
  });

  app.post<{ Params: { platform: string } }>("/webhooks/outcomes/:platform", async (request, reply) => {
    if (!isValidSignature(deps, request)) {
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
    // Apply before claiming the key: applyOutcome is idempotent, so a
    // redelivery after a failure re-runs safely instead of losing the event.
    const result = await handleOutcomeEvent({ findFinding: deps.findFinding, queue: deps.outcomeQueue }, event);
    await deps.store.recordEvent({ platform, eventKey, validated: true, processed: true });
    return { received: true, handled: result.handled };
  });
};
