import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
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

// §5.5 human routing: a dismissed error is strong + surprising evidence and is
// never absorbed by a rule until a human confirms it. These are the pending
// ones — flagged in the report so an operator can `confirm-dismissal` them.
export interface PendingConfirmation {
  findingId: string;
  repo: string;
  prId: string;
  filePath: string;
  category: string;
  message: string;
  severity: string;
  dismissedAt: Date;
  reason: string | null;
}

export interface WeeklyReport {
  from: Date;
  to: Date;
  learnedRules: LearnedRuleSummary[];
  retiredRules: RetiredRuleSummary[];
  dismissalsByCategory: DismissalsByCategory[];
  needsConfirmation: PendingConfirmation[];
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

  // §5.5: dismissed error findings in the window that lack a confirmation
  // event — they must be routed to a human before any rule can absorb them.
  const pendingRows = await db
    .select({ findingId: findings.id, repo: findings.repo, prId: findings.prId, filePath: findings.filePath, category: findings.category, message: findings.message, severity: findings.severity, dismissedAt: findingOutcomes.updatedAt, reason: findingOutcomes.dismissalReason })
    .from(findingOutcomes)
    .innerJoin(findings, eq(findings.id, findingOutcomes.findingId))
    .where(and(sql`${findingOutcomes.status} = 'dismissed'`, sql`${findings.severity} = 'error'`, gte(findingOutcomes.updatedAt, from), lt(findingOutcomes.updatedAt, now), repo === undefined ? undefined : sql`${findings.repo} = ${repo}`));
  const pending = pendingRows.length === 0 ? [] : await filterConfirmed(db, pendingRows);

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
    needsConfirmation: pending,
  };
}

async function filterConfirmed(db: Db, pending: Array<{ findingId: string; repo: string; prId: string; filePath: string; category: string; message: string; severity: string; dismissedAt: Date | null; reason: string | null }>): Promise<PendingConfirmation[]> {
  const aggregateIds = pending.map((p) => `finding:${p.findingId}`);
  const confirmedEvents = await db
    .select({ aggregateId: learningEvents.aggregateId })
    .from(learningEvents)
    .where(and(eq(learningEvents.eventType, "finding.dismissal_confirmed"), inArray(learningEvents.aggregateId, aggregateIds)));
  const confirmed = new Set(confirmedEvents.map((e) => e.aggregateId.replace(/^finding:/, "")));
  return pending
    .filter((p) => !confirmed.has(p.findingId))
    .map((p) => ({
      findingId: p.findingId,
      repo: p.repo,
      prId: p.prId,
      filePath: p.filePath,
      category: p.category,
      message: p.message,
      severity: p.severity,
      dismissedAt: p.dismissedAt ?? new Date(),
      reason: p.reason,
    }));
}
