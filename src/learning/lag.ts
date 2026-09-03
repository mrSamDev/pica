import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { findings, learningEvents } from "../db/schema.ts";

// learning_lag (§8): time from a pattern's first dismissal to its rule
// activation. Computed from the immutable event log alone — no learner needed.
//
// Contract pinned for the phase-3 learner: a rule activation is a
// `rule.activated` event with aggregateId `pattern:{uuid}`; a dismissal is a
// `finding.outcome_changed` event with payload.status = "dismissed" and
// aggregateId `finding:{findingId}`. The learner must emit events in this
// shape for this metric to stay honest.
//
// Returns the max lag in seconds across all activated patterns, or null when
// no rule has activated yet (empty is honest — the dashboard renders null).

export async function getLearningLagSeconds(db: Db): Promise<number | null> {
  const activations = await db.select({ aggregateId: learningEvents.aggregateId, activatedAt: learningEvents.createdAt }).from(learningEvents).where(eq(learningEvents.eventType, "rule.activated"));

  if (activations.length === 0) {
    return null;
  }

  // Earliest dismissal per finding, from the event log.
  const dismissals = await db
    .select({
      findingId: learningEvents.aggregateId,
      dismissedAt: sql<Date>`min(${learningEvents.createdAt})`,
    })
    .from(learningEvents)
    .where(and(eq(learningEvents.eventType, "finding.outcome_changed"), sql`${learningEvents.payload}->>'status' = 'dismissed'`))
    .groupBy(learningEvents.aggregateId);

  // Map finding -> pattern so a dismissal event can be attributed to a pattern.
  const findingRows = await db.select({ id: findings.id, patternId: findings.patternId }).from(findings);
  const findingToPattern = new Map<string, string | null>();
  for (const row of findingRows) {
    findingToPattern.set(row.id, row.patternId);
  }

  const earliestDismissalByPattern = new Map<string, Date>();
  for (const dismissal of dismissals) {
    const findingId = dismissal.findingId.replace(/^finding:/, "");
    const patternId = findingToPattern.get(findingId);
    if (!patternId) continue;
    // pg returns the min() aggregate as a string; coerce to a Date.
    const dismissedAt = new Date(dismissal.dismissedAt);
    const existing = earliestDismissalByPattern.get(patternId);
    if (!existing || dismissedAt < existing) {
      earliestDismissalByPattern.set(patternId, dismissedAt);
    }
  }

  let maxLagSeconds = 0;
  for (const activation of activations) {
    const patternId = activation.aggregateId.replace(/^pattern:/, "");
    const dismissedAt = earliestDismissalByPattern.get(patternId);
    if (!dismissedAt || !activation.activatedAt) continue;
    const lag = (activation.activatedAt.getTime() - dismissedAt.getTime()) / 1000;
    if (lag > maxLagSeconds) maxLagSeconds = lag;
  }

  return maxLagSeconds > 0 ? maxLagSeconds : null;
}
