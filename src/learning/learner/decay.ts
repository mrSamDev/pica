import { and, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { findings, findingOutcomes, repoRules, ruleEvidence } from "../../db/schema.ts";
import { emitEvent } from "../events/emit.ts";
import { buildRuleSnapshot, snapshotStateHash } from "../events/snapshot.ts";

// §5.7 rule decay. Self-suppression makes rules unfalsifiable: once a rule
// stops a pattern being flagged, no new evidence arrives, so an obsolete rule
// becomes self-confirming forever. Decay retires an auto rule after `decayDays`
// without any supporting dismissal, so the bot re-flags and re-learns.
//
// Only learner-created rules decay (`createdBy = 'auto:learning'`). Manual
// rules are human-owned and stay human-owned; a manual retire is terminal.
// A decayed rule can be learned again later — the bot re-flagging produces
// fresh dismissals, and the learner re-forms it (§5.7's "the bot re-flags,
// users see flapping" fix is that the loop closes again instead of flapping).

export interface DecayOptions {
  decayDays: number;
}

export interface DecayedRule {
  ruleId: string;
  patternId: string;
}

export interface DecayResult {
  retired: DecayedRule[];
}

export async function decayStaleRules(db: Db, now: Date, options: DecayOptions): Promise<DecayResult> {
  const rules = await db
    .select()
    .from(repoRules)
    .where(and(inArray(repoRules.status, ["candidate", "active"]), eq(repoRules.createdBy, "auto:learning")));

  const retired: DecayedRule[] = [];
  for (const rule of rules) {
    if (!rule.patternId) continue;
    if (!(await isStale(db, rule.id, rule.patternId, rule.firstObservedAt, now, options))) continue;
    await retireRule(db, now, rule);
    retired.push({ ruleId: rule.id, patternId: rule.patternId });
  }
  return { retired };
}

// Supporting evidence for a suppressive rule is a dismissal of the pattern.
// Fall back to the rule's first observation so a rule that somehow never got
// evidence can still be cleaned up.
async function isStale(db: Db, ruleId: string, patternId: string, firstObservedAt: Date | null, now: Date, options: DecayOptions): Promise<boolean> {
  const latest = await db
    .select({ latest: sql<Date | null>`max(${findingOutcomes.updatedAt})` })
    .from(findingOutcomes)
    .innerJoin(findings, eq(findings.id, findingOutcomes.findingId))
    .where(and(eq(findings.patternId, patternId), eq(findingOutcomes.status, "dismissed")));
  // pg returns the max() aggregate as a string; coerce to a Date and guard
  // against a rule whose supporting-dismissal rows were removed.
  const raw = latest[0]?.latest;
  const lastSupport = raw === null || raw === undefined ? (firstObservedAt ?? now) : new Date(raw);
  const ageMs = now.getTime() - lastSupport.getTime();
  return ageMs >= options.decayDays * 24 * 60 * 60 * 1000;
}

async function retireRule(db: Db, now: Date, rule: typeof repoRules.$inferSelect): Promise<void> {
  const priorConfidence = rule.confidence === null ? null : Number(rule.confidence);
  // Lower confidence as part of retiring — the visible signal that this rule
  // stopped earning its keep.
  const lowered = priorConfidence === null ? null : priorConfidence / 2;

  await db.transaction(async (tx) => {
    await tx
      .update(repoRules)
      .set({ status: "retired", confidence: lowered === null ? null : String(lowered), deactivatedAt: now, lastObservedAt: now })
      .where(eq(repoRules.id, rule.id));

    const pairs = await tx.select({ findingId: ruleEvidence.findingId, outcome: ruleEvidence.outcome }).from(ruleEvidence).where(eq(ruleEvidence.ruleId, rule.id));
    const evidence = pairs.filter((p): p is { findingId: string; outcome: string } => p.findingId !== null);

    // Snapshot the retired row so the rebuild matches live state exactly,
    // including the lowered confidence.
    const saved = await tx.select().from(repoRules).where(eq(repoRules.id, rule.id)).limit(1);
    if (saved[0] === undefined) throw new Error(`decayed rule ${rule.id} missing after write`);
    const snapshot = buildRuleSnapshot(saved[0], evidence);
    await emitEvent(tx, {
      eventKey: `pattern:${rule.patternId}:state:${snapshotStateHash(snapshot)}`,
      repo: rule.repo,
      eventType: "rule.updated",
      aggregateId: `pattern:${rule.patternId}`,
      payload: snapshot,
    });

    // Marker event. The timestamp in the key keeps a rule that is retired,
    // re-learned, and retired again from colliding eventKeys.
    const decayedAt = now.toISOString();
    await emitEvent(tx, {
      eventKey: `pattern:${rule.patternId}:decayed:${rule.id}:${now.getTime()}`,
      repo: rule.repo,
      eventType: "rule.decayed",
      aggregateId: `pattern:${rule.patternId}`,
      payload: { ruleId: rule.id, decayedAt, priorConfidence },
    });
  });
}
