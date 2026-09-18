import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest, type RawServerDefault } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "pino";
import type { Queue } from "bullmq";

import type { Config } from "./config.ts";
import { dashboardPlugin } from "./dashboard/routes.ts";
import type { DashboardQueries } from "./dashboard/projection.ts";
import type { Db } from "./db/client.ts";
import type { LLMClient } from "./llm/client.ts";
import type { Metrics } from "./observability/metrics.ts";
import { metricsPlugin } from "./observability/routes.ts";
import type { BasicAuthConfig } from "./observability/auth.ts";
import type { PlatformClient } from "./platform/types.ts";
import { createOutcomeQueue } from "./queue/outcome.ts";
import { createReviewQueue } from "./queue/enqueue.ts";
import { webhookPlugin } from "./webhooks/routes.ts";
import { findFindingByCommentId } from "./webhooks/outcome.ts";
import { createWebhookStore } from "./webhooks/store.ts";

type AppInstance = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>;

export interface AppDeps {
  db: Db;
  queue: Queue;
  // Separate queue for outcome mutations; the review worker must never see
  // outcome payloads, and the outcome worker must never see review payloads.
  outcomeQueue: Queue;
  platform: PlatformClient;
  llm: LLMClient;
  dashboardQueries: DashboardQueries;
  metrics: Metrics;
  // learning_lag from the event log (null before any rule activates) and the
  // rolling-30d dismissal rate (null before decisive outcomes) — same getters
  // observability/routes.ts registers on /metrics.
  getLearningLag: () => Promise<number | null>;
  getDismissalRate: () => Promise<number | null>;
  // Basic auth for the operational endpoints; empty in dev disables it.
  auth: BasicAuthConfig;
}

export function buildApp(config: Readonly<Config>, logger: Logger, deps: AppDeps): AppInstance {
  const app = Fastify({
    loggerInstance: logger,
    // Behind Dokploy's reverse proxy; trust it so request.ip is the real client.
    trustProxy: true,
  });

  // Capture the raw body before JSON parsing so webhook HMAC validation can
  // sign the exact bytes that arrived, not a re-serialized object.
  app.addContentTypeParser("application/json", { parseAs: "string" }, async (request: FastifyRequest, body: string) => {
    // SAFETY: parseAs: "string" guarantees body is a string, not a Buffer
    const raw = body as string;
    request.rawBody = raw;
    try {
      return JSON.parse(raw);
    } catch {
      throw { statusCode: 400, code: "INVALID_JSON", message: "Invalid JSON payload" };
    }
  });

  app.get(
    "/health",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              uptime: { type: "number" },
            },
            required: ["status"],
          },
        },
      },
    },
    async () => {
      return { status: "ok", uptime: process.uptime() };
    },
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "request failed");

    // Route schema validation failures
    if (error.validation) {
      return reply.status(400).send({
        error: {
          statusCode: 400,
          message: "Validation failed",
          details: error.validation,
        },
      });
    }

    const statusCode = error.statusCode ?? 500;

    // Don't leak internal error details in production
    const message = statusCode >= 500 && config.NODE_ENV === "production" ? "Internal Server Error" : error.message;

    reply.status(statusCode).send({
      error: {
        statusCode,
        message,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        statusCode: 404,
        message: `Route ${request.method}:${request.url} not found`,
      },
    });
  });

  app.register(dashboardPlugin, { queries: deps.dashboardQueries, auth: deps.auth });
  app.register(metricsPlugin, { metrics: deps.metrics, getLearningLag: deps.getLearningLag, getDismissalRate: deps.getDismissalRate, auth: deps.auth });
  app.register(webhookPlugin, {
    config,
    store: createWebhookStore(deps.db),
    queue: createReviewQueue(deps.queue),
    findFinding: (platform, commentId) => findFindingByCommentId(deps.db, platform, commentId),
    outcomeQueue: createOutcomeQueue(deps.outcomeQueue),
  });

  return app;
}
