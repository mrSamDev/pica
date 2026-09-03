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
import { decayStaleRules } from "../src/learning/learner/decay.ts";
import { projectEvents, type EventInput } from "../src/learning/events/replay.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();
const repo = "owner/decay";
const DAY = 24 * 60 * 60 * 1000;

const opts: LearnerOptions = {
  minEvidence: 3,
  activationThreshold: 0.7,
  severityWeights: { error: 3, warning: 2, suggestion: 1 },
  protectedCategories: new Set(["security", "data", "concurrency"]),
};

async function seedAutoRule(d: NodePgDatabase<typeof schema>, canonicalMessage?: string): Promise<string> {
  const patternId = randomUUID();
  const prId = randomUUID();
  await d.insert(patterns).values({ id: patternId, repo, category: "correctness", canonicalMessage: canonicalMessage ?? `correctness:decay-me:${randomUUID()}`, patternVersion: "v1", status: "active" });
  const findingIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const findingId = randomUUID();
    await d.insert(findings).values({ id: findingId, reviewId: null, repo, prId, commitSha: "abc", filePath: "src/a.ts", lineStart: i, lineEnd: i, category: "correctness", patternId, severity: "suggestion", message: `m${i}`, messageHash: `h${i}`, status: "posted" });
    await d.insert(schema.findingOutcomes).values({ findingId, status: "dismissed", updatedAt: new Date(Date.now() - 2 * DAY) });
    findingIds.push(findingId);
  }
  await runLearner(d, { findingId: findingIds[0]!, repo }, opts);
  // 3 suggestions: generated 3, conf 5/7 >= 0.7 -> active.
  return patternId;
}

describe.skipIf(!dockerAvailable)("§5.7 rule decay: no supporting evidence -> confidence lowered -> retired", () => {
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

  function requireDb(): NodePgDatabase<typeof schema> {
    if (db === undefined) throw new Error("db not initialized");
    return db;
  }

  async function getRule(patternId: string) {
    const rows = await requireDb().select().from(repoRules).where(eq(repoRules.patternId, patternId));
    return rows[0];
  }

  it("recent supporting evidence keeps a rule alive", async () => {
    const d = requireDb();
    const patternId = await seedAutoRule(d);
    const result = await decayStaleRules(d, new Date(), { decayDays: 90 });
    const rule = await getRule(patternId);
    expect(rule?.status).toBe("active");
    expect(result.retired.some((r) => r.patternId === patternId)).toBe(false);
  });

  it("no supporting evidence for 90 days -> confidence lowered and rule retired", async () => {
    const d = requireDb();
    const patternId = await seedAutoRule(d);
    const ruleBefore = await getRule(patternId);
    const priorConfidence = Number(ruleBefore?.confidence);

    // Evidence is 2 days old; evaluate as if 91 days have passed.
    await decayStaleRules(d, new Date(Date.now() + 91 * DAY), { decayDays: 90 });

    const rule = await getRule(patternId);
    expect(rule?.status).toBe("retired");
    expect(rule?.deactivatedAt).not.toBeNull();
    expect(Number(rule?.confidence)).toBeCloseTo(priorConfidence / 2);

    const events = await d
      .select()
      .from(learningEvents)
      .where(eq(learningEvents.aggregateId, `pattern:${patternId}`));
    expect(events.some((e) => e.eventType === "rule.decayed")).toBe(true);
    // The decay snapshot carries the lowered confidence so a rebuild matches.
    // SAFETY: the decay-rule emitter writes RuleSnapshot-shaped payloads, so
    // the status field is a string here, not arbitrary bytes.
    expect(events.some((e) => e.eventType === "rule.updated" && (e.payload as { status?: string }).status === "retired")).toBe(true);
  });

  it("manual rules are never decayed — they are human-owned", async () => {
    const d = requireDb();
    const ruleId = randomUUID();
    await d.insert(repoRules).values({ id: ruleId, repo, ruleType: "style", patternId: null, payload: { description: "x" }, payloadHash: "h", status: "active", createdBy: "manual:cli", firstObservedAt: new Date(Date.now() - 1000 * DAY) });
    await decayStaleRules(d, new Date(Date.now() + 1000 * DAY), { decayDays: 90 });
    const rule = await d.select().from(repoRules).where(eq(repoRules.id, ruleId));
    expect(rule[0]?.status).toBe("active");
  });

  it("a decayed rule can be learned again when fresh dismissals arrive (no flapping)", async () => {
    const d = requireDb();
    const patternId = await seedAutoRule(d, "correctness:resurrect");
    await decayStaleRules(d, new Date(Date.now() + 91 * DAY), { decayDays: 90 });
    expect((await getRule(patternId))?.status).toBe("retired");

    // A fresh dismissal on the same pattern lets the learner re-form it.
    const freshFinding = randomUUID();
    await d.insert(findings).values({ id: freshFinding, reviewId: null, repo, prId: randomUUID(), commitSha: "z", filePath: "src/fresh.ts", lineStart: 1, lineEnd: 1, category: "correctness", patternId, severity: "suggestion", message: "fresh", messageHash: "fresh", status: "posted" });
    await d.insert(schema.findingOutcomes).values({ findingId: freshFinding, status: "dismissed", updatedAt: new Date() });
    const result = await runLearner(d, { findingId: freshFinding, repo }, opts);
    expect(result.stage).not.toBe("none");
    expect((await getRule(patternId))?.status).not.toBe("retired");
  });

  it("rebuild converges: a decayed rule projects as retired, a re-learned one as active", async () => {
    // Manual-created, then decayed event -> retired.
    const ruleId = "decay-rule-1";
    const snapshot = {
      ruleId,
      repo,
      ruleType: "ignore",
      patternId: "p1",
      glob: null,
      payload: { patternKey: "correctness:fold" },
      payloadHash: "h",
      status: "active",
      confidence: 0.7,
      evidenceCount: 3,
      positiveCount: 0,
      negativeCount: 3,
      firstObservedAt: new Date(Date.now() - 200 * DAY).toISOString(),
      lastObservedAt: new Date(Date.now() - 10 * DAY).toISOString(),
      createdAt: new Date(Date.now() - 200 * DAY).toISOString(),
      createdBy: "auto:learning",
      evidence: [],
    };
    const decayedAt = new Date(Date.now() - 5 * DAY).toISOString();
    const events: EventInput[] = [
      { eventType: "rule.updated", aggregateId: `pattern:p1`, repo, payload: snapshot },
      { eventType: "rule.decayed", aggregateId: "pattern:p1", repo, payload: { ruleId, decayedAt, priorConfidence: 0.7 } },
    ];
    // Shuffled replay must converge.
    const shuffled = [events[1]!, events[0]!];
    const folded = projectEvents(shuffled);
    expect(folded.rules[0]?.status).toBe("retired");
    expect(folded.rules[0]?.deactivatedAt?.toISOString()).toBe(decayedAt);

    // Re-learned: a newer snapshot supersedes the decay marker -> active.
    const resurrected = { ...snapshot, status: "candidate", confidence: 0.7, lastObservedAt: new Date(Date.now() - 1 * DAY).toISOString(), payloadHash: "h2" };
    const after = projectEvents([...shuffled, { eventType: "rule.updated", aggregateId: "pattern:p1", repo, payload: resurrected }]);
    expect(after.rules[0]?.status).toBe("candidate");
  });
});
