import { and, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../db/client.ts";
import { findingOutcomes, findings, learningEvents } from "../db/schema.ts";

// §11 weekly learning report: what the agent learned, retired, and what the
// team dismissed. Governance, not vanity metrics — an agent that publishes
// what it learned feels like a colleague; one that silently changes behavior
// does not. Queries only; the CLI renders.

export interface LearnedRuleSummary {
  repo: string;
  ruleId: string;
  patternId: string;
  activatedAt: Date;
}

export interface RetiredRuleSummary {
  repo: string;
  ruleId: string;
  retiredBy: string;
  retiredAt: Date;
}

export interface DismissalsByCategory {
  category: string;
  count: number;
}

export interface WeeklyReport {
  from: Date;
  to: Date;
  learnedRules: LearnedRuleSummary[];
  retiredRules: RetiredRuleSummary[];
  dismissalsByCategory: DismissalsByCategory[];
}

const WINDOW_DAYS = 7;

// The retire event carries the authoritative retiredAt in its payload (the
// rule row's deactivatedAt); the event row's own createdAt can differ if the
// emit was ever replayed. Parsed here: the log is external input.
const retireEventSchema = z.object({ ruleId: z.string(), retiredBy: z.string().optional(), reason: z.string().nullable().optional(), retiredAt: z.iso.datetime() });

export async function weeklyReport(db: Db, now: Date, repo?: string): Promise<WeeklyReport> {
  const from = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Rules learned: rule.activated events in the window, the same source
  // learning_lag uses — no learner needed to know what the system learned.
  const activated = await db
    .select({ repo: learningEvents.repo, aggregateId: learningEvents.aggregateId, activatedAt: learningEvents.createdAt, payload: learningEvents.payload })
    .from(learningEvents)
    .where(and(sql`${learningEvents.eventType} = 'rule.activated'`, gte(learningEvents.createdAt, from), lt(learningEvents.createdAt, now), repo === undefined ? undefined : sql`${learningEvents.repo} = ${repo}`))
    .orderBy(learningEvents.createdAt);

  const retired = await db
    .select({ repo: learningEvents.repo, payload: learningEvents.payload })
    .from(learningEvents)
    .where(and(sql`${learningEvents.eventType} = 'rule.manual_retired'`, gte(learningEvents.createdAt, from), lt(learningEvents.createdAt, now), repo === undefined ? undefined : sql`${learningEvents.repo} = ${repo}`))
    .orderBy(learningEvents.createdAt);

  // Dismissals by category: outcomes reaching "dismissed" in the window,
  // attributed to the finding's category.
  const dismissals = await db
    .select({ category: findings.category, count: sql<number>`count(*)::int` })
    .from(findingOutcomes)
    .innerJoin(findings, sql`${findings.id} = ${findingOutcomes.findingId}`)
    .where(and(sql`${findingOutcomes.status} = 'dismissed'`, gte(findingOutcomes.updatedAt, from), lt(findingOutcomes.updatedAt, now), repo === undefined ? undefined : sql`${findings.repo} = ${repo}`))
    .groupBy(findings.category)
    .orderBy(sql`count(*) desc`);

  return {
    from,
    to: now,
    learnedRules: activated.map((row) => ({
      repo: row.repo,
      // SAFETY: rule.activated events carry payload { ruleId } (learner
      // contract, §8); the string() coercion keeps a corrupt payload visible
      // in the report instead of crashing the whole weekly summary.
      ruleId: String((row.payload as { ruleId?: unknown }).ruleId ?? ""),
      patternId: row.aggregateId.replace(/^pattern:/, ""),
      activatedAt: row.activatedAt ?? from,
    })),
    retiredRules: retired.map((row) => {
      const marker = retireEventSchema.parse(row.payload);
      return {
        repo: row.repo,
        ruleId: marker.ruleId,
        retiredBy: marker.retiredBy ?? "",
        retiredAt: new Date(marker.retiredAt),
      };
    }),
    dismissalsByCategory: dismissals.map((d) => ({ category: d.category, count: Number(d.count) })),
  };
}
