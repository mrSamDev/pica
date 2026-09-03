// §5.5 Safety guardrails on learning. Shared by the learner (rule formation)
// and the post-filter (enforcement). Both layers must agree on what is
// suppressible, so the definitions live in one place.

import { and, eq, inArray } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { learningEvents } from "../../db/schema.ts";

export function isProtectedCategory(category: string, protectedCategories: ReadonlySet<string>): boolean {
  return protectedCategories.has(category.trim().toLowerCase());
}

// §5.5 severity weighting + human routing: a dismissed error is strong AND
// surprising evidence. It counts toward a rule only after a human confirms
// the dismissal (a finding.dismissal_confirmed event); until then it is not
// evidence at all — the rule cannot absorb it.
export function requiresHumanConfirmation(severity: string): boolean {
  return severity === "error";
}

// Dismissed error findings only count once their confirmation event exists. The
// event log is the source of truth — no live-row flag to drift from a rebuild.
export async function fetchConfirmedDismissalIds(db: Db, ids: string[]): Promise<Set<string>> {
  const aggregateIds = ids.map((id) => `finding:${id}`);
  if (aggregateIds.length === 0) {
    return new Set();
  }
  const events = await db
    .select({ aggregateId: learningEvents.aggregateId })
    .from(learningEvents)
    .where(and(eq(learningEvents.eventType, "finding.dismissal_confirmed"), inArray(learningEvents.aggregateId, aggregateIds)));
  return new Set(events.map((event) => event.aggregateId.replace(/^finding:/, "")));
}
