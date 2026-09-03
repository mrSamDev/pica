import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/observability/logger.ts";
import { createMetrics } from "../src/observability/metrics.ts";
import { createFakeDashboardQueries, createFakeLlm, createFakePlatform, createUnusedDb, createUnusedQueue } from "./helpers/fakes.ts";

const config = loadConfig({
  DATABASE_URL: "postgres://localhost:5432/pica",
  REDIS_URL: "redis://localhost:6379",
  WEBHOOK_SECRET: "test-webhook-secret",
  LLM_API_KEY: "test-llm-key",
  PLATFORM_TOKEN: "test-platform-token",
  LOG_LEVEL: "silent",
});
const logger = createLogger(config);

describe("metrics", () => {
  it("exposes operational counters at /metrics", async () => {
    const metrics = createMetrics();
    metrics.findingsPosted.inc();
    metrics.findingsSuppressed.inc();
    metrics.outcome.inc({ outcome: "resolved" });

    const app = buildApp(config, logger, {
      db: createUnusedDb(),
      queue: createUnusedQueue(),
      platform: createFakePlatform(),
      llm: createFakeLlm(),
      dashboardQueries: createFakeDashboardQueries(),
      metrics,
      getLearningLag: async () => null,

      getDismissalRate: async () => null,
      auth: {},
    });

    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("findings_posted_total 1");
    expect(res.body).toContain("findings_suppressed_total 1");
    expect(res.body).toContain('outcome_total{outcome="resolved"} 1');
    // No rule activated yet -> learning_lag series is absent (honest empty).
    expect(res.body).not.toContain("learning_lag_seconds");
    // No decisive outcomes yet -> dismissal rate series is also absent.
    expect(res.body).not.toContain("pattern_dismissal_rate");
    await app.close();
  });

  it("§5.7: probes increment findings_probed_total", async () => {
    const metrics = createMetrics();
    metrics.probes.inc();
    const app = buildApp(config, logger, {
      db: createUnusedDb(),
      queue: createUnusedQueue(),
      platform: createFakePlatform(),
      llm: createFakeLlm(),
      dashboardQueries: createFakeDashboardQueries(),
      metrics,
      getLearningLag: async () => null,
      getDismissalRate: async () => null,
      auth: {},
    });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("findings_probed_total 1");
    await app.close();
  });

  it("§8: pattern_dismissal_rate appears once decisive evidence exists", async () => {
    const metrics = createMetrics();
    const app = buildApp(config, logger, {
      db: createUnusedDb(),
      queue: createUnusedQueue(),
      platform: createFakePlatform(),
      llm: createFakeLlm(),
      dashboardQueries: createFakeDashboardQueries(),
      metrics,
      getLearningLag: async () => null,
      getDismissalRate: async () => 0.4,
      auth: {},
    });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("pattern_dismissal_rate 0.4");
    await app.close();
  });

  it("sets learning_lag_seconds when a rule has activated", async () => {
    const metrics = createMetrics();
    const app = buildApp(config, logger, {
      db: createUnusedDb(),
      queue: createUnusedQueue(),
      platform: createFakePlatform(),
      llm: createFakeLlm(),
      dashboardQueries: createFakeDashboardQueries(),
      metrics,
      getLearningLag: async () => 3600,
      getDismissalRate: async () => null,
      auth: {},
    });

    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("learning_lag_seconds 3600");
    await app.close();
  });
});
