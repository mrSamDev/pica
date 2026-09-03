import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { loadConfig } from "../src/config.ts";
import * as schema from "../src/db/schema.ts";
import { patterns, repoRules, reviews } from "../src/db/schema.ts";
import { computeRulesVersion, getReviewLearningContext, RETRIEVAL_VERSION } from "../src/learning/retrieval/retrieval.ts";
import { updateReviewStatus } from "../src/review/pipeline/queries.ts";
import { runReview } from "../src/review/pipeline/pipeline.ts";
import { PROMPT_VERSION } from "../src/review/prompts/build.ts";
import type { LLMClient } from "../src/llm/client.ts";
import type { PlatformClient } from "../src/platform/types.ts";
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

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -40,3 +40,4 @@
 const token = getToken();
+if (!token.exp) { throw new Error("missing exp"); }
`;

let commentSeq = 0;

function makePlatform(): PlatformClient {
  return {
    fetchDiff: async () => DIFF,
    listComments: async () => [],
    createInlineComment: async () => ({ id: `i-${++commentSeq}` }),
    createPrComment: async () => ({ id: `p-${++commentSeq}` }),
    getCommentState: async () => ({ resolved: false, deleted: false, replyCount: 0 }),
  };
}

describe.skipIf(!dockerAvailable)("§3 review reproducibility columns", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const raw = drizzle(pool);
    await migrate(raw, { migrationsFolder: "./drizzle" });
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  function requireDb() {
    if (db === undefined) throw new Error("db not initialized");
    return db;
  }

  async function seedReview(repo: string, prId: string): Promise<string> {
    const reviewId = randomUUID();
    await requireDb().insert(reviews).values({ id: reviewId, repo, prId, commitSha: "abc123", status: "queued", mode: "post" });
    return reviewId;
  }

  async function seedActiveRule(repo: string): Promise<string> {
    const patternId = randomUUID();
    await requireDb().insert(patterns).values({ id: patternId, repo, category: "correctness", canonicalMessage: "correctness:repro", patternVersion: "v1", status: "active" });
    await requireDb()
      .insert(repoRules)
      .values({ repo, ruleType: "ignore", patternId, payload: { reason: "test" }, payloadHash: "h", status: "active" });
    return patternId;
  }

  const llm: LLMClient = {
    review: async () => JSON.stringify([{ filePath: "src/auth.ts", lineStart: 40, lineEnd: 40, category: "correctness", patternId: "correctness:repro", severity: "warning", message: "finding" }]),
  };

  it("records model, prompt_version, rules_version, retrieval_version and started_at for a real review", async () => {
    const d = requireDb();
    const repo = "repro/with-rules";
    const reviewId = await seedReview(repo, "1");
    await seedActiveRule(repo);

    await runReview(
      { db: d, platform: makePlatform(), llm, config, metrics: createFakeMetrics() },
      {
        reviewId,
        repo,
        prId: "1",
        commitSha: "abc123",
        diffHref: "https://api.github.com/repos/x/y/pulls/1",
        platform: "github",
        mode: "post",
        postingCap: 10,
        summaryComment: false,
      },
    );

    const row = (await d.select().from(reviews).where(eq(reviews.id, reviewId)))[0];
    expect(row).toBeDefined();
    expect(row!.model).toBe(config.LLM_MODEL);
    expect(row!.promptVersion).toBe(PROMPT_VERSION);
    // The exact fingerprint of the rules actually injected into the prompt.
    const ctx = await getReviewLearningContext(d, repo);
    expect(row!.rulesVersion).toBe(computeRulesVersion([ctx.rulesText]));
    expect(row!.rulesVersion).not.toBe("none");
    expect(row!.retrievalVersion).toBe(RETRIEVAL_VERSION);
  });

  it("records rules_version 'none' when no rules were active", async () => {
    const d = requireDb();
    const repo = "repro/no-rules";
    const reviewId = await seedReview(repo, "2");

    await runReview(
      { db: d, platform: makePlatform(), llm, config, metrics: createFakeMetrics() },
      {
        reviewId,
        repo,
        prId: "2",
        commitSha: "abc123",
        diffHref: "https://api.github.com/repos/x/y/pulls/2",
        platform: "github",
        mode: "post",
        postingCap: 10,
        summaryComment: false,
      },
    );

    const row = (await d.select().from(reviews).where(eq(reviews.id, reviewId)))[0];
    expect(row!.rulesVersion).toBe("none");
  });

  it("started_at is set when a review starts running; completed_at when it finishes", async () => {
    const d = requireDb();
    const reviewId = await seedReview("repro/timestamps", "3");

    await updateReviewStatus(d, reviewId, "running");
    const running = (await d.select().from(reviews).where(eq(reviews.id, reviewId)))[0];
    expect(running!.startedAt).toBeInstanceOf(Date);
    expect(running!.completedAt).toBeNull();

    await updateReviewStatus(d, reviewId, "done");
    const done = (await d.select().from(reviews).where(eq(reviews.id, reviewId)))[0];
    expect(done!.completedAt).toBeInstanceOf(Date);
  });
});
