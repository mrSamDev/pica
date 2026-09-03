import type { FastifyPluginAsync, FastifyTypeProviderDefault, RawServerDefault } from "fastify";
import type { Logger } from "pino";

import { basicAuthHook, type BasicAuthConfig } from "../observability/auth.ts";
import { getDashboardHtml, getDashboardState } from "./controller.ts";
import type { DashboardQueries } from "./projection.ts";
import { dashboardSchema } from "./schema.ts";

export interface DashboardDeps {
  queries: DashboardQueries;
  auth: BasicAuthConfig;
}

export const dashboardPlugin: FastifyPluginAsync<DashboardDeps, RawServerDefault, FastifyTypeProviderDefault, Logger> = async (app, deps) => {
  app.addHook("onRequest", basicAuthHook(deps.auth));

  app.get("/dashboard", async (_request, reply) => {
    return reply.type("text/html").send(getDashboardHtml());
  });

  app.get("/api/dashboard", { schema: dashboardSchema }, async () => {
    return getDashboardState(deps.queries);
  });
};
