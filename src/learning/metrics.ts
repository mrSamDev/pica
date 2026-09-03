import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { findingOutcomes, findings, reviews } from "../db/schema.ts";

// §8 learning metrics derived from the outcome log. Distinct from lag.ts
// (which owns learning_lag) so each metric has one home.

// Rolling-30d dismissal rate: share of dismissals among decisive outcomes
// (dismissed + resolved) in the window. null until any decisive outcome exists
// — an absent series is honest (mirrors the learning_lag gauge).
export async function getDismissalRate30d(db: Db, now: Date): Promise<number | null> {
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ status: findingOutcomes.status, count: sql<number>`count(*)::int` })
    .from(findingOutcomes)
    .where(and(sql`${findingOutcomes.status} in ('dismissed','resolved')`, sql`${findingOutcomes.updatedAt} >= ${since}`))
    .groupBy(findingOutcomes.status);

  let dismissed = 0;
  let decisive = 0;
  for (const row of rows) {
    if (row.status === "dismissed") dismissed += row.count;
    decisive += row.count;
  }
  if (decisive === 0) return null;
  return dismissed / decisive;
}

// §8 north-star trend: one dismissal rate per review that produced decisive
// outcomes, oldest first. The dashboard renders it as `42% → 35% → 27%` so a
// falling number is visibly learning, not a marketing line.
export async function getDismissalRateTrend(db: Db, limit = 25): Promise<number[]> {
  const rows = await db
    .select({
      dismissed: sql<number>`count(*) filter (where ${findingOutcomes.status} = 'dismissed')::int`,
      decisive: sql<number>`count(*) filter (where ${findingOutcomes.status} in ('dismissed','resolved'))::int`,
      at: sql<Date>`coalesce(${reviews.completedAt}, ${reviews.startedAt})`,
    })
    .from(findingOutcomes)
    .innerJoin(findings, eq(findings.id, findingOutcomes.findingId))
    .innerJoin(reviews, eq(reviews.id, findings.reviewId))
    .groupBy(reviews.id, reviews.completedAt, reviews.startedAt)
    .orderBy(sql`coalesce(${reviews.completedAt}, ${reviews.startedAt}) asc nulls last`)
    .limit(limit);

  return rows.filter((row) => row.decisive > 0).map((row) => row.dismissed / row.decisive);
}
