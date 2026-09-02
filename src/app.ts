import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest, type RawServerDefault } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "pino";

import type { Config } from "./config.ts";
import { dashboardPlugin } from "./dashboard/routes.ts";

type AppInstance = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>;

export function buildApp(config: Readonly<Config>, logger: Logger): AppInstance {
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

  app.register(dashboardPlugin);

  return app;
}
