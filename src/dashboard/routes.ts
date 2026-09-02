import type { FastifyPluginAsync, FastifyTypeProviderDefault, RawServerDefault } from "fastify";
import type { Logger } from "pino";

import { getDashboardHtml, getDashboardState } from "./controller.ts";
import { dashboardSchema } from "./schema.ts";

export const dashboardPlugin: FastifyPluginAsync<Record<never, never>, RawServerDefault, FastifyTypeProviderDefault, Logger> = async (app) => {
  app.get("/dashboard", async (_request, reply) => {
    return reply.type("text/html").send(getDashboardHtml());
  });

  app.get("/api/dashboard", { schema: dashboardSchema }, async () => {
    return getDashboardState();
  });
};
