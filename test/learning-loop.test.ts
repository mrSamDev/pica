import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Queue } from "bullmq";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { getLearnerConfig, loadConfig } from "../src/config.ts";
import * as schema from "../src/db/schema.ts";
import { findingOutcomes, learningEvents, patterns, repoRules, reviews } from "../src/db/schema.ts";
import { runLearner } from "../src/learning/learner/learner.ts";
import type { LLMClient } from "../src/llm/client.ts";
import type { PlatformClient } from "../src/platform/types.ts";
import { createRedisConnection } from "../src/queue/connection.ts";
import { createOutcomeWorker } from "../src/queue/outcome.ts";
import { runReview } from "../src/review/pipeline/pipeline.ts";
import type { Finding, ReviewRequest } from "../src/review/types.ts";
import { createFakeMetrics } from "./helpers/fakes.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();

const config = loadConfig({
  DATABASE_URL: "postgres://localhost:5432/pica",
  REDIS_URL: "redis://localhost:6379",
  WEBHOOK_SECRET: "s",
  LLM_API_KEY: "k",
  PLATFORM_TOKEN: "t",
  LOG_LEVEL: "silent",
});
const learnerOptions = getLearnerConfig(config);

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -40,3 +40,4 @@
+if (!token.exp) { throw new Error("missing exp"); }
`;

const SEED_FINDINGS: Finding[] = [
  { filePath: "src/auth.ts", lineStart: 40, lineEnd: 40, category: "security", patternId: "security:learned", patternUuid: "", severity: "suggestion", message: "JWT expiration isn't validated." },
  { filePath: "src/auth.ts", lineStart: 41, lineEnd: 41, category: "security", patternId: "security:learned", patternUuid: "", severity: "suggestion", message: "JWT exp unchecked." },
  { filePath: "src/auth.ts", lineStart: 42, lineEnd: 42, category: "security", patternId: "security:learned", patternUuid: "", severity: "suggestion", message: "missing exp." },
];

// §13 Phase 3 exit criterion + §14: dismiss 3x -> candidate -> Beta -> a
// future review excludes the pattern. The full loop, through the real worker.
describe.skipIf(!dockerAvailable)("learning loop end-to-end", () => {
  let pg: StartedPostgreSqlContainer | undefined;
  let redisContainer: StartedRedisContainer | undefined;
  let pool: Pool | undefined;
  let redis: ReturnType<typeof createRedisConnection> | undefined;
  let queue: Queue | undefined;
  let worker: ReturnType<typeof createOutcomeWorker> | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    pool = new Pool({ connectionString: pg.getConnectionUri() });
    const raw = drizzle(pool);
    await migrate(raw, { migrationsFolder: "./drizzle" });
    db = drizzle(pool, { schema });

    redisContainer = await new RedisContainer("redis:7-alpine").start();
    redis = createRedisConnection(redisContainer.getConnectionUrl());
    queue = new Queue("outcomes", { connection: redis });
    const d = db;
    if (d === undefined) throw new Error("db not initialized");
    worker = createOutcomeWorker(
      redis,
      {
        db: d,
        metrics: createFakeMetrics(),
        runLearner: async (input) => {
          await runLearner(d, input, learnerOptions);
        },
      },
      loggerStub,
    );
  }, 180_000);

  afterAll(async () => {
    await worker?.close();
    await queue?.close();
    await redis?.quit();
    await pool?.end();
    await pg?.stop();
    await redisContainer?.stop();
  });

  async function makePostedFindings(repo: string, prId: string): Promise<string[]> {
    if (db === undefined) throw new Error("db not initialized");
    const patternId = randomUUID();
    await db.insert(patterns).values({ id: patternId, repo, category: "security", canonicalMessage: "security:learned", patternVersion: "v1", status: "active" });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const reviewId = randomUUID();
      const findingId = randomUUID();
      await db.insert(reviews).values({ id: reviewId, repo, prId: `${prId}-${i}`, commitSha: "abc", status: "done", mode: "post" });
      await db.insert(schema.findings).values({
        id: findingId,
        reviewId,
        repo,
        prId,
        commitSha: "abc",
        filePath: SEED_FINDINGS[i]!.filePath,
        lineStart: SEED_FINDINGS[i]!.lineStart,
        lineEnd: SEED_FINDINGS[i]!.lineEnd,
        category: "security",
        patternId,
        severity: "suggestion",
        message: SEED_FINDINGS[i]!.message,
        messageHash: `h${i}`,
        status: "posted",
      });
      await db.insert(findingOutcomes).values({ findingId, status: "posted" });
      ids.push(findingId);
    }
    return ids;
  }

  async function getActiveRule(repo: string): Promise<{ id: string; status: string } | undefined> {
    if (db === undefined) throw new Error("db not initialized");
    const rows = await db.select().from(repoRules).where(eq(repoRules.repo, repo));
    return rows.find((r) => r.status === "active");
  }

  async function waitForActiveRule(repo: string, timeoutMs: number): Promise<{ id: string; status: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rule = await getActiveRule(repo);
      if (rule) return rule;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("active rule did not form");
  }

  it("dismiss 3x -> candidate -> active rule -> future review excludes the pattern (prompt + postfilter)", async () => {
    if (db === undefined || queue === undefined || worker === undefined) throw new Error("setup not initialized");
    const repo = "owner/repo";
    const prOfDismissals = "100";
    const prOfReview = "101";

    const findingIds = await makePostedFindings(repo, prOfDismissals);

    // 3 dismissals through the real serialized outcome worker (which runs the
    // inline learner). The learner aggregates the pattern's evidence.
    for (const findingId of findingIds) {
      await queue.add("outcome", { findingId, repo, to: "dismissed", source: "poller" });
    }
    const rule = await waitForActiveRule(repo, 15_000);
    expect(rule.status).toBe("active");

    // rule.activated event emitted with the learning_lag contract shape.
    const activatedEvents = await db.select().from(learningEvents).where(eq(learningEvents.eventType, "rule.activated"));
    expect(activatedEvents.length).toBeGreaterThan(0);

    // Future review: LLM re-flags the same pattern id.
    let lastPrompt = "";
    const llm: LLMClient = {
      review: async (prompt) => {
        lastPrompt = prompt;
        return JSON.stringify(SEED_FINDINGS);
      },
    };
    const reviewId = randomUUID();
    await db.insert(reviews).values({ id: reviewId, repo, prId: prOfReview, commitSha: "abc", status: "running", mode: "post" });
    const request: ReviewRequest = { reviewId, repo, prId: prOfReview, commitSha: "abc", platform: "github", mode: "post", postingCap: 10, summaryComment: false };

    const result = await runReview({ db, platform: makePlatform(), llm, config, metrics: createFakeMetrics() }, request);

    // The learned rule is injected into the prompt (REPO RULES, §5.8).
    expect(lastPrompt).toContain("[ignore]");

    // The finding is suppressed by the post-filter, deterministically (§5.8).
    expect(result.posted).toBe(0);
    const suppressed = await db.select().from(schema.findings).where(eq(schema.findings.reviewId, reviewId));
    expect(suppressed).toHaveLength(3);
    expect(suppressed.every((f) => f.status === "suppressed")).toBe(true);
  }, 30_000);
});

// Minimal logger stub (pino Logger shape used by the worker).
// SAFETY: the worker only calls info/warn/error/debug/fatal on the logger; a
// silent no-op satisfies that surface for this integration test.
const loggerStub = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => loggerStub,
} as never;

function makePlatform(): PlatformClient {
  return {
    fetchDiff: async () => DIFF,
    listComments: async () => [],
    createInlineComment: async () => ({ id: randomUUID() }),
    createPrComment: async () => ({ id: randomUUID() }),
    getCommentState: async () => ({ resolved: false, deleted: false, replyCount: 0 }),
  };
}
