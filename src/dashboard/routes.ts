import type { FastifyPluginAsync, FastifyTypeProviderDefault, RawServerDefault } from "fastify";
import type { Logger } from "pino";

import { getDashboardHtml, getDashboardState } from "./controller.ts";
import type { DashboardQueries } from "./projection.ts";
import { dashboardSchema } from "./schema.ts";

export interface DashboardDeps {
  queries: DashboardQueries;
}

export const dashboardPlugin: FastifyPluginAsync<DashboardDeps, RawServerDefault, FastifyTypeProviderDefault, Logger> = async (app, deps) => {
  app.get("/dashboard", async (_request, reply) => {
    return reply.type("text/html").send(getDashboardHtml());
  });

  app.get("/api/dashboard", { schema: dashboardSchema }, async () => {
    return getDashboardState(deps.queries);
  });
};
