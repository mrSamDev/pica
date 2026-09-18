import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { loadConfig } from "../src/config.ts";
import * as schema from "../src/db/schema.ts";
import { findings, learningEvents, patterns, postedComments, repoRules, reviews } from "../src/db/schema.ts";
import type { LLMClient } from "../src/llm/client.ts";
import type { PlatformClient } from "../src/platform/types.ts";
import { runReview } from "../src/review/pipeline/pipeline.ts";
import type { Finding, ReviewMode, ReviewRequest, Severity } from "../src/review/types.ts";
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

function makeFindings(count: number): Finding[] {
  const severities: Severity[] = ["error", "warning", "suggestion"];
  return Array.from({ length: count }, (_, i) => ({
    filePath: "src/auth.ts",
    lineStart: 40 + i,
    lineEnd: 40 + i,
    category: "security",
    patternId: `security:pattern-${i}`,
    patternUuid: `security:pattern-${i}`,
    severity: severities[i % 3] ?? "suggestion",
    message: `finding ${i}`,
  }));
}

function makeLlm(findings: Finding[]): LLMClient {
  return { review: async () => JSON.stringify(findings) };
}

// Comment ids must be globally unique across the shared DB (posted_comments
// unique constraint on platform + comment_id), like real platform ids.
let commentSeq = 0;

function makePlatform() {
  const inline: Array<{ repo: string; prId: string; content: string }> = [];
  const pr: Array<{ repo: string; prId: string; content: string }> = [];
  const platform: PlatformClient = {
    async fetchDiff() {
      return DIFF;
    },
    async listComments() {
      return [];
    },
    async createInlineComment(repo, prId, _target, content) {
      inline.push({ repo, prId, content });
      return { id: `i-${++commentSeq}` };
    },
    async createPrComment(repo, prId, content) {
      pr.push({ repo, prId, content });
      return { id: `p-${++commentSeq}` };
    },
    async getCommentState() {
      return { resolved: false, deleted: false, replyCount: 0 };
    },
  };
  return { platform, inline, pr };
}

function makeRequest(reviewId: string, prId: string, mode: ReviewMode, overrides?: Partial<ReviewRequest>): ReviewRequest {
  return {
    reviewId,
    repo: "owner/repo",
    prId,
    commitSha: "abc123",
    platform: "github",
    mode,
    postingCap: 10,
    summaryComment: false,
    ...overrides,
  };
}

describe.skipIf(!dockerAvailable)("pipeline mode gating", () => {
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

  async function seedReview(reviewId: string, mode: ReviewMode): Promise<void> {
    if (db === undefined) throw new Error("db not initialized");
    await db.insert(reviews).values({ id: reviewId, repo: "owner/repo", prId: "42", commitSha: "abc123", status: "running", mode });
  }

  it("observe mode records findings but does not post", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = "11111111-1111-1111-1111-111111111111";
    await seedReview(reviewId, "observe");
    const { platform, inline, pr } = makePlatform();
    const result = await runReview({ db, platform, llm: makeLlm(makeFindings(3)), config, metrics: createFakeMetrics() }, makeRequest(reviewId, "42", "observe"));

    expect(result.posted).toBe(0);
    expect(inline).toHaveLength(0);
    expect(pr).toHaveLength(0);

    const rows = await db.select().from(findings).where(eq(findings.reviewId, reviewId));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === "observed")).toBe(true);
  });

  it("observe mode emits capped summary", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = "22222222-2222-2222-2222-222222222222";
    await seedReview(reviewId, "observe");
    const { platform, inline, pr } = makePlatform();
    const result = await runReview({ db, platform, llm: makeLlm(makeFindings(7)), config, metrics: createFakeMetrics() }, makeRequest(reviewId, "43", "observe", { summaryComment: true }));

    expect(result.posted).toBe(0);
    expect(inline).toHaveLength(0);
    expect(pr).toHaveLength(1);
    const lines = pr[0]?.content.split("\n") ?? [];
    expect(lines[0]).toContain("7 findings detected, showing top 5");
    expect(lines.length - 1).toBe(5);
    // Severity-prioritized: errors first.
    expect(lines[1]).toContain("[error]");
  });

  it("post mode posts comments", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = "33333333-3333-3333-3333-333333333333";
    await seedReview(reviewId, "post");
    const { platform, inline, pr } = makePlatform();
    const result = await runReview({ db, platform, llm: makeLlm(makeFindings(3)), config, metrics: createFakeMetrics() }, makeRequest(reviewId, "44", "post"));

    expect(result.posted).toBe(3);
    expect(inline).toHaveLength(3);
    expect(pr).toHaveLength(0);

    const rows = await db.select().from(findings).where(eq(findings.reviewId, reviewId));
    expect(rows.every((row) => row.status === "posted")).toBe(true);
  });

  it("post mode with zero findings posts one clean comment", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = "99999999-9999-9999-9999-999999999999";
    await seedReview(reviewId, "post");
    const { platform, inline, pr } = makePlatform();
    const result = await runReview({ db, platform, llm: makeLlm([]), config, metrics: createFakeMetrics() }, makeRequest(reviewId, "54", "post"));

    expect(result.posted).toBe(0);
    expect(inline).toHaveLength(0);
    expect(pr).toHaveLength(1);
    expect(pr[0]?.content).toBe("Review complete. No new findings on this diff. Everything looks fine.");

    // A worker retry must not post the clean comment twice.
    await runReview({ db, platform, llm: makeLlm([]), config, metrics: createFakeMetrics() }, makeRequest(reviewId, "54", "post"));
    expect(pr).toHaveLength(1);
  });

  it("dry-run mode prints findings, posts nothing", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = "44444444-4444-4444-4444-444444444444";
    await seedReview(reviewId, "dry-run");
    const { platform, inline, pr } = makePlatform();
    const result = await runReview({ db, platform, llm: makeLlm(makeFindings(3)), config, metrics: createFakeMetrics() }, makeRequest(reviewId, "45", "dry-run"));

    expect(result.findings).toHaveLength(3);
    expect(result.posted).toBe(0);
    expect(inline).toHaveLength(0);
    expect(pr).toHaveLength(0);
    // dry-run makes no DB writes.
    const rows = await db.select().from(findings).where(eq(findings.reviewId, reviewId));
    expect(rows).toHaveLength(0);
  });

  it("per-repo posting cap enforced in post mode", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = "55555555-5555-5555-5555-555555555555";
    await seedReview(reviewId, "post");
    const { platform, inline, pr } = makePlatform();
    const result = await runReview({ db, platform, llm: makeLlm(makeFindings(5)), config, metrics: createFakeMetrics() }, makeRequest(reviewId, "46", "post", { postingCap: 2 }));

    expect(result.posted).toBe(2);
    expect(inline).toHaveLength(2);
    expect(pr).toHaveLength(0);

    const rows = await db.select().from(findings).where(eq(findings.reviewId, reviewId));
    expect(rows.filter((row) => row.status === "posted")).toHaveLength(2);
    expect(rows.filter((row) => row.status === "capped")).toHaveLength(3);
  });

  it("identity seam: real DB pattern resolution drives suppression", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const patternUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const reviewId = "66666666-6666-6666-6666-666666666666";
    await seedReview(reviewId, "post");

    // Seed the pattern + an active ignore rule referencing it by uuid.
    await db.insert(patterns).values({ id: patternUuid, repo: "owner/repo", category: "correctness", canonicalMessage: "correctness:jwt-expiration", patternVersion: "v1", status: "active" });
    await db.insert(repoRules).values({ repo: "owner/repo", ruleType: "ignore", patternId: patternUuid, payload: { reason: "test" }, payloadHash: "h", status: "active" });
    // A prior finding in src/ means the glob context is seen, so §5.7 probing
    // does not fire here and the finding is suppressed deterministically.
    await db
      .insert(findings)
      .values({ id: randomUUID(), reviewId: null, repo: "owner/repo", prId: "47b", commitSha: "prior", filePath: "src/auth.ts", lineStart: 40, lineEnd: 40, category: "correctness", patternId: patternUuid, severity: "warning", message: "prior", messageHash: "prior-h", status: "posted" });

    // LLM returns a finding whose string patternId resolves to the seeded pattern.
    const finding: Finding = { filePath: "src/auth.ts", lineStart: 40, lineEnd: 40, category: "correctness", patternId: "correctness:jwt-expiration", patternUuid: "", severity: "warning", message: "JWT expiration isn't validated." };
    const { platform } = makePlatform();
    await runReview({ db, platform, llm: makeLlm([finding]), config, metrics: createFakeMetrics() }, makeRequest(reviewId, "47", "post"));

    const rows = await db.select().from(findings).where(eq(findings.reviewId, reviewId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("suppressed");
    expect(rows[0]?.patternId).toBe(patternUuid);
  });

  it("H2: a manual glob ignore rule suppresses findings under the glob, persists suppressed, and never probes", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = "88888888-8888-8888-8888-888888888888";
    await seedReview(reviewId, "post");

    // Manual ignore rule scoped to a glob, no pattern id.
    await db.insert(repoRules).values({ repo: "owner/repo", ruleType: "ignore", patternId: null, glob: "generated/**", payload: { reason: "build output" }, payloadHash: "h", status: "active" });

    const finding: Finding = { filePath: "generated/out.js", lineStart: 1, lineEnd: 1, category: "correctness", patternId: "correctness:dead-code", patternUuid: "", severity: "warning", message: "unused variable" };
    const { platform, inline } = makePlatform();
    const result = await runReview({ db, platform, llm: makeLlm([finding]), config, metrics: createFakeMetrics() }, makeRequest(reviewId, "51", "post"));

    // The finding was dropped by the glob rule and persisted, not posted, and
    // the glob path was NOT promoted to an ε-probe (manual ignores own the
    // path; probing it would defeat the human override).
    expect(result.posted).toBe(0);
    expect(inline).toHaveLength(0);
    const rows = await db.select().from(findings).where(eq(findings.reviewId, reviewId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("suppressed");
    expect(rows[0]?.filePath).toBe("generated/out.js");

    const probes = await db.select().from(learningEvents).where(eq(learningEvents.eventType, "pattern.probed"));
    expect(probes).toHaveLength(0);
  });

  it("identity seam: real DB pattern resolution drives cross-commit dedup", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const patternUuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const reviewId = "77777777-7777-7777-7777-777777777777";
    await seedReview(reviewId, "post");

    await db.insert(patterns).values({ id: patternUuid, repo: "owner/repo", category: "security", canonicalMessage: "security:complexity", patternVersion: "v1", status: "active" });
    // A prior finding on commit A for the same pattern at the same lines.
    await db.insert(findings).values({ id: randomUUID(), reviewId, repo: "owner/repo", prId: "48", commitSha: "commitA", filePath: "src/auth.ts", lineStart: 40, lineEnd: 40, category: "security", patternId: patternUuid, severity: "warning", message: "prior", messageHash: "h", status: "posted" });

    // Commit B re-flags the same pattern at the same lines -> cross-commit drop.
    const finding: Finding = { filePath: "src/auth.ts", lineStart: 40, lineEnd: 40, category: "security", patternId: "security:complexity", patternUuid: "", severity: "warning", message: "complexity" };
    const { platform } = makePlatform();
    await runReview({ db, platform, llm: makeLlm([finding]), config, metrics: createFakeMetrics() }, makeRequest(reviewId, "48", "post", { commitSha: "commitB" }));

    const rows = await db.select().from(findings).where(eq(findings.reviewId, reviewId));
    // The prior finding (commit A) + the dropped cross-commit finding (commit B).
    expect(rows).toHaveLength(2);
    const dropped = rows.find((row) => row.message === "complexity");
    expect(dropped?.status).toBe("duplicate");
  });

  it("§4: same-commit retry re-posts instead of dropping everything (crash between insert and post)", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = randomUUID();
    const prId = "49";
    await seedReview(reviewId, "post");

    // Simulate attempt 1 crashing after the finding-insert transaction but
    // before any comment posted: rows exist (status pending, no posted_comments).
    const seeded = makeFindings(3);
    for (const f of seeded) {
      await db.insert(findings).values({
        id: randomUUID(),
        reviewId,
        repo: "owner/repo",
        prId,
        commitSha: "abc123",
        filePath: f.filePath,
        lineStart: f.lineStart,
        lineEnd: f.lineEnd,
        category: f.category,
        patternId: null,
        severity: f.severity,
        message: f.message,
        messageHash: createHash("sha256").update(f.message).digest("hex"),
        status: "pending",
      });
    }

    // The retry re-runs the same review on the same commit: the own rows from
    // attempt 1 must not be treated as cross-commit priors, and the retry must
    // post to the existing finding rows rather than report posted: 0.
    const { platform } = makePlatform();
    const result = await runReview({ db, platform, llm: makeLlm(makeFindings(3)), config, metrics: createFakeMetrics() }, makeRequest(reviewId, prId, "post"));
    expect(result.posted).toBe(3);

    const rows = await db.select().from(findings).where(eq(findings.prId, prId));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "posted")).toBe(true);
    const commentIds = (await db.select().from(postedComments)).filter((c) => rows.some((r) => r.id === c.findingId));
    expect(commentIds).toHaveLength(3);
    expect(commentIds.every((c) => c.commentId !== "")).toBe(true);
  });

  it("§4: a partial platform post failure persists already-posted links so a retry never duplicates", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = randomUUID();
    const prId = "50";
    await seedReview(reviewId, "post");
    const inputFindings = makeFindings(3);

    // Attempt 1: the platform posts finding 0, then the post for finding 1
    // throws (severity order posts error, warning, suggestion).
    let calls = 0;
    const attempt1: Array<{ content: string }> = [];
    const platform: PlatformClient = {
      fetchDiff: async () => DIFF,
      listComments: async () => [],
      createPrComment: async () => ({ id: `p-${++commentSeq}` }),
      getCommentState: async () => ({ resolved: false, deleted: false, replyCount: 0 }),
      async createInlineComment(_repo, _prId, _target, content) {
        calls++;
        if (calls === 2) throw new Error("platform down");
        attempt1.push({ content });
        return { id: `i-${++commentSeq}` };
      },
    };
    await expect(runReview({ db, platform, llm: makeLlm(inputFindings), config, metrics: createFakeMetrics() }, makeRequest(reviewId, prId, "post"))).rejects.toThrow("platform down");
    expect(attempt1).toHaveLength(1); // finding 0 posted, finding 1 post failed

    // Retry on a healthy platform. The already-posted finding 0 link must be
    // reused from the DB, so only the two un-posted findings get fresh posts.
    const { platform: platform2, inline: inline2 } = makePlatform();
    const result = await runReview({ db, platform: platform2, llm: makeLlm(inputFindings), config, metrics: createFakeMetrics() }, makeRequest(reviewId, prId, "post"));
    expect(result.posted).toBe(3);
    expect(inline2).toHaveLength(2); // finding 0 reused, not re-posted

    const rows = await db.select().from(findings).where(eq(findings.prId, prId));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "posted")).toBe(true);
    // No comment body appears twice across both attempts.
    const contents = [...attempt1, ...inline2].map((c) => c.content);
    for (const content of contents) {
      expect(contents.filter((c) => c === content)).toHaveLength(1);
    }
  });
});
