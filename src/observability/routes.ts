import type { FastifyPluginAsync } from "fastify";
import type { Gauge, Registry } from "prom-client";

import { basicAuthHook, type BasicAuthConfig } from "./auth.ts";
import type { Metrics } from "./metrics.ts";

export interface MetricsDeps {
  metrics: Metrics;
  // Computes learning_lag from the event log; null when no rule has activated.
  getLearningLag: () => Promise<number | null>;
  // Computes the rolling-30d dismissal rate; null before decisive outcomes.
  getDismissalRate: () => Promise<number | null>;
  auth: BasicAuthConfig;
}

// §8: gauges derived outside this module (learning_lag, dismissal rate) are
// registered lazily so an absent series is honest — not scraped as 0 — until
// real data exists. A gauge with no data simply stays out of the registry.
function refreshGauge(registry: Registry, gauge: Gauge<string>, name: string, value: number | null): void {
  if (value === null) {
    registry.removeSingleMetric(name);
    return;
  }
  gauge.set(value);
  if (!registry.getSingleMetric(name)) {
    registry.registerMetric(gauge);
  }
}

export const metricsPlugin: FastifyPluginAsync<MetricsDeps> = async (app, deps) => {
  app.addHook("onRequest", basicAuthHook(deps.auth));

  app.get("/metrics", async () => {
    // Refresh the derived gauges from the event/outcome log before scraping.
    refreshGauge(deps.metrics.registry, deps.metrics.learningLag, "learning_lag_seconds", await deps.getLearningLag());
    refreshGauge(deps.metrics.registry, deps.metrics.dismissalRate, "pattern_dismissal_rate", await deps.getDismissalRate());
    return deps.metrics.registry.metrics();
  });
};
