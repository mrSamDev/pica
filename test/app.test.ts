import { describe, expect, it } from "vitest";

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
    platform: createFakePlatform(),
    llm: createFakeLlm(),
    dashboardQueries: createFakeDashboardQueries(),
    metrics: createFakeMetrics(),
  });
}

describe("app", () => {
  it("health endpoint returns 200", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("error handler returns structured error", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { statusCode: 404 } });
  });

  it("raw body captured before JSON parse", async () => {
    const app = makeApp();
    app.post("/echo", async (request) => {
      return { rawBody: request.rawBody };
    });
    const body = JSON.stringify({ hello: "world" });
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      payload: body,
      headers: { "content-type": "application/json" },
    });
    expect(res.json()).toEqual({ rawBody: body });
  });

  it("dashboard route serves 200", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("dashboard API stub returns empty state", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.system.reviewsRunning).toBe(0);
    expect(data.learning.activeRules).toBe(0);
    expect(data.recentActivity).toEqual([]);
  });
});
