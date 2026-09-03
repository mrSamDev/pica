import { eq } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { learningEvents, repoRules, ruleEvidence } from "../../db/schema.ts";
import { buildPatternMergeMap, projectEvents, type EventInput } from "../events/replay.ts";

// §5.9 rebuild-read-model: repo_rules + rule_evidence are a disposable
// projection. Delete them, replay the immutable learning_events log, and the
// same rules come back — including manual adds/retires and pattern merges,
// because those are evented too.
//
// Operator action: run against a quiet system (learner paused), like any
// rebuild. Concurrent learner writes during a rebuild can be lost to the
// delete phase; they re-converge on the next learner run because state comes
// from events, but the window exists.
//
// Known drift: the learner bumps lastObservedAt on retired rules without
// eventing it (pinned phase-3 behavior). A rebuilt retired rule can therefore
// carry an older lastObservedAt than the live row did. Everything else —
// status, counts, confidence, evidence — converges exactly.

export interface RebuildResult {
  rules: number;
  events: number;
}

async function lastProbedAtBySurvivor(db: Db, mergeMap: Map<string, string>): Promise<Map<string, Date>> {
  const probes = await db.select({ aggregateId: learningEvents.aggregateId, createdAt: learningEvents.createdAt }).from(learningEvents).where(eq(learningEvents.eventType, "pattern.probed"));
  const byPattern = new Map<string, Date>();
  for (const probe of probes) {
    if (probe.createdAt === null) continue;
    const from = probe.aggregateId.replace(/^pattern:/, "");
    const survivor = mergeMap.get(from) ?? from;
    const existing = byPattern.get(survivor);
    if (existing === undefined || probe.createdAt > existing) {
      byPattern.set(survivor, probe.createdAt);
    }
  }
  return byPattern;
}

export async function rebuildReadModel(db: Db): Promise<RebuildResult> {
  const events = await db.select({ eventType: learningEvents.eventType, aggregateId: learningEvents.aggregateId, repo: learningEvents.repo, payload: learningEvents.payload }).from(learningEvents);

  // SAFETY: the selected columns match EventInput's shape exactly
  // (eventType, aggregateId, repo, payload).
  const { rules, evidenceByRule } = projectEvents(events as EventInput[]);
  // §5.7: keep the probe rate-limit across a rebuild by attributing
  // pattern.probed events (post-merge) to each rebuilt rule.
  // SAFETY: the same selected EventInput shape flows into buildPatternMergeMap.
  const probeTimes = await lastProbedAtBySurvivor(db, buildPatternMergeMap(events as EventInput[]));
  for (const rule of rules) {
    if (rule.patternId !== null) {
      rule.lastProbedAt = probeTimes.get(rule.patternId) ?? null;
    }
  }

  await db.transaction(async (tx) => {
    // rule_evidence first: its rule_id FK has no ON DELETE cascade.
    await tx.delete(ruleEvidence);
    await tx.delete(repoRules);

    for (const rule of rules) {
      // Explicit ids from the log: stable rule ids are what keep evidence
      // links, retire overlays, and explain-rule working across rebuilds.
      await tx
        .insert(repoRules)
        .values({
          id: rule.ruleId,
          repo: rule.repo,
          ruleType: rule.ruleType,
          patternId: rule.patternId,
          glob: rule.glob,
          payload: rule.payload,
          payloadHash: rule.payloadHash,
          status: rule.status,
          confidence: rule.confidence === null ? null : String(rule.confidence),
          evidenceCount: rule.evidenceCount,
          positiveCount: rule.positiveCount,
          negativeCount: rule.negativeCount,
          firstObservedAt: rule.firstObservedAt,
          lastObservedAt: rule.lastObservedAt,
          createdAt: rule.createdAt,
          createdBy: rule.createdBy,
          deactivatedAt: rule.deactivatedAt,
          lastProbedAt: rule.lastProbedAt,
        })
        .onConflictDoNothing();
    }

    for (const [ruleId, pairs] of evidenceByRule) {
      for (const pair of pairs) {
        await tx.insert(ruleEvidence).values({ ruleId, findingId: pair.findingId, outcome: pair.outcome }).onConflictDoNothing();
      }
    }
  });

  return { rules: rules.length, events: events.length };
}
