import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Queue } from "bullmq";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createDashboardQueries } from "../src/dashboard/projection.ts";
import * as schema from "../src/db/schema.ts";
import { findings, findingOutcomes, patterns, postedComments, reviews } from "../src/db/schema.ts";
import { createLogger } from "../src/observability/logger.ts";
import { createRedisConnection } from "../src/queue/connection.ts";
import { createOutcomeQueue, createOutcomeWorker, type OutcomeQueue } from "../src/queue/outcome.ts";
import { handleOutcomeEvent } from "../src/webhooks/outcome.ts";
import { createFakeLlm, createFakeMetrics, createFakePlatform } from "./helpers/fakes.ts";
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

describe.skipIf(!dockerAvailable)("outcome queue", () => {
  let pg: StartedPostgreSqlContainer | undefined;
  let redisContainer: StartedRedisContainer | undefined;
  let pool: Pool | undefined;
  let redis: ReturnType<typeof createRedisConnection> | undefined;
  let queue: Queue | undefined;
  let worker: ReturnType<typeof createOutcomeWorker> | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;
  let outcomeQueue: OutcomeQueue | undefined;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: pg.getConnectionUri() });
    const raw = drizzle(pool);
    await migrate(raw, { migrationsFolder: "./drizzle" });
    db = drizzle(pool, { schema });

    redisContainer = await new RedisContainer("redis:7-alpine").start();
    redis = createRedisConnection(redisContainer.getConnectionUrl());
    queue = new Queue("outcomes", { connection: redis });
    outcomeQueue = createOutcomeQueue(queue);
    worker = createOutcomeWorker(redis, { db, metrics: createFakeMetrics() }, logger);
  }, 180_000);

  afterAll(async () => {
    await worker?.close();
    await queue?.close();
    await redis?.quit();
    await pool?.end();
    await pg?.stop();
    await redisContainer?.stop();
  });

  async function seedPostedFinding(commentId: string): Promise<string> {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = randomUUID();
    const patternId = randomUUID();
    const findingId = randomUUID();
    await db.insert(reviews).values({ id: reviewId, repo: "owner/repo", prId: "42", commitSha: "abc", status: "done", mode: "post" });
    await db.insert(patterns).values({ id: patternId, repo: "owner/repo", category: "security", canonicalMessage: `security:jwt:${commentId}`, patternVersion: "v1", status: "active" });
    await db.insert(findings).values({ id: findingId, reviewId, repo: "owner/repo", prId: "42", commitSha: "abc", filePath: "src/a.ts", lineStart: 1, lineEnd: 1, category: "security", patternId, severity: "error", message: `JWT ${commentId}`, messageHash: "h", status: "posted" });
    await db.insert(postedComments).values({ findingId, platform: "github", commentId });
    await db.insert(findingOutcomes).values({ findingId, status: "posted" });
    return findingId;
  }

  async function getStatus(findingId: string): Promise<string | null> {
    if (db === undefined) throw new Error("db not initialized");
    const rows = await db.select({ status: findingOutcomes.status }).from(findingOutcomes).where(eq(findingOutcomes.findingId, findingId));
    return rows[0]?.status ?? null;
  }

  async function waitForStatus(findingId: string, expected: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await getStatus(findingId)) === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`outcome did not reach ${expected} in time`);
  }

  it("posted_comments links a comment to its finding (webhook outcome lands on the right finding)", async () => {
    if (outcomeQueue === undefined || db === undefined) throw new Error("setup not initialized");
    const findingId = await seedPostedFinding("c-11");
    await handleOutcomeEvent({ db, queue: outcomeQueue }, { repo: "owner/repo", prId: "42", eventType: "comment_created", commentId: "c-11", content: "dismiss: this rule is useless", platform: "github" });
    await waitForStatus(findingId, "dismissed", 10_000);
    const rows = await db.select({ dismissalReason: findingOutcomes.dismissalReason }).from(findingOutcomes).where(eq(findingOutcomes.findingId, findingId));
    expect(rows[0]?.dismissalReason).toBe("this rule is useless");
  });

  it("webhook outcome event updates outcome (comment resolved -> resolved)", async () => {
    if (outcomeQueue === undefined || db === undefined) throw new Error("setup not initialized");
    const findingId = await seedPostedFinding("c-4");
    await handleOutcomeEvent({ db, queue: outcomeQueue }, { repo: "owner/repo", prId: "42", eventType: "comment_resolved", commentId: "c-4", resolverUser: "alice", platform: "github" });
    await waitForStatus(findingId, "resolved", 10_000);
    const rows = await db.select({ resolverUser: findingOutcomes.resolverUser }).from(findingOutcomes).where(eq(findingOutcomes.findingId, findingId));
    expect(rows[0]?.resolverUser).toBe("alice");
  });

  it("webhook outcome event updates outcome (comment deleted -> dismissed)", async () => {
    if (outcomeQueue === undefined || db === undefined) throw new Error("setup not initialized");
    const findingId = await seedPostedFinding("c-del");
    await handleOutcomeEvent({ db, queue: outcomeQueue }, { repo: "owner/repo", prId: "42", eventType: "comment_deleted", commentId: "c-del", platform: "github" });
    await waitForStatus(findingId, "dismissed", 10_000);
  });

  it("a reply event attributes via in_reply_to when the reply id is unknown", async () => {
    if (outcomeQueue === undefined || db === undefined) throw new Error("setup not initialized");
    const findingId = await seedPostedFinding("c-9");
    // GitHub delivers a reply as a new comment id whose in_reply_to_id is ours.
    await handleOutcomeEvent({ db, queue: outcomeQueue }, { repo: "owner/repo", prId: "42", eventType: "comment_created", commentId: "c-reply-9", inReplyTo: "c-9", content: "dismiss: doesn't apply to this file", platform: "github" });
    await waitForStatus(findingId, "dismissed", 10_000);
    const rows = await db.select({ dismissalReason: findingOutcomes.dismissalReason }).from(findingOutcomes).where(eq(findingOutcomes.findingId, findingId));
    expect(rows[0]?.dismissalReason).toBe("doesn't apply to this file");
  });

  it("outcome mutations funnel through one queue: concurrent webhook+poller writes cannot race", async () => {
    if (outcomeQueue === undefined || db === undefined) throw new Error("setup not initialized");
    const findingId = await seedPostedFinding("c-7");
    // Interleave webhook (replied/resolved) and poller (dismissed) writes.
    await Promise.all([
      outcomeQueue.enqueue({ findingId, repo: "owner/repo", to: "replied", source: "webhook" }),
      outcomeQueue.enqueue({ findingId, repo: "owner/repo", to: "resolved", source: "webhook" }),
      outcomeQueue.enqueue({ findingId, repo: "owner/repo", to: "replied", source: "poller" }),
      outcomeQueue.enqueue({ findingId, repo: "owner/repo", to: "dismissed", source: "poller" }),
      outcomeQueue.enqueue({ findingId, repo: "owner/repo", to: "resolved", source: "webhook" }),
    ]);
    // Wait until a terminal state is reached.
    const deadline = Date.now() + 10_000;
    let status: string | null = null;
    while (Date.now() < deadline) {
      status = await getStatus(findingId);
      if (status === "resolved" || status === "dismissed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Final state must be a reachable terminal, never a corrupted/invalid one.
    expect(["resolved", "dismissed"]).toContain(status);
  });

  it("outcome webhook route: HMAC-validated event updates the outcome end-to-end", async () => {
    if (db === undefined || queue === undefined) throw new Error("setup not initialized");
    const findingId = await seedPostedFinding("c-route");
    const app = buildApp(config, logger, {
      db,
      queue,
      platform: createFakePlatform(),
      llm: createFakeLlm(),
      dashboardQueries: createDashboardQueries(db, queue, queue),
      metrics: createFakeMetrics(),
      getLearningLag: async () => null,

      getDismissalRate: async () => null,
      auth: {},
    });

    const payload = JSON.stringify({
      repo: "owner/repo",
      prId: "42",
      eventType: "comment_resolved",
      commentId: "c-route",
      resolverUser: "bob",
    });
    const signature = `sha256=${createHmac("sha256", config.WEBHOOK_SECRET).update(payload).digest("hex")}`;
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/outcomes/github",
      payload,
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().handled).toBe(true);

    await waitForStatus(findingId, "resolved", 10_000);
    await app.close();
  });
});
