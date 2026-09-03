import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema.ts";
import { findings, patterns, repoRules } from "../src/db/schema.ts";
import { formatRule, getReviewLearningContext, renderRules, type ReviewLearningContext, type RulePayload } from "../src/learning/retrieval/retrieval.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();
const repo = "owner/repo";

type RuleRow = typeof repoRules.$inferSelect;

function makeRule(ruleType: string, patternId: string | null, payload: RulePayload, glob?: string | null): RuleRow {
  return {
    id: randomUUID(),
    repo,
    ruleType,
    patternId,
    payload,
    payloadHash: "h",
    glob: glob ?? null,
    status: "active",
    confidence: "0.9",
    evidenceCount: 5,
    positiveCount: 0,
    negativeCount: 5,
    firstObservedAt: new Date(),
    lastObservedAt: new Date(),
    lastProbedAt: null,
    createdBy: "auto:learning",
    createdAt: new Date(),
    deactivatedAt: null,
  };
}

describe.skipIf(!dockerAvailable)("read model: retrieval + renderRules", () => {
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

  it("renderRules formats and sorts rules deterministically", () => {
    const rules = [makeRule("style", null, { description: "Prefer async/await" }), makeRule("ignore", randomUUID(), { patternKey: "security:jwt-expiration", reason: "noisy" }), makeRule("emphasize", null, { pattern: "input validation" })];
    const a = renderRules(rules);
    const b = renderRules(rules);
    expect(a).toBe(b);
    // ignore sorts first, then style/emphasize by type+glob.
    expect(a).toContain(`- [ignore] Stop flagging "security:jwt-expiration" (noisy)`);
    expect(a).toContain(`- [emphasize] Emphasize "input validation"`);
    expect(a).toContain(`- [style] Prefer async/await`);
  });

  it("formatRule renders each rule type", () => {
    expect(formatRule(makeRule("ignore", null, { patternKey: "p" }))).toBe(`- [ignore] Stop flagging "p"`);
    expect(formatRule(makeRule("emphasize", null, { pattern: "x", reason: "sec" }))).toBe(`- [emphasize] Emphasize "x" (sec)`);
    expect(formatRule(makeRule("scope", null, { pathPrefix: "src/core", reviewDepth: "full" }))).toContain("src/core");
  });

  it("retrieval excludes dismissed patterns from context and memory", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const suppressedPatternId = randomUUID();
    const keptPatternId = randomUUID();
    await db.insert(patterns).values({ id: suppressedPatternId, repo, category: "security", canonicalMessage: "security:jwt-expiration", patternVersion: "v1", status: "active" });
    await db.insert(patterns).values({ id: keptPatternId, repo, category: "performance", canonicalMessage: "performance:n-plus-1", patternVersion: "v1", status: "active" });
    await db.insert(repoRules).values({ repo, ruleType: "ignore", patternId: suppressedPatternId, payload: { patternKey: "security:jwt-expiration", reason: "noisy" }, payloadHash: "h", status: "active", confidence: "0.9", evidenceCount: 5, negativeCount: 5, createdBy: "auto:learning" });

    await db.insert(findings).values({ id: randomUUID(), reviewId: null, repo, prId: "1", commitSha: "a", filePath: "src/a.ts", lineStart: 1, lineEnd: 1, category: "security", patternId: suppressedPatternId, severity: "error", message: "JWT not validated", messageHash: "h1", status: "posted" });
    await db.insert(findings).values({ id: randomUUID(), reviewId: null, repo, prId: "2", commitSha: "a", filePath: "src/b.ts", lineStart: 1, lineEnd: 1, category: "performance", patternId: keptPatternId, severity: "warning", message: "N+1 query", messageHash: "h2", status: "posted" });

    const ctx: ReviewLearningContext = await getReviewLearningContext(db, repo);
    expect(ctx.suppression.patternIds.has(suppressedPatternId)).toBe(true);
    expect(ctx.suppression.patternIds.has(keptPatternId)).toBe(false);
    expect(ctx.rulesText).toContain("security:jwt-expiration");
    // Memory context keeps the non-suppressed pattern, drops the dismissed one.
    expect(ctx.memoryContext).toContain("performance:n-plus-1");
    expect(ctx.memoryContext).not.toContain("security:jwt-expiration");
  });

  it("H2: a manual glob ignore rule (patternId null) lands in suppression.globs", async () => {
    if (db === undefined) throw new Error("db not initialized");
    await db.insert(repoRules).values({ repo, ruleType: "ignore", patternId: null, glob: "generated/**", payload: { reason: "build output" }, payloadHash: "h", status: "active", createdBy: "manual:cli" });

    const ctx: ReviewLearningContext = await getReviewLearningContext(db, repo);
    expect(ctx.suppression.globs).toContain("generated/**");
  });
});
