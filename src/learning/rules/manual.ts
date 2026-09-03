import { and, asc, eq, isNull } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { repoRules } from "../../db/schema.ts";
import { emitEvent } from "../events/emit.ts";
import { buildRuleSnapshot, canonicalPayloadHash, snapshotStateHash } from "../events/snapshot.ts";

// §11 rule add / rule retire. Manual actions are the human override path —
// they write the rule row AND emit rule.manual_* events in one transaction so
// a rebuild from the log reproduces them (§5.3: human edits live in the log).

export type ManualRulePayload = {
  reason?: string;
  pattern?: string;
  description?: string;
  pathPrefix?: string;
  reviewDepth?: string;
};

export interface AddManualRuleInput {
  repo: string;
  ruleType: string;
  glob: string | null;
  payload: ManualRulePayload;
}

export type AddManualRuleOutcome = "created" | "updated" | "unchanged" | "noop-retired";

export interface AddManualRuleResult {
  ruleId: string;
  outcome: AddManualRuleOutcome;
}

async function findManualRule(db: Db, input: AddManualRuleInput) {
  const globCondition = input.glob === null ? isNull(repoRules.glob) : eq(repoRules.glob, input.glob);
  const rows = await db
    .select()
    .from(repoRules)
    .where(and(eq(repoRules.repo, input.repo), eq(repoRules.ruleType, input.ruleType), isNull(repoRules.patternId), globCondition))
    .limit(1);
  return rows[0] ?? null;
}

async function emitSnapshotEvent(tx: Db, row: typeof repoRules.$inferSelect, eventType: string, eventKey: string): Promise<void> {
  const snapshot = buildRuleSnapshot(row, []);
  await emitEvent(tx, {
    eventKey,
    repo: row.repo,
    eventType,
    aggregateId: `rule:${row.id}`,
    payload: snapshot,
  });
}

export async function addManualRule(db: Db, input: AddManualRuleInput): Promise<AddManualRuleResult> {
  const existing = await findManualRule(db, input);

  // A retired rule stays retired: the always-wins retire marker in the fold
  // depends on adds never resurrecting a rule.
  if (existing?.status === "retired") {
    return { ruleId: existing.id, outcome: "noop-retired" };
  }

  const payloadHash = canonicalPayloadHash(input.payload);

  // Same payload re-added: no row bump, no event — keeps live rows and the
  // rebuilt projection in sync (a lastObservedAt bump without an event would
  // drift from the rebuild, like the learner's retired-rule path).
  if (existing?.status === "active" && existing.payloadHash === payloadHash) {
    return { ruleId: existing.id, outcome: "unchanged" };
  }

  const now = new Date();

  if (existing) {
    return db.transaction(async (tx) => {
      await tx.update(repoRules).set({ payload: input.payload, payloadHash, lastObservedAt: now }).where(eq(repoRules.id, existing.id));
      const saved = (await tx.select().from(repoRules).where(eq(repoRules.id, existing.id)).limit(1))[0];
      if (saved === undefined) throw new Error(`manual rule ${existing.id} missing after update`);
      // Payload changes are state changes: snapshot them for the rebuild.
      await emitSnapshotEvent(tx, saved, "rule.updated", `rule:${saved.id}:state:${snapshotStateHash(buildRuleSnapshot(saved, []))}`);
      return { ruleId: saved.id, outcome: "updated" as const };
    });
  }

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(repoRules)
      .values({
        repo: input.repo,
        ruleType: input.ruleType,
        patternId: null,
        glob: input.glob,
        payload: input.payload,
        payloadHash,
        status: "active",
        confidence: null,
        evidenceCount: 0,
        positiveCount: 0,
        negativeCount: 0,
        firstObservedAt: now,
        lastObservedAt: now,
        createdBy: "manual:cli",
      })
      .returning();
    const saved = inserted[0];
    if (saved === undefined) throw new Error("manual rule insert returned no row");
    await emitSnapshotEvent(tx, saved, "rule.manual_added", `rule:${saved.id}:manual_added`);
    return { ruleId: saved.id, outcome: "created" as const };
  });
}

export interface RetireManualRuleInput {
  repo: string;
  ruleId: string;
  retiredBy: string;
  reason?: string;
}

export type RetireManualRuleOutcome = "retired" | "already-retired";

export async function retireManualRule(db: Db, input: RetireManualRuleInput): Promise<{ ruleId: string; outcome: RetireManualRuleOutcome }> {
  const existing = (
    await db
      .select()
      .from(repoRules)
      .where(and(eq(repoRules.id, input.ruleId), eq(repoRules.repo, input.repo)))
      .limit(1)
  )[0];
  if (existing === undefined) {
    throw new Error(`rule ${input.ruleId} not found in ${input.repo}`);
  }
  if (existing.status === "retired") {
    return { ruleId: existing.id, outcome: "already-retired" };
  }

  const retiredAt = new Date();
  await db.transaction(async (tx) => {
    await tx.update(repoRules).set({ status: "retired", deactivatedAt: retiredAt }).where(eq(repoRules.id, existing.id));
    await emitEvent(tx, {
      eventKey: `rule:${existing.id}:manual_retired`,
      repo: input.repo,
      eventType: "rule.manual_retired",
      aggregateId: `rule:${existing.id}`,
      payload: { ruleId: existing.id, retiredBy: input.retiredBy, reason: input.reason ?? null, retiredAt: retiredAt.toISOString() },
    });
  });
  return { ruleId: existing.id, outcome: "retired" };
}

// CLI rule retire accepts --rule <id>, --pattern <uuid>, or --ignore <glob>;
// resolve to one id. If a pattern owns several rules (different types), the
// oldest is returned — retire-by-pattern is a convenience, retire-by-id is
// exact.
export async function resolveRuleId(db: Db, repo: string, selector: { ruleId?: string; patternId?: string; glob?: string }): Promise<string | null> {
  if (selector.ruleId) {
    const rows = await db
      .select({ id: repoRules.id })
      .from(repoRules)
      .where(and(eq(repoRules.id, selector.ruleId), eq(repoRules.repo, repo)))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  if (selector.patternId) {
    const rows = await db
      .select({ id: repoRules.id })
      .from(repoRules)
      .where(and(eq(repoRules.repo, repo), eq(repoRules.patternId, selector.patternId)))
      .orderBy(asc(repoRules.createdAt))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  if (selector.glob) {
    const rows = await db
      .select({ id: repoRules.id })
      .from(repoRules)
      .where(and(eq(repoRules.repo, repo), eq(repoRules.glob, selector.glob)))
      .orderBy(asc(repoRules.createdAt))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  return null;
}
