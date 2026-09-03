import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema.ts";
import { findings, findingOutcomes, learningEvents, patterns, repoRules, ruleEvidence } from "../src/db/schema.ts";
import { projectEvents, type EventInput } from "../src/learning/events/replay.ts";
import { rebuildReadModel } from "../src/learning/retrieval/rebuild.ts";
import { addManualRule, retireManualRule } from "../src/learning/rules/manual.ts";
import { mergePatterns } from "../src/learning/patterns/merge.ts";
import { runLearner } from "../src/learning/learner/learner.ts";
import { getReviewLearningContext } from "../src/learning/retrieval/retrieval.ts";
import { selectProbeCandidates } from "../src/learning/retrieval/probes.ts";
import type { Finding } from "../src/review/types.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();

const opts = { minEvidence: 3, activationThreshold: 0.7, severityWeights: { error: 3, warning: 2, suggestion: 1 }, protectedCategories: new Set(["security", "data", "concurrency"]) };

interface RuleComparable {
  id: string;
  repo: string;
  ruleType: string;
  patternId: string | null;
  glob: string | null;
  payload: unknown;
  status: string;
  confidence: number | null;
  evidenceCount: number;
  positiveCount: number;
  negativeCount: number;
  createdBy: string | null;
  createdAt: string;
  deactivatedAt: string | null;
}

// The learner bumps lastObservedAt on retired rules without eventing it (a
// phase-3 behavior this phase must not change), so retired rules compare
// without that field.
function ruleComparable(row: typeof repoRules.$inferSelect): RuleComparable {
  return {
    id: row.id,
    repo: row.repo,
    ruleType: row.ruleType,
    patternId: row.patternId,
    glob: row.glob,
    payload: row.payload,
    status: row.status,
    confidence: row.confidence === null ? null : Number(row.confidence),
    evidenceCount: row.evidenceCount ?? 0,
    positiveCount: row.positiveCount ?? 0,
    negativeCount: row.negativeCount ?? 0,
    createdBy: row.createdBy,
    // createdAt is part of convergence: a rebuild that let the DB default it
    // would shift rule ordering (resolveRuleId picks oldest per pattern).
    createdAt: (row.createdAt ?? new Date(0)).toISOString(),
    deactivatedAt: row.deactivatedAt ? row.deactivatedAt.toISOString() : null,
  };
}

async function snapshotRules(db: NodePgDatabase<typeof schema>, repo: string): Promise<Map<string, RuleComparable>> {
  const rows = await db.select().from(repoRules).where(eq(repoRules.repo, repo));
  return new Map(rows.map((r) => [r.id, ruleComparable(r)]));
}

async function snapshotEvidence(db: NodePgDatabase<typeof schema>, repo: string): Promise<Array<[string, string, string]>> {
  const rows = await db.select({ ruleId: ruleEvidence.ruleId, findingId: ruleEvidence.findingId, outcome: ruleEvidence.outcome }).from(ruleEvidence).innerJoin(repoRules, eq(repoRules.id, ruleEvidence.ruleId)).where(eq(repoRules.repo, repo));
  // SAFETY: rule_id and finding_id are NOT NULL in the join above (inner join
  // on repo_rules.id = rule_evidence.rule_id), so the non-null assertions hold.
  return rows.map((r) => [r.ruleId!, r.findingId!, r.outcome] as [string, string, string]).sort();
}

describe.skipIf(!dockerAvailable)("rebuild read model (§5.9: disposable projection)", () => {
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

  // Seed one pattern with `count` dismissed findings and run the real learner
  // over it, so rules come from the real write path with real events.
  async function seedLearnedPattern(repo: string, key: string, count: number): Promise<string> {
    if (db === undefined) throw new Error("db not initialized");
    const patternId = randomUUID();
    await db.insert(patterns).values({ id: patternId, repo, category: "security", canonicalMessage: `security:${key}`, patternVersion: "v1", status: "active" });
    let firstFindingId: string | null = null;
    for (let i = 0; i < count; i++) {
      const findingId = randomUUID();
      if (i === 0) firstFindingId = findingId;
      await db.insert(findings).values({ id: findingId, reviewId: null, repo, prId: "11", commitSha: "abc", filePath: "src/a.ts", lineStart: i, lineEnd: i, category: "security", patternId, severity: "suggestion", message: `m${key}${i}`, messageHash: `h${key}${i}`, status: "posted" });
      await db.insert(findingOutcomes).values({ findingId, status: "dismissed", dismissalReason: "noisy" });
    }
    await runLearner(db, { findingId: firstFindingId!, repo }, opts);
    return patternId;
  }

  it("rebuilds the same rules + evidence from the event log, twice (idempotent)", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const repo = "rebuild/converge";

    await seedLearnedPattern(repo, "active-rule", 3);
    await addManualRule(db, { repo, ruleType: "ignore", glob: "generated/**", payload: { reason: "build output" } });
    const retired = await addManualRule(db, { repo, ruleType: "ignore", glob: "vendor/**", payload: { reason: "vendored" } });
    await retireManualRule(db, { repo, ruleId: retired.ruleId, retiredBy: "sam" });

    const liveRules = await snapshotRules(db, repo);
    const liveEvidence = await snapshotEvidence(db, repo);
    expect(liveRules.size).toBeGreaterThanOrEqual(3);

    const logBefore = await db.select({ key: learningEvents.eventKey, type: learningEvents.eventType }).from(learningEvents).orderBy(learningEvents.eventKey);
    const contextBefore = await getReviewLearningContext(db, repo);

    const first = await rebuildReadModel(db);
    expect(first.rules).toBe(liveRules.size);

    const rulesAfter = await snapshotRules(db, repo);
    expect([...rulesAfter.keys()].sort()).toEqual([...liveRules.keys()].sort());
    for (const [id, expected] of liveRules) {
      expect(rulesAfter.get(id)).toEqual(expected);
    }
    expect(await snapshotEvidence(db, repo)).toEqual(liveEvidence);

    // The log is history: a rebuild never touches it.
    const logAfter = await db.select({ key: learningEvents.eventKey, type: learningEvents.eventType }).from(learningEvents).orderBy(learningEvents.eventKey);
    expect(logAfter).toEqual(logBefore);

    const contextAfter = await getReviewLearningContext(db, repo);
    expect(contextAfter.rulesText).toBe(contextBefore.rulesText);
    expect(contextAfter.suppressedPatternIds).toEqual(contextBefore.suppressedPatternIds);

    // Second rebuild is a no-op by construction.
    const second = await rebuildReadModel(db);
    expect(second.rules).toBe(first.rules);
    expect(await snapshotRules(db, repo)).toEqual(rulesAfter);
  });

  it("converges under shuffled event orderings (the real §9 property)", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const repo = "rebuild/shuffled";
    await seedLearnedPattern(repo, "shuffled-rule", 3);
    await addManualRule(db, { repo, ruleType: "ignore", glob: "gen/**", payload: { reason: "r" } });

    const liveRules = await snapshotRules(db, repo);

    // Shuffle at the SQL level: fetch this repo's events in random order and fold.
    for (let round = 0; round < 5; round++) {
      const events = await db
        .select({ eventType: learningEvents.eventType, aggregateId: learningEvents.aggregateId, repo: learningEvents.repo, payload: learningEvents.payload })
        .from(learningEvents)
        .where(eq(learningEvents.repo, repo))
        .orderBy(sql`random()`);
      // SAFETY: the selected columns match EventInput's shape exactly
      // (eventType, aggregateId, repo, payload).
      const folded = projectEvents(events as EventInput[]);
      expect(folded.rules.map((r) => r.ruleId).sort()).toEqual([...liveRules.keys()].sort());
    }

    await rebuildReadModel(db);
    expect(await snapshotRules(db, repo)).toEqual(liveRules);
  });

  it("manual add + manual retire survive a rebuild (§5.3 human edits in the log)", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const repo = "rebuild/manual";
    const added = await addManualRule(db, { repo, ruleType: "ignore", glob: "dist/**", payload: { reason: "artifact" } });
    const doomed = await addManualRule(db, { repo, ruleType: "ignore", glob: "tmp/**", payload: { reason: "scratch" } });
    await retireManualRule(db, { repo, ruleId: doomed.ruleId, retiredBy: "sam" });

    await rebuildReadModel(db);

    const rules = await db.select().from(repoRules).where(eq(repoRules.repo, repo));
    expect(rules).toHaveLength(2);
    const active = rules.find((r) => r.id === added.ruleId);
    const retired = rules.find((r) => r.id === doomed.ruleId);
    expect(active?.status).toBe("active");
    // SAFETY: addManualRule wrote payload { reason: "artifact" } for this
    // rule; rules has length 2 asserted above, so the row exists.
    expect((active!.payload as { reason?: string }).reason).toBe("artifact");
    // SAFETY: doomed.ruleId came from addManualRule; the rule exists or the
    // retire step above would have thrown.
    expect(retired?.status).toBe("retired");
    expect(retired?.deactivatedAt).toBeInstanceOf(Date);
  });

  it("pattern.merged resolves evidence without rewriting the log: survivor keeps its rule, loser's is dropped", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const repo = "rebuild/merge-drop";
    const loser = await seedLearnedPattern(repo, "merge-loser", 3);
    const survivor = await seedLearnedPattern(repo, "merge-survivor", 3);

    const liveRulesBefore = await snapshotRules(db, repo);
    expect(liveRulesBefore.size).toBe(2);

    await mergePatterns(db, loser, survivor, repo);

    const liveRules = await snapshotRules(db, repo);
    const liveEvidence = await snapshotEvidence(db, repo);
    // Live: the loser's rule was deleted, the survivor's remains.
    expect(liveRules.size).toBe(1);
    expect([...liveRules.values()][0]?.patternId).toBe(survivor);

    const logBefore = await db.select({ key: learningEvents.eventKey }).from(learningEvents).orderBy(learningEvents.eventKey);

    await rebuildReadModel(db);

    expect(await snapshotRules(db, repo)).toEqual(liveRules);
    expect(await snapshotEvidence(db, repo)).toEqual(liveEvidence);
    const logAfter = await db.select({ key: learningEvents.eventKey }).from(learningEvents).orderBy(learningEvents.eventKey);
    expect(logAfter).toEqual(logBefore);
  });

  it("pattern.merged re-points the loser's rule when the survivor has none", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const repo = "rebuild/merge-repoint";
    const loser = await seedLearnedPattern(repo, "repoint-loser", 3);
    const survivor = randomUUID();
    await db.insert(patterns).values({ id: survivor, repo, category: "security", canonicalMessage: "security:repoint-survivor", patternVersion: "v1", status: "active" });

    await mergePatterns(db, loser, survivor, repo);

    const liveRules = await snapshotRules(db, repo);
    expect(liveRules.size).toBe(1);
    expect([...liveRules.values()][0]?.patternId).toBe(survivor);
    const liveEvidence = await snapshotEvidence(db, repo);
    expect(liveEvidence.length).toBe(3);

    await rebuildReadModel(db);

    expect(await snapshotRules(db, repo)).toEqual(liveRules);
    expect(await snapshotEvidence(db, repo)).toEqual(liveEvidence);
  });

  it("§5.7/§5.9: rebuild restores the probe rate-limit from pattern.probed events", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const repo = "rebuild/probe";
    const patternId = await seedLearnedPattern(repo, "probe-rule", 3);
    const probeAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    await db.insert(learningEvents).values({
      eventKey: `pattern:${patternId}:probed:test`,
      repo,
      eventType: "pattern.probed",
      aggregateId: `pattern:${patternId}`,
      payload: { findingId: randomUUID(), filePath: "src/x/a.ts" },
      createdAt: probeAt,
    });

    // A rebuild must not silently reset the probe window: the rate limit is
    // read from pattern.probed events, so a pattern probed 5 days ago stays
    // suppressed inside the 30d window instead of being probed again.
    await rebuildReadModel(db);

    const rule = (await db.select().from(repoRules).where(eq(repoRules.patternId, patternId)))[0];
    expect(rule?.lastProbedAt).toBeInstanceOf(Date);
    // SAFETY: lastProbedAt is a Date when present (asserted above); the cast
    // narrows the optional for the comparison only.
    expect(((rule?.lastProbedAt as Date | undefined)?.getTime() ?? 0) / 1000).toBeCloseTo(probeAt.getTime() / 1000, 0);

    // Behavioral: a new-glob re-flag stays suppressed (no second probe) within
    // the window, exactly as it would have before the rebuild.
    const candidate: Finding = {
      filePath: "src/brand_new_dir/f.ts",
      lineStart: 1,
      lineEnd: 1,
      category: "security",
      patternId: "security:probe-rule",
      patternUuid: patternId,
      severity: "warning",
      message: "re-flag",
    };
    const probes = await selectProbeCandidates(db, { probeIntervalDays: 30 }, new Date(), [candidate]);
    expect(probes).toHaveLength(0);
  });
});
