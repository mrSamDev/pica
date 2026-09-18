import type { FastifyPluginAsync } from "fastify";

import { landingHtml } from "./view.ts";

// Public marketing page — deliberately no auth, unlike dashboard/why.
export const landingPlugin: FastifyPluginAsync = async (app) => {
  app.get("/landing-page", async (_request, reply) => {
    return reply.type("text/html").send(landingHtml);
  });
};
