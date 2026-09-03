import { eq } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { repoRules, ruleEvidence } from "../../db/schema.ts";
import { emitEvent } from "../events/emit.ts";
import { buildRuleSnapshot, snapshotStateHash, type EvidencePair } from "../events/snapshot.ts";
import type { EvidenceCounts, RuleStage } from "./learner.ts";

// §5.6/§5.9 persistence half of the learner: write the rule row, marker event,
// snapshot event, and evidence links in one transaction. The rule only becomes
// visible when its events do — observers (e2e tests, the dashboard) rely on
// that, and a crash cannot leave an active rule without its rule.activated
// event (which learning_lag depends on), its snapshot, or its evidence links.

export interface PersistInput {
  repo: string;
  patternId: string;
  ruleId: string | null;
  stage: RuleStage;
  previousStatus: string | null;
  newStatus: "candidate" | "active";
  statusChanged: boolean;
  payload: { patternKey: string; reason?: string };
  payloadHash: string;
  counts: EvidenceCounts;
  evidenceRows: Array<{ id: string; status: string }>;
  now: Date;
}

export async function persistRule(db: Db, input: PersistInput): Promise<{ ruleId: string | null; stage: RuleStage }> {
  return db.transaction(async (tx) => {
    let ruleId = input.ruleId;

    if (ruleId === null) {
      const inserted = await tx
        .insert(repoRules)
        .values({
          repo: input.repo,
          ruleType: "ignore",
          patternId: input.patternId,
          payload: input.payload,
          payloadHash: input.payloadHash,
          status: input.stage,
          confidence: String(input.counts.confidence),
          evidenceCount: input.counts.generated,
          positiveCount: input.counts.positive,
          negativeCount: input.counts.negative,
          firstObservedAt: input.now,
          lastObservedAt: input.now,
          createdBy: "auto:learning",
        })
        .onConflictDoNothing()
        .returning({ id: repoRules.id });
      ruleId = inserted[0]?.id ?? null;
      if (ruleId === null) {
        // Another run won the insert and has not committed yet (or lost the
        // race entirely); nothing to do this run — the next retry converges.
        return { ruleId: null, stage: input.stage };
      }
    }

    await tx
      .update(repoRules)
      .set({
        status: input.newStatus,
        confidence: String(input.counts.confidence),
        evidenceCount: input.counts.generated,
        positiveCount: input.counts.positive,
        negativeCount: input.counts.negative,
        payload: input.payload,
        payloadHash: input.payloadHash,
        lastObservedAt: input.now,
      })
      .where(eq(repoRules.id, ruleId));

    // Only the transition to active emits rule.activated — the learning_lag
    // contract pins aggregateId `pattern:{uuid}` (§8). Deterministic keys make
    // re-emission idempotent.
    if (input.statusChanged && input.newStatus === "active") {
      await emitEvent(tx, { eventKey: `pattern:${input.patternId}:activated`, repo: input.repo, eventType: "rule.activated", aggregateId: `pattern:${input.patternId}`, payload: { ruleId } });
    } else if (input.statusChanged && input.newStatus === "candidate") {
      await emitEvent(tx, { eventKey: `pattern:${input.patternId}:candidate`, repo: input.repo, eventType: "rule.candidate", aggregateId: `pattern:${input.patternId}`, payload: { ruleId } });
    }

    // Audit trail: link each evidence finding to the rule it helped produce.
    // SAFETY: outcome column is text; the evidence WHERE clause (resolved or
    // dismissed) already restricted these rows, so the value is one of the
    // terminal evidence statuses.
    const evidencePairs: EvidencePair[] = [];
    for (const row of input.evidenceRows) {
      await tx.insert(ruleEvidence).values({ ruleId, findingId: row.id, outcome: row.status }).onConflictDoNothing();
      evidencePairs.push({ findingId: row.id, outcome: row.status });
    }

    // SAFETY: the row was just upserted inside this transaction; re-selecting
    // it (not reconstructing by hand) guarantees the snapshot equals the row,
    // including defaults like createdAt.
    const saved = await tx.select().from(repoRules).where(eq(repoRules.id, ruleId)).limit(1);
    if (saved[0] === undefined) {
      throw new Error(`learner rule ${ruleId} missing after write`);
    }
    const snapshot = buildRuleSnapshot(saved[0], evidencePairs);
    await emitEvent(tx, {
      eventKey: `pattern:${input.patternId}:state:${snapshotStateHash(snapshot)}`,
      repo: input.repo,
      eventType: "rule.updated",
      aggregateId: `pattern:${input.patternId}`,
      payload: snapshot,
    });

    // SAFETY: newStatus is always "candidate" or "active" here, never "none".
    return { ruleId, stage: input.newStatus as RuleStage };
  });
}
