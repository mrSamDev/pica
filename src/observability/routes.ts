import type { FastifyPluginAsync } from "fastify";

import { basicAuthHook, type BasicAuthConfig } from "./auth.ts";
import type { Metrics } from "./metrics.ts";

export interface MetricsDeps {
  metrics: Metrics;
  // Computes learning_lag from the event log; null when no rule has activated.
  getLearningLag: () => Promise<number | null>;
  auth: BasicAuthConfig;
}

export const metricsPlugin: FastifyPluginAsync<MetricsDeps> = async (app, deps) => {
  app.addHook("onRequest", basicAuthHook(deps.auth));

  app.get("/metrics", async (_request, reply) => {
    // Refresh the learning_lag gauge from the event log before scraping. The
    // series is registered lazily so it is absent (not 0) until a rule has
    // actually activated — an absent series is honest.
    const lag = await deps.getLearningLag();
    if (lag !== null) {
      deps.metrics.learningLag.set(lag);
      if (!deps.metrics.registry.getSingleMetric("learning_lag_seconds")) {
        deps.metrics.registry.registerMetric(deps.metrics.learningLag);
      }
    } else {
      deps.metrics.registry.removeSingleMetric("learning_lag_seconds");
    }
    reply.type("text/plain");
    return deps.metrics.registry.metrics();
  });
};
