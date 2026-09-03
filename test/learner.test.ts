import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema.ts";
import { findings, learningEvents, patterns, repoRules, ruleEvidence } from "../src/db/schema.ts";
import { betaConfidence, decideStage, runLearner, severityWeight, type LearnerOptions } from "../src/learning/learner/learner.ts";
import type { Severity } from "../src/review/types.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();

const opts = (minEvidence: number, activationThreshold: number): LearnerOptions => ({
  minEvidence,
  activationThreshold,
  severityWeights: { error: 3, warning: 2, suggestion: 1 },
});

const repo = "owner/repo";

describe.skipIf(!dockerAvailable)("learner confidence math", () => {
  it("Beta confidence is (neg+2)/(generated+4), not a raw ratio", () => {
    expect(betaConfidence(5, 7)).toBeCloseTo(7 / 11);
    expect(betaConfidence(3, 3)).toBeCloseTo(5 / 7);
    expect(betaConfidence(0, 0)).toBeCloseTo(2 / 4);
  });

  it("min-evidence gate + threshold drive candidate -> active progression", () => {
    const o = opts(5, 0.8);
    // generated < 5 -> no rule at all (gate).
    expect(decideStage({ generated: 4, negative: 4, positive: 0, confidence: betaConfidence(4, 4) }, o)).toBe("none");
    // generated 5 -> candidate (confidence 7/9 < 0.8).
    expect(decideStage({ generated: 5, negative: 5, positive: 0, confidence: betaConfidence(5, 5) }, o)).toBe("candidate");
    // generated 6 -> active (confidence 8/10 = 0.8).
    expect(decideStage({ generated: 6, negative: 6, positive: 0, confidence: betaConfidence(6, 6) }, o)).toBe("active");
  });

  it("severity weighting: a dismissed error counts more than a suggestion", () => {
    const w = opts(3, 0.7).severityWeights;
    expect(severityWeight("error", w)).toBeGreaterThan(severityWeight("suggestion", w));
    expect(severityWeight("warning", w)).toBe(2);
    expect(severityWeight("error", w)).toBe(3);
    expect(severityWeight("suggestion", w) * 3).toBe(3);
  });
});

describe.skipIf(!dockerAvailable)("learner orchestration", () => {
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

  interface FindingSpec {
    severity: Severity;
    outcome: "dismissed" | "resolved" | "replied";
    reason?: string;
  }

  async function seedPattern(specs: FindingSpec[], canonicalMessage: string): Promise<{ patternId: string; findingId: string }> {
    if (db === undefined) throw new Error("db not initialized");
    const patternId = randomUUID();
    const prId = randomUUID();
    await db.insert(patterns).values({ id: patternId, repo, category: "security", canonicalMessage, patternVersion: "v1", status: "active" });
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      if (!spec) continue;
      const fid = randomUUID();
      await db.insert(findings).values({ id: fid, reviewId: null, repo, prId, commitSha: "abc", filePath: "src/a.ts", lineStart: i, lineEnd: i, category: "security", patternId, severity: spec.severity, message: `m${i}`, messageHash: `h${i}`, status: "posted" });
      await db.insert(schema.findingOutcomes).values({ findingId: fid, status: spec.outcome, dismissalReason: spec.reason });
    }
    // Re-query the first finding id so the learner input is always valid.
    const first = await db.select({ id: findings.id }).from(findings).where(eq(findings.patternId, patternId)).limit(1);
    const findingId = first[0]?.id;
    if (!findingId) throw new Error("seed produced no finding");
    return { patternId, findingId };
  }

  async function getRule(patternId: string) {
    if (db === undefined) throw new Error("db not initialized");
    const rows = await db.select().from(repoRules).where(eq(repoRules.patternId, patternId));
    return rows[0];
  }

  async function getEvents(patternId: string) {
    if (db === undefined) throw new Error("db not initialized");
    return db
      .select()
      .from(learningEvents)
      .where(eq(learningEvents.aggregateId, `pattern:${patternId}`));
  }

  it("dismiss 3x -> a candidate rule forms (threshold not yet crossed)", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const { patternId, findingId } = await seedPattern(
      [
        { severity: "suggestion", outcome: "dismissed", reason: "noisy" },
        { severity: "suggestion", outcome: "dismissed" },
        { severity: "suggestion", outcome: "dismissed" },
      ],
      "security:noisy-pattern",
    );
    // minEvidence 3, high threshold: 3 weight-1 dismissals cross the gate but
    // confidence 5/7 is below 0.9 -> candidate, not active.
    await runLearner(db, { findingId, repo }, opts(3, 0.9));

    const rule = await getRule(patternId);
    expect(rule).toBeDefined();
    expect(rule?.status).toBe("candidate");
    expect(Number(rule?.negativeCount)).toBe(3);

    const events = await getEvents(patternId);
    expect(events.some((e) => e.eventType === "rule.candidate")).toBe(true);
    expect(events.some((e) => e.eventType === "rule.activated")).toBe(false);
  });

  it("dismiss 3x with default threshold forms an ACTIVE rule (closes the loop, §14)", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const { patternId, findingId } = await seedPattern(
      [
        { severity: "suggestion", outcome: "dismissed", reason: "noisy" },
        { severity: "suggestion", outcome: "dismissed" },
        { severity: "suggestion", outcome: "dismissed" },
      ],
      "security:active-pattern",
    );
    // Defaults: minEvidence 3, threshold 0.7. 3 weight-1 dismissals -> 5/7 ~ 0.71 >= 0.7.
    await runLearner(db, { findingId, repo }, opts(3, 0.7));

    const rule = await getRule(patternId);
    expect(rule?.status).toBe("active");
    const events = await getEvents(patternId);
    expect(events.some((e) => e.eventType === "rule.activated")).toBe(true);

    const evidence = await db
      .select()
      .from(ruleEvidence)
      .where(eq(ruleEvidence.ruleId, rule?.id ?? ""));
    expect(evidence.length).toBe(3);
  });

  it("replies are NOT positive evidence: replied 3x forms no rule (§14)", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const { patternId, findingId } = await seedPattern(
      [
        { severity: "warning", outcome: "replied" },
        { severity: "warning", outcome: "replied" },
        { severity: "warning", outcome: "replied" },
      ],
      "security:replied-pattern",
    );
    await runLearner(db, { findingId, repo }, opts(3, 0.7));
    expect(await getRule(patternId)).toBeUndefined();
  });

  it("severity weighting: one error dismissal reaches the gate that three suggestions also reach", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const { patternId, findingId } = await seedPattern([{ severity: "error", outcome: "dismissed", reason: "false positive" }], "security:error-pattern");
    const result = await runLearner(db, { findingId, repo }, opts(3, 0.7));
    expect(result.stage).not.toBe("none");
    const rule = await getRule(patternId);
    expect(Number(rule?.negativeCount)).toBeCloseTo(3);
    // SAFETY: the learner writes repo_rules.payload with a `reason` field.
    expect((rule?.payload as { reason?: string })?.reason).toBe("false positive");
  });

  it("candidate promotes to active when confidence crosses the threshold on new evidence", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const d = db;
    const patternId = randomUUID();
    const prId = randomUUID();
    await d.insert(patterns).values({ id: patternId, repo, category: "security", canonicalMessage: "security:promote", patternVersion: "v1", status: "active" });

    async function seedFinding(i: number, severity: Severity): Promise<string> {
      const fid = randomUUID();
      await d.insert(findings).values({ id: fid, reviewId: null, repo, prId, commitSha: "abc", filePath: "src/a.ts", lineStart: i, lineEnd: i, category: "security", patternId, severity, message: `promote-${i}`, messageHash: `p${i}`, status: "posted" });
      await d.insert(schema.findingOutcomes).values({ findingId: fid, status: "dismissed" });
      return fid;
    }

    // 3 suggestion dismissals (weight 1 each): confidence 5/7 ~ 0.71, below 0.8.
    const first = await seedFinding(1, "suggestion");
    await seedFinding(2, "suggestion");
    await seedFinding(3, "suggestion");
    await runLearner(db, { findingId: first, repo }, opts(3, 0.8));
    expect((await getRule(patternId))?.status).toBe("candidate");
    expect((await getEvents(patternId)).some((e) => e.eventType === "rule.candidate")).toBe(true);

    // A 4th ERROR dismissal (weight 3) pushes gen/neg to 6 -> confidence 8/10=0.8.
    const fourth = await seedFinding(4, "error");
    await runLearner(db, { findingId: fourth, repo }, opts(3, 0.8));

    const rule = await getRule(patternId);
    expect(rule?.status).toBe("active");
    const events = await getEvents(patternId);
    expect(events.filter((e) => e.eventType === "rule.candidate")).toHaveLength(1);
    expect(events.filter((e) => e.eventType === "rule.activated")).toHaveLength(1);
  });

  it("active rules never demote to candidate on weak new evidence", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const { patternId, findingId } = await seedPattern(
      [
        { severity: "suggestion", outcome: "dismissed" },
        { severity: "suggestion", outcome: "dismissed" },
        { severity: "suggestion", outcome: "dismissed" },
      ],
      "security:stay-active",
    );
    await runLearner(db, { findingId, repo }, opts(3, 0.7));
    expect((await getRule(patternId))?.status).toBe("active");

    // A later resolved finding lowers confidence ((neg+2)/(generated+4)) but
    // must not demote the active rule; decay is Phase 5.
    const resolvedId = randomUUID();
    await db.insert(findings).values({ id: resolvedId, reviewId: null, repo, prId: randomUUID(), commitSha: "abc", filePath: "src/a.ts", lineStart: 9, lineEnd: 9, category: "security", patternId, severity: "suggestion", message: "resolved1", messageHash: "r1", status: "posted" });
    await db.insert(schema.findingOutcomes).values({ findingId: resolvedId, status: "resolved" });
    await runLearner(db, { findingId: resolvedId, repo }, opts(3, 0.7));

    expect((await getRule(patternId))?.status).toBe("active");
  });

  it("idempotent: re-running on the same data does not duplicate the rule or events", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const { patternId, findingId } = await seedPattern(
      [
        { severity: "suggestion", outcome: "dismissed" },
        { severity: "suggestion", outcome: "dismissed" },
        { severity: "suggestion", outcome: "dismissed" },
      ],
      "security:idempotent-pattern",
    );
    await runLearner(db, { findingId, repo }, opts(3, 0.7));
    await runLearner(db, { findingId, repo }, opts(3, 0.7));

    const rules = await db.select().from(repoRules).where(eq(repoRules.patternId, patternId));
    expect(rules).toHaveLength(1);
    const events = await getEvents(patternId);
    expect(events.filter((e) => e.eventType === "rule.activated")).toHaveLength(1);
  });
});
