import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Queue } from "bullmq";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createDashboardQueries } from "../src/dashboard/projection.ts";
import type { Db } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrations.ts";
import * as schema from "../src/db/schema.ts";
import { findings, reviews } from "../src/db/schema.ts";
import type { LLMClient } from "../src/llm/client.ts";
import { createLogger } from "../src/observability/logger.ts";
import type { PlatformClient } from "../src/platform/types.ts";
import { createRedisConnection } from "../src/queue/connection.ts";
import { createReviewWorker } from "../src/queue/worker.ts";
import { createFakeMetrics } from "./helpers/fakes.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();

const config = loadConfig({
  DATABASE_URL: "postgres://localhost:5432/pica",
  REDIS_URL: "redis://localhost:6379",
  WEBHOOK_SECRET: "test-webhook-secret",
  LLM_API_KEY: "test-llm-key",
  PLATFORM_TOKEN: "test-platform-token",
  LOG_LEVEL: "silent",
});
const logger = createLogger(config);

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -40,3 +40,4 @@
 const token = getToken();
+if (!token.exp) { throw new Error("missing exp"); }
`;

const LLM_OUTPUT = JSON.stringify([
  {
    filePath: "src/auth.ts",
    lineStart: 42,
    lineEnd: 42,
    category: "security",
    patternId: "security:jwt-expiration",
    severity: "error",
    message: "JWT expiration isn't validated.",
  },
]);

function makeFakePlatform(): PlatformClient & { posted: Array<{ repo: string; prId: string; content: string }> } {
  const posted: Array<{ repo: string; prId: string; content: string }> = [];
  return {
    posted,
    async fetchDiff() {
      return DIFF;
    },
    async listComments() {
      return [];
    },
    async createInlineComment(repo, prId, _target, content) {
      posted.push({ repo, prId, content });
      return { id: "comment-1" };
    },
    async createPrComment(repo, prId, content) {
      posted.push({ repo, prId, content });
      return { id: "pr-comment-1" };
    },
    async getCommentState() {
      return { resolved: false, deleted: false, replyCount: 0 };
    },
  };
}

function makeFakeLlm(): LLMClient {
  return { review: async () => LLM_OUTPUT };
}

async function waitForReviewDone(db: Db, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.select({ status: reviews.status }).from(reviews);
    if (rows.some((r) => r.status === "done")) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("review did not complete in time");
}

describe.skipIf(!dockerAvailable)("e2e review loop", () => {
  let pg: StartedPostgreSqlContainer | undefined;
  let redisContainer: StartedRedisContainer | undefined;
  let pool: Pool | undefined;
  let redis: ReturnType<typeof createRedisConnection> | undefined;
  let queue: Queue | undefined;
  let worker: ReturnType<typeof createReviewWorker> | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  let db: Db | undefined;
  let platform: ReturnType<typeof makeFakePlatform> | undefined;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: pg.getConnectionUri() });
    db = drizzle(pool, { schema });
    await runMigrations(db);

    redisContainer = await new RedisContainer("redis:7-alpine").start();
    redis = createRedisConnection(redisContainer.getConnectionUrl());
    queue = new Queue("reviews", { connection: redis });

    platform = makeFakePlatform();
    const llm = makeFakeLlm();
    const deps = { db, platform, llm, config, metrics: createFakeMetrics() };
    worker = createReviewWorker(redis, deps, logger);

    app = buildApp(config, logger, {
      db,
      queue,
      platform,
      llm,
      dashboardQueries: createDashboardQueries(db, queue, queue),
      metrics: createFakeMetrics(),
      getLearningLag: async () => null,

      getDismissalRate: async () => null,
      auth: {},
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await worker?.close();
    await queue?.close();
    await redis?.quit();
    await pool?.end();
    await pg?.stop();
    await redisContainer?.stop();
  });

  it("webhook → diff → LLM → comment end-to-end", async () => {
    if (app === undefined || db === undefined || platform === undefined) throw new Error("setup not initialized");

    const payload = JSON.stringify({
      repo: "owner/repo",
      prId: "42",
      commitSha: "abc123",
      diffHref: "https://api.github.com/repos/owner/repo/pulls/42",
    });
    const signature = `sha256=${createHmac("sha256", config.WEBHOOK_SECRET).update(payload).digest("hex")}`;

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      payload,
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    });
    expect(res.statusCode).toBe(200);

    await waitForReviewDone(db, 15_000);

    expect(platform.posted).toHaveLength(1);
    expect(platform.posted[0]?.content).toContain("JWT expiration");
    // §5.12: every posted comment teaches the feedback protocol so dismiss
    // replies can actually arrive.
    expect(platform.posted[0]?.content).toContain("Not useful? Reply `dismiss: <reason>`");

    const rows = await db.select().from(findings);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.patternId).toBeTruthy();
    expect(rows[0]?.status).toBe("posted");
  });
});
