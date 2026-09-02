import Fastify, { type FastifyInstance, type RawServerDefault } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "pino";

import type { Config } from "./config.ts";
import { registerDashboard } from "./dashboard/routes.ts";

type ErrorWithStatus = Error & { statusCode?: number };

type AppInstance = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>;

export function buildApp(config: Readonly<Config>, logger: Logger): AppInstance {
  const app = Fastify({ loggerInstance: logger });

  // Capture the raw body before JSON parsing so webhook HMAC validation can
  // sign the exact bytes that arrived, not a re-serialized object.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    // SAFETY: parseAs: "string" guarantees body is a string, not a Buffer
    const raw = body as string;
    request.rawBody = raw;
    try {
      done(null, JSON.parse(raw));
    } catch (error) {
      // SAFETY: JSON.parse throws a SyntaxError, which is an Error
      done(error as Error, undefined);
    }
  });

  app.get("/health", async () => {
    return { status: "ok", uptime: process.uptime() };
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "request failed");
    // SAFETY: Fastify always passes a FastifyError (extends Error, optional statusCode) here
    const fastifyError = error as ErrorWithStatus;
    const statusCode = fastifyError.statusCode ?? 500;
    reply.status(statusCode).send({
      error: {
        statusCode,
        message: fastifyError.message,
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

  registerDashboard(app);

  return app;
}
