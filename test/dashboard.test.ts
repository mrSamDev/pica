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
    outcomeQueue: createUnusedQueue(),
    platform: createFakePlatform(),
    llm: createFakeLlm(),
    dashboardQueries: queries,
    metrics: createFakeMetrics(),
    getLearningLag: async () => null,

    getDismissalRate: async () => null,
    auth: {},
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

  it("serves the dashboard HTML with the poll + rules renderers intact", async () => {
    const app = makeApp(createFakeDashboardQueries());
    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("function poll()");
    expect(res.body).toContain("function renderRules");
    expect(res.body).toContain("function render(state)");
    await app.close();
  });

  it("shows the learning panel: rule counts + learning lag", async () => {
    const queries = createFakeDashboardQueries({
      countRulesByStatus: async () => ({ active: 2, candidate: 1, retired: 0 }),
      learningLag: async () => 3600,
    });
    const app = makeApp(queries);
    const res = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(res.json().learning).toMatchObject({ activeRules: 2, candidateRules: 1, retiredRules: 0, learningLagSeconds: 3600 });
    await app.close();
  });

  it("rounds a fractional learning lag to match the integer response schema", async () => {
    // getLearningLagSeconds returns (activatedAt - dismissedAt) / 1000, a
    // float. The response schema pins learningLagSeconds as integer|null; an
    // unrounded float makes fast-json-stringify throw (production 500s).
    // The dashboard labels the row in seconds, so the field carries seconds —
    // rounded, not converted.
    const queries = createFakeDashboardQueries({ learningLag: async () => 3600.516 });
    const app = makeApp(queries);
    const res = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.json().learning.learningLagSeconds).toBe(3601);
    await app.close();
  });

  it("§8/§5.7: metrics view shows the dismissal-rate trend and ε-probes", async () => {
    const queries = createFakeDashboardQueries({
      dismissalRateTrend: async () => [0.5, 0.42, 0.3],
      probes: async () => [{ patternId: "p1", filePath: "src/auth/jwt.ts", at: new Date().toISOString() }],
    });
    const app = makeApp(queries);
    const res = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(res.json().learning.dismissalRateTrend).toEqual([0.5, 0.42, 0.3]);
    expect(res.json().learning.probes).toHaveLength(1);
    expect(res.json().learning.probes[0]?.filePath).toBe("src/auth/jwt.ts");
    await app.close();
  });

  it("dashboard view: raw metrics and probes, no marketing copy (control-room aesthetic)", async () => {
    const app = makeApp(createFakeDashboardQueries({ dismissalRateTrend: async () => [0.5, 0.42, 0.3], probes: async () => [] }));
    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Learning lag");
    expect(res.body).toContain("Dismissal rate / review");
    expect(res.body).toContain("ε-probes");
    // §8 character: raw numbers/statuses, not SaaS metrics-are-simple copy.
    expect(res.body).not.toMatch(/health score|intelligence|AI magic/i);
    await app.close();
  });

  it("shows rules with evidence counts (Phase 3 learned rules view)", async () => {
    const queries = createFakeDashboardQueries({
      listRules: async () => [{ id: "r1", repo: "owner/repo", ruleType: "ignore", status: "active", pattern: "security:jwt", confidence: 0.9, evidenceCount: 3, positiveCount: 0, negativeCount: 3, createdAt: new Date() }],
    });
    const app = makeApp(queries);
    const res = await app.inject({ method: "GET", url: "/api/rules" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0]).toMatchObject({ pattern: "security:jwt", status: "active", negativeCount: 3 });
    await app.close();
  });

  it("why-disappeared drill-down: shows rule, confidence, evidence, learned-from PRs", async () => {
    const queries = createFakeDashboardQueries({
      whyDisappeared: async (findingId: string) =>
        findingId === "abc"
          ? {
              finding: { status: "suppressed", filePath: "src/a.ts", message: "JWT", severity: "error", prId: "200" },
              pattern: { canonicalMessage: "security:jwt", category: "security" },
              rule: { status: "active", confidence: 0.9, evidenceCount: 3, positiveCount: 0, negativeCount: 3 },
              evidence: [{ prId: "182", outcome: "dismissed" }],
              lastProbe: null,
            }
          : null,
    });
    const app = makeApp(queries);
    const res = await app.inject({ method: "GET", url: "/api/why?findingId=abc" });
    expect(res.statusCode).toBe(200);
    expect(res.json()?.rule?.confidence).toBeCloseTo(0.9);
    expect(res.json()?.evidence).toEqual([{ prId: "182", outcome: "dismissed" }]);

    // Unknown finding -> null (not an error).
    const missing = await app.inject({ method: "GET", url: "/api/why?findingId=nope" });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toBeNull();
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

describe("dashboard auth", () => {
  function makeAuthedApp() {
    return buildApp(config, logger, {
      db: createUnusedDb(),
      queue: createUnusedQueue(),
      outcomeQueue: createUnusedQueue(),
      platform: createFakePlatform(),
      llm: createFakeLlm(),
      dashboardQueries: createFakeDashboardQueries(),
      metrics: createFakeMetrics(),
      getLearningLag: async () => null,
      getDismissalRate: async () => null,
      auth: { username: "admin", password: "secret" },
    });
  }

  it("rejects unauthenticated requests with 401", async () => {
    const app = makeAuthedApp();
    const res = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Basic");
    await app.close();
  });

  it("rejects wrong credentials with 401", async () => {
    const app = makeAuthedApp();
    const res = await app.inject({ method: "GET", url: "/api/dashboard", headers: { authorization: `Basic ${Buffer.from("admin:wrong").toString("base64")}` } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("serves the dashboard with valid credentials", async () => {
    const app = makeAuthedApp();
    const res = await app.inject({ method: "GET", url: "/api/dashboard", headers: { authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("gates /metrics too", async () => {
    const app = makeAuthedApp();
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
