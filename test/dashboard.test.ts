import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { DashboardQueries } from "../src/dashboard/projection.ts";
import { createLogger } from "../src/observability/logger.ts";
import { createFakeDashboardQueries, createFakeLlm, createFakeMetrics, createFakePlatform, createUnusedDb, createUnusedQueue } from "./helpers/fakes.ts";

const config = loadConfig({
  DATABASE_URL: "postgres://localhost:5432/pica",
  REDIS_URL: "redis://localhost:6379",
  WEBHOOK_SECRET: "test-webhook-secret",
  LLM_API_KEY: "test-llm-key",
  PLATFORM_TOKEN: "test-platform-token",
  LOG_LEVEL: "silent",
});
const logger = createLogger(config);

function makeApp(queries: DashboardQueries) {
  return buildApp(config, logger, {
    db: createUnusedDb(),
    queue: createUnusedQueue(),
    platform: createFakePlatform(),
    llm: createFakeLlm(),
    dashboardQueries: queries,
    metrics: createFakeMetrics(),
  });
}

describe("dashboard", () => {
  it("shows live reviews", async () => {
    const queries = createFakeDashboardQueries({ countReviewsByStatus: async () => ({ running: 1, completed: 0, failed: 0 }) });
    const app = makeApp(queries);
    const res = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.json().system.reviewsRunning).toBe(1);
    await app.close();
  });

  it("shows findings", async () => {
    const queries = createFakeDashboardQueries({ countFindingsByStatus: async () => ({ posted: 2, suppressed: 1, duplicate: 0 }) });
    const app = makeApp(queries);
    const res = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(res.json().reviewBehavior).toMatchObject({ posted: 2, suppressed: 1, duplicate: 0 });
    await app.close();
  });

  it("shows outcomes", async () => {
    const queries = createFakeDashboardQueries({ countOutcomesByStatus: async () => ({ posted: 3, replied: 2, resolved: 1, dismissed: 4 }) });
    const app = makeApp(queries);
    const res = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(res.json().outcomes).toMatchObject({ posted: 3, replied: 2, resolved: 1, dismissed: 4 });
    await app.close();
  });

  it("shows system health", async () => {
    const queries = createFakeDashboardQueries({
      countReviewsByStatus: async () => ({ running: 1, completed: 5, failed: 2 }),
      queueDepth: async () => 3,
    });
    const app = makeApp(queries);
    const res = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(res.json().system).toMatchObject({ reviewsRunning: 1, reviewsCompleted: 5, reviewsFailed: 2, queueDepth: 3 });
    await app.close();
  });

  it("shows recent activity from the immutable log", async () => {
    const queries = createFakeDashboardQueries({
      recentActivity: async () => [
        { eventType: "review.completed", repo: "owner/repo", payload: { prId: "42" }, createdAt: new Date() },
        { eventType: "finding.outcome_changed", repo: "owner/repo", payload: { status: "dismissed" }, createdAt: new Date() },
      ],
    });
    const app = makeApp(queries);
    const res = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(res.json().recentActivity).toHaveLength(2);
    expect(res.json().recentActivity[0].eventType).toBe("review.completed");
    await app.close();
  });

  it("live update: API reflects state after a review completes", async () => {
    let running = 1;
    let completed = 0;
    const queries = createFakeDashboardQueries({
      countReviewsByStatus: async () => ({ running, completed, failed: 0 }),
    });
    const app = makeApp(queries);

    const before = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(before.json().system.reviewsRunning).toBe(1);

    // Simulate the review completing between polls.
    running = 0;
    completed = 1;

    const after = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(after.json().system.reviewsRunning).toBe(0);
    expect(after.json().system.reviewsCompleted).toBe(1);
    await app.close();
  });
});
