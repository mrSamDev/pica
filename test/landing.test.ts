import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
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

function makeApp() {
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
    auth: {},
  });
}

describe("landing page", () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    app = makeApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("serves html at /landing-page", async () => {
    const res = await app.inject({ method: "GET", url: "/landing-page" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("self-learning code review agent");
    expect(res.body).toContain("Why this experiment");
    expect(res.body).toContain("Core principles");
  });

  it("exposes no links to the auth-gated dashboard or why pages", async () => {
    const res = await app.inject({ method: "GET", url: "/landing-page" });
    expect(res.body).not.toContain('href="/dashboard"');
    expect(res.body).not.toContain('href="/why"');
  });

  it("needs no auth", async () => {
    const res = await app.inject({ method: "GET", url: "/landing-page" });
    expect(res.statusCode).toBe(200);
  });

  it("redirects / to /landing-page", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/landing-page");
  });
});
