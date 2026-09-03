import type { FastifyPluginAsync } from "fastify";

import type { Metrics } from "./metrics.ts";

export interface MetricsDeps {
  metrics: Metrics;
}

export const metricsPlugin: FastifyPluginAsync<MetricsDeps> = async (app, deps) => {
  app.get("/metrics", async (_request, reply) => {
    reply.type("text/plain");
    return deps.metrics.registry.metrics();
  });
};
