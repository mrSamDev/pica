import { and, eq } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { findings, patterns, repoRules, ruleEvidence } from "../../db/schema.ts";
import { emitEvent } from "../events/emit.ts";

// §2, §3: pattern merging. When two patterns turn out to be the same, re-point
// the write side (findings, rules) at the survivor and mark the loser merged.
// The immutable event log is NOT rewritten — a `pattern.merged` event records
// it, so a rebuild from the log converges to the same rules.

export async function mergePatterns(db: Db, fromPatternId: string, intoPatternId: string, repo: string): Promise<void> {
  if (fromPatternId === intoPatternId) {
    throw new Error("cannot merge a pattern into itself");
  }

  await db.update(findings).set({ patternId: intoPatternId }).where(eq(findings.patternId, fromPatternId));

  // Move any learner-created rule off the merging pattern. If the survivor
  // already owns a same-type rule, drop the loser's duplicate.
  const fromRules = await db.select().from(repoRules).where(eq(repoRules.patternId, fromPatternId));
  for (const rule of fromRules) {
    const survivor = await db
      .select({ id: repoRules.id })
      .from(repoRules)
      .where(and(eq(repoRules.repo, rule.repo), eq(repoRules.ruleType, rule.ruleType), eq(repoRules.patternId, intoPatternId)))
      .limit(1);
    if (survivor[0]) {
      // Drop the loser's duplicate rule. rule_evidence (rule_id FK, no cascade)
      // must be removed first or the delete violates the FK constraint.
      await db.delete(ruleEvidence).where(eq(ruleEvidence.ruleId, rule.id));
      await db.delete(repoRules).where(eq(repoRules.id, rule.id));
    } else {
      await db.update(repoRules).set({ patternId: intoPatternId }).where(eq(repoRules.id, rule.id));
    }
  }

  await db.update(patterns).set({ status: "merged", mergedInto: intoPatternId }).where(eq(patterns.id, fromPatternId));

  // Idempotent: deterministic key + onConflictDoNothing.
  await emitEvent(db, { eventKey: `pattern:${fromPatternId}:merged`, repo, eventType: "pattern.merged", aggregateId: `pattern:${fromPatternId}`, payload: { mergedInto: intoPatternId } });
}
