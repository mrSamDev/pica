import type { FastifyPluginAsync, FastifyTypeProviderDefault, RawServerDefault } from "fastify";
import type { Logger } from "pino";

import { basicAuthHook, type BasicAuthConfig } from "../observability/auth.ts";
import type { LLMClient } from "../llm/client.ts";
import { getDashboardApp, getDashboardHtml, getDashboardState, getErrorsHtml, getErrorsState, getRulesState, getWhyHtml, getWhyState } from "./controller.ts";
import { createLlmStatusProbe } from "./llm-status.ts";
import type { DashboardQueries } from "./projection.ts";
import { dashboardSchema, errorsSchema, llmStatusSchema, rulesSchema, whySchema } from "./schema.ts";

export interface DashboardDeps {
  queries: DashboardQueries;
  auth: BasicAuthConfig;
  llm: LLMClient;
  llmProvider: string;
  llmModel: string;
}

export const dashboardPlugin: FastifyPluginAsync<DashboardDeps, RawServerDefault, FastifyTypeProviderDefault, Logger> = async (app, deps) => {
  const llmStatus = createLlmStatusProbe(deps.llm, { provider: deps.llmProvider, model: deps.llmModel });

  app.addHook("onRequest", basicAuthHook(deps.auth));

  app.get("/dashboard", async (_request, reply) => {
    return reply.type("text/html").send(getDashboardHtml());
  });

  app.get("/dashboard/app.js", async (_request, reply) => {
    return reply.type("text/javascript").send(getDashboardApp());
  });

  app.get("/errors", async (_request, reply) => {
    return reply.type("text/html").send(getErrorsHtml());
  });

  // Same bundle as /dashboard/app.js; the client picks the root component from
  // location.pathname, so the two pages never drift apart.
  app.get("/errors/app.js", async (_request, reply) => {
    return reply.type("text/javascript").send(getDashboardApp());
  });

  app.get("/api/errors", { schema: errorsSchema }, async () => {
    return getErrorsState(deps.queries);
  });

  app.get("/api/dashboard", { schema: dashboardSchema }, async () => {
    return getDashboardState(deps.queries, () => llmStatus.get());
  });

  app.post("/api/llm-status", { schema: llmStatusSchema }, async () => {
    return llmStatus.check();
  });

  app.get("/api/rules", { schema: rulesSchema }, async () => {
    return getRulesState(deps.queries);
  });

  app.get("/why", async (_request, reply) => {
    return reply.type("text/html").send(getWhyHtml());
  });

  app.get("/api/why", { schema: whySchema }, async (request) => {
    // SAFETY: whySchema.querystring required findingId; Fastify validated it before this handler.
    const { findingId } = request.query as { findingId: string };
    return getWhyState(deps.queries, findingId);
  });
};
