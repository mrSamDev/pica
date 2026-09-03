import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema.ts";
import { findings, learningEvents, patterns, repoRules } from "../src/db/schema.ts";
import { runLearner, type LearnerOptions } from "../src/learning/learner/learner.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();
const repo = "owner/repo";
const PROTECTED = new Set(["security", "data", "concurrency"]);

const opts = (overrides?: Partial<LearnerOptions>): LearnerOptions => ({
  minEvidence: 3,
  activationThreshold: 0.7,
  severityWeights: { error: 3, warning: 2, suggestion: 1 },
  protectedCategories: PROTECTED,
  ...overrides,
});

async function seedErrorPattern(db: NodePgDatabase<typeof schema>, category: string, count: number): Promise<{ patternId: string; findingIds: string[] }> {
  const patternId = randomUUID();
  const prId = randomUUID();
  await db.insert(patterns).values({ id: patternId, repo, category, canonicalMessage: `${category}:error-pattern:${randomUUID()}`, patternVersion: "v1", status: "active" });
  const findingIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const findingId = randomUUID();
    await db.insert(findings).values({ id: findingId, reviewId: null, repo, prId, commitSha: "abc", filePath: "src/a.ts", lineStart: i, lineEnd: i, category, patternId, severity: "error", message: `e${i}`, messageHash: `h${i}`, status: "posted" });
    await db.insert(schema.findingOutcomes).values({ findingId, status: "dismissed", dismissalReason: "fp" });
    findingIds.push(findingId);
  }
  return { patternId, findingIds };
}

async function confirm(db: NodePgDatabase<typeof schema>, findingId: string): Promise<void> {
  await db.insert(learningEvents).values({ eventKey: `finding:${findingId}:dismissal_confirmed`, repo, eventType: "finding.dismissal_confirmed", aggregateId: `finding:${findingId}`, payload: { findingId, confirmedBy: "test" } });
}

async function getRule(db: NodePgDatabase<typeof schema>, patternId: string) {
  const rows = await db.select().from(repoRules).where(eq(repoRules.patternId, patternId));
  return rows[0];
}

describe.skipIf(!dockerAvailable)("§5.5 guardrails: protected categories + human routing", () => {
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

  it("a dismissed error in a protected category never produces an auto-ignore rule", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const { patternId, findingIds } = await seedErrorPattern(db, "security", 3);
    // 3 error dismissals would normally exceed the gate; the guard refuses.
    const result = await runLearner(db, { findingId: findingIds[0]!, repo }, opts());
    expect(result.stage).toBe("none");
    expect(result.protectedBlocked).toBe(true);
    expect(await getRule(db, patternId)).toBeUndefined();
  });

  it("each protected category blocks auto-suppression of severity=error", async () => {
    if (db === undefined) throw new Error("db not initialized");
    // The six §5.5 items map onto the taxonomy categories: secrets/auth/crypto/
    // injection under security, data-loss under data, concurrency itself.
    for (const category of ["security", "data", "concurrency"]) {
      const { patternId, findingIds } = await seedErrorPattern(db, category, 3);
      const result = await runLearner(db, { findingId: findingIds[0]!, repo }, opts());
      expect(result.stage, `category ${category}`).toBe("none");
      expect(await getRule(db, patternId), `category ${category}`).toBeUndefined();
    }
  });

  it("the guard is severity-scoped: suggestions in a protected category still form a rule", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const patternId = randomUUID();
    await db.insert(patterns).values({ id: patternId, repo, category: "security", canonicalMessage: "security:noise", patternVersion: "v1", status: "active" });
    const findingId = randomUUID();
    await db.insert(findings).values({ id: findingId, reviewId: null, repo, prId: randomUUID(), commitSha: "abc", filePath: "src/b.ts", lineStart: 0, lineEnd: 0, category: "security", patternId, severity: "suggestion", message: "noise", messageHash: "n", status: "posted" });
    await db.insert(schema.findingOutcomes).values({ findingId, status: "dismissed" });

    const result = await runLearner(db, { findingId, repo }, opts({ minEvidence: 1, activationThreshold: 0.2 }));
    expect(result.stage).not.toBe("none");
    expect(await getRule(db, patternId)).toBeDefined();
  });

  it("a dismissed error is not evidence until a human confirms it", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const { patternId, findingIds } = await seedErrorPattern(db, "correctness", 3);
    // 3 unconfirmed error dismissals: not evidence -> no rule at all.
    const result = await runLearner(db, { findingId: findingIds[0]!, repo }, opts());
    expect(result.stage).toBe("none");
    expect(await getRule(db, patternId)).toBeUndefined();

    // After human confirmation the loop absorbs them (3 errors * weight 3).
    for (const findingId of findingIds) await confirm(db, findingId);
    const after = await runLearner(db, { findingId: findingIds[0]!, repo }, opts());
    expect(after.stage).not.toBe("none");
    const rule = await getRule(db, patternId);
    expect(Number(rule?.negativeCount)).toBeCloseTo(9);
  });

  it("partial confirmation counts only the confirmed errors", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const { patternId, findingIds } = await seedErrorPattern(db, "correctness", 3);
    // Confirm only one of three; the other two stay unconfirmed.
    await confirm(db, findingIds[0]!);
    const result = await runLearner(db, { findingId: findingIds[0]!, repo }, opts());
    expect(result.stage).not.toBe("none");
    const rule = await getRule(db, patternId);
    // One confirmed error of weight 3 -> negative 3, not 9.
    expect(Number(rule?.negativeCount)).toBeCloseTo(3);
  });
});
