import type { FastifyPluginAsync, FastifyTypeProviderDefault, RawServerDefault } from "fastify";
import type { Logger } from "pino";

import { basicAuthHook, type BasicAuthConfig } from "../observability/auth.ts";
import { getDashboardApp, getDashboardHtml, getDashboardState, getRulesState, getWhyHtml, getWhyState } from "./controller.ts";
import type { DashboardQueries } from "./projection.ts";
import { dashboardSchema, rulesSchema, whySchema } from "./schema.ts";

export interface DashboardDeps {
  queries: DashboardQueries;
  auth: BasicAuthConfig;
}

export const dashboardPlugin: FastifyPluginAsync<DashboardDeps, RawServerDefault, FastifyTypeProviderDefault, Logger> = async (app, deps) => {
  app.addHook("onRequest", basicAuthHook(deps.auth));

  app.get("/dashboard", async (_request, reply) => {
    return reply.type("text/html").send(getDashboardHtml());
  });

  app.get("/dashboard/app.js", async (_request, reply) => {
    return reply.type("text/javascript").send(getDashboardApp());
  });

  app.get("/api/dashboard", { schema: dashboardSchema }, async () => {
    return getDashboardState(deps.queries);
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
