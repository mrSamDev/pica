import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema.ts";
import { findings, learningEvents, patterns, repoRules, reviews } from "../src/db/schema.ts";
import { loadConfig } from "../src/config.ts";
import { withFeedbackFooter } from "../src/review/pipeline/comment.ts";
import { runReview } from "../src/review/pipeline/pipeline.ts";
import { selectProbeCandidates } from "../src/learning/retrieval/probes.ts";
import type { Finding } from "../src/review/types.ts";
import type { LLMClient } from "../src/llm/client.ts";
import type { PlatformClient } from "../src/platform/types.ts";
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
const repo = "owner/probe";

describe.skipIf(!dockerAvailable)("§5.7 ε-probing: suppressed patterns keep generating evidence", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const raw = drizzle(pool);
    await migrate(raw, { migrationsFolder: "./drizzle" });
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  // A pattern with an active auto-ignore rule, so a finding resolving to it is
  // suppressed by the post-filter before ε-probing has a chance. The pattern's
  // canonical message IS the LLM patternId, so ensurePattern resolves to it.
  async function seedActiveIgnoreRule(canonicalMessage: string): Promise<string> {
    const d = db;
    if (d === undefined) throw new Error("db not initialized");
    const patternId = randomUUID();
    await d.insert(patterns).values({ id: patternId, repo, category: "correctness", canonicalMessage, patternVersion: "v1", status: "active" });
    await d.insert(repoRules).values({ repo, ruleType: "ignore", patternId, payload: { patternKey: canonicalMessage }, payloadHash: randomUUID(), status: "active", createdBy: "auto:learning" });
    return patternId;
  }

  async function runOneReview(canonicalMessage: string, filePath: string, postingCap: number): Promise<string[]> {
    const d = db;
    if (d === undefined) throw new Error("db not initialized");
    const reviewId = randomUUID();
    const prId = randomUUID();
    await d.insert(reviews).values({ id: reviewId, repo, prId, commitSha: "abc", status: "running", mode: "post" });

    const finding: Finding = { filePath, lineStart: 1, lineEnd: 1, category: "correctness", patternId: canonicalMessage, patternUuid: "", severity: "warning", message: "re-flag" };
    const capturedComments: string[] = [];
    const platform: PlatformClient = {
      fetchDiff: async () => `diff --git a/src/lib/jwt.ts b/src/lib/jwt.ts\nindex 123..456 100644\n--- a/src/lib/jwt.ts\n+++ b/src/lib/jwt.ts\n@@ -1,2 +1,3 @@\n+if (!token.exp) { throw new Error("missing exp"); }\n`,
      listComments: async () => [],
      createInlineComment: async (_repo, _prId, _target, content) => {
        capturedComments.push(content);
        return { id: `c${capturedComments.length}` };
      },
      createPrComment: async () => ({ id: "s" }),
      getCommentState: async () => ({ resolved: false, deleted: false, replyCount: 0 }),
    };
    const llm: LLMClient = { review: async () => JSON.stringify([finding]) };
    const request = { reviewId, repo, prId, commitSha: "abc", diffHref: "https://x", platform: "github" as const, mode: "post" as const, postingCap, summaryComment: false };

    await runReview({ db: d, platform, llm, config, metrics: createFakeMetrics() }, request);
    return capturedComments;
  }

  async function findingsForPattern(patternId: string) {
    const d = db;
    if (d === undefined) throw new Error("db not initialized");
    return d.select().from(findings).where(eq(findings.patternId, patternId));
  }

  async function probedEvents(patternId: string) {
    const d = db;
    if (d === undefined) throw new Error("db not initialized");
    return d
      .select()
      .from(learningEvents)
      .where(and(eq(learningEvents.eventType, "pattern.probed"), eq(learningEvents.aggregateId, `pattern:${patternId}`)));
  }

  it("falsifiability: a suppressed pattern in a new glob context still generates a probe", async () => {
    const patternId = await seedActiveIgnoreRule("probe:new-context");
    const captured = await runOneReview("probe:new-context", "src/lib/jwt.ts", 10);

    // No prior finding under src/lib/ for this pattern -> new context -> the
    // suppressed finding is promoted to a posted probe with its marker comment.
    const rows = await findingsForPattern(patternId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("posted");
    expect(rows[0]?.filePath).toBe("src/lib/jwt.ts");
    expect(captured).toHaveLength(1);
  });

  it("a probe carries a visible marker users can tell apart from a normal finding", () => {
    const probeComment = withFeedbackFooter({ filePath: "src/a.ts", lineStart: 1, lineEnd: 1, category: "correctness", patternId: "p", patternUuid: "u", severity: "warning", message: "m", isProbe: true });
    expect(probeComment).toContain("learn-probe");
    const normal = withFeedbackFooter({ filePath: "src/a.ts", lineStart: 1, lineEnd: 1, category: "correctness", patternId: "p", patternUuid: "u", severity: "warning", message: "m" });
    expect(normal).not.toContain("learn-probe");
  });

  it("a probe is posted even at postingCap 0 (falsification is not capped)", async () => {
    const patternId = await seedActiveIgnoreRule("probe:cap-bypass");
    await runOneReview("probe:cap-bypass", "src/api/handler.ts", 0);
    const rows = await findingsForPattern(patternId);
    expect(rows[0]?.status).toBe("posted");
  });

  it("only probes a new glob context: a familiar directory is suppressed, not probed", async () => {
    const d = db;
    if (d === undefined) throw new Error("db not initialized");
    const patternId = await seedActiveIgnoreRule("probe:seen-context");
    // Prior finding in src/app/ so that directory is already a seen context.
    await d.insert(findings).values({ id: randomUUID(), reviewId: null, repo, prId: "prior", commitSha: "a", filePath: "src/app/old.ts", lineStart: 1, lineEnd: 1, category: "correctness", patternId, severity: "warning", message: "prior", messageHash: randomUUID(), status: "suppressed" });

    await runOneReview("probe:seen-context", "src/app/new.ts", 10);
    const rows = await findingsForPattern(patternId);
    const newFinding = rows.find((r) => r.filePath === "src/app/new.ts");
    expect(newFinding?.status).toBe("suppressed");
    expect(await probedEvents(patternId)).toHaveLength(0);
  });

  it("max 1 probe per pattern per 30 days: a recent probe suppresses the next new-context re-flag", async () => {
    const d = db;
    if (d === undefined) throw new Error("db not initialized");
    const patternId = await seedActiveIgnoreRule("probe:rate-limit");
    // A probe was claimed 5 days ago — inside the 30d window, so the atomic
    // rate-limit claim fails and the new-context re-flag stays suppressed.
    await d
      .update(repoRules)
      .set({ lastProbedAt: new Date(Date.now() - 5 * 86_400_000) })
      .where(eq(repoRules.patternId, patternId));

    await runOneReview("probe:rate-limit", "src/other/ctx.ts", 10);
    const rows = await findingsForPattern(patternId);
    // New context, but the 30d window already has a probe -> suppressed.
    const reflag = rows.find((r) => r.filePath === "src/other/ctx.ts");
    expect(reflag?.status).toBe("suppressed");
    // No new probe event was recorded for it.
    expect(
      (
        await d
          .select()
          .from(learningEvents)
          .where(and(eq(learningEvents.eventType, "pattern.probed"), eq(learningEvents.aggregateId, `pattern:${patternId}`)))
      ).length,
    ).toBe(0);
  });

  it("rate-limit claim is atomic: a second concurrent probe of the same pattern is rejected", async () => {
    const d = db;
    if (d === undefined) throw new Error("db not initialized");
    const patternId = await seedActiveIgnoreRule("probe:atomic");
    const base: Finding = { filePath: "src/a/dir.ts", lineStart: 1, lineEnd: 1, category: "correctness", patternId: "probe:atomic", patternUuid: patternId, severity: "warning", message: "m" };
    // Two copies of the same pattern in one review -> only one probe.
    const first = await selectProbeCandidates(d, { probeIntervalDays: 30 }, new Date(), [base, { ...base, patternUuid: patternId }]);
    expect(first).toHaveLength(1);
    // A second review (new context, same pattern) inside the window is
    // rate-limited by the atomic claim — it must not produce a second probe.
    const second = await selectProbeCandidates(d, { probeIntervalDays: 30 }, new Date(), [{ ...base, filePath: "src/b/dir.ts" }]);
    expect(second).toHaveLength(0);
  });
});
