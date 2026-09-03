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
    });

    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("findings_posted_total 1");
    expect(res.body).toContain("findings_suppressed_total 1");
    expect(res.body).toContain('outcome_total{outcome="resolved"} 1');
    await app.close();
  });
});
