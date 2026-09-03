import type { Queue } from "bullmq";
import { and, desc, eq, sql } from "drizzle-orm";

import { getDismissalRateTrend } from "../learning/metrics.ts";
import { getLearningLagSeconds } from "../learning/lag.ts";
import type { Db } from "../db/client.ts";
import { findings, findingOutcomes, learningEvents, patterns, repoRules, ruleEvidence, reviews } from "../db/schema.ts";

export interface ActivityItem {
  eventType: string;
  repo: string;
  payload: unknown;
  createdAt: Date;
}

export interface OutcomeCounts {
  posted: number;
  replied: number;
  resolved: number;
  dismissed: number;
}

export interface RuleSummary {
  id: string;
  repo: string;
  ruleType: string;
  status: string;
  pattern: string | null;
  confidence: number | null;
  evidenceCount: number;
  positiveCount: number;
  negativeCount: number;
  createdAt: Date | null;
}

export interface RuleStatusCounts {
  active: number;
  candidate: number;
  retired: number;
}

export interface WhyDisappeared {
  finding: { status: string; filePath: string; message: string; severity: string; prId: string };
  pattern: { canonicalMessage: string; category: string };
  rule: { status: string; confidence: number | null; evidenceCount: number; positiveCount: number; negativeCount: number } | null;
  evidence: Array<{ prId: string; outcome: string }>;
  lastProbe: string | null;
}

export interface ProbeItem {
  patternId: string;
  filePath: string;
  at: string;
}

export interface DashboardQueries {
  countReviewsByStatus(): Promise<{ running: number; completed: number; failed: number }>;
  countFindingsByStatus(): Promise<{ posted: number; suppressed: number; duplicate: number }>;
  countOutcomesByStatus(): Promise<OutcomeCounts>;
  recentActivity(limit: number): Promise<ActivityItem[]>;
  queueDepth(): Promise<number>;
  failedJobs(): Promise<number>;
  countRulesByStatus(): Promise<RuleStatusCounts>;
  listRules(): Promise<RuleSummary[]>;
  learningLag(): Promise<number | null>;
  // §8 north-star trend: dismissal rate per review over time, oldest first.
  dismissalRateTrend(): Promise<number[]>;
  // §5.7: recent ε-probes (evidence kept flowing despite suppression).
  probes(): Promise<ProbeItem[]>;
  whyDisappeared(findingId: string): Promise<WhyDisappeared | null>;
}

export function createDashboardQueries(db: Db, queue: Queue, outcomeQueue: Queue): DashboardQueries {
  return {
    async countReviewsByStatus() {
      // GROUP BY, not a full scan: the dashboard must stay cheap as the tables
      // grow. count(*)::int — pg returns bigint as a string otherwise.
      const rows = await db
        .select({ status: reviews.status, count: sql<number>`count(*)::int` })
        .from(reviews)
        .groupBy(reviews.status);
      const counts = { running: 0, completed: 0, failed: 0 };
      for (const row of rows) {
        if (row.status === "running") counts.running = row.count;
        else if (row.status === "done") counts.completed = row.count;
        else if (row.status === "failed") counts.failed = row.count;
      }
      return counts;
    },
    async countFindingsByStatus() {
      const rows = await db
        .select({ status: findings.status, count: sql<number>`count(*)::int` })
        .from(findings)
        .groupBy(findings.status);
      const counts = { posted: 0, suppressed: 0, duplicate: 0 };
      for (const row of rows) {
        if (row.status === "posted") counts.posted = row.count;
        else if (row.status === "suppressed") counts.suppressed = row.count;
        else if (row.status === "duplicate") counts.duplicate = row.count;
      }
      return counts;
    },
    async countOutcomesByStatus() {
      const rows = await db
        .select({ status: findingOutcomes.status, count: sql<number>`count(*)::int` })
        .from(findingOutcomes)
        .groupBy(findingOutcomes.status);
      const counts: OutcomeCounts = { posted: 0, replied: 0, resolved: 0, dismissed: 0 };
      for (const row of rows) {
        if (row.status === "posted") counts.posted = row.count;
        else if (row.status === "replied") counts.replied = row.count;
        else if (row.status === "resolved") counts.resolved = row.count;
        else if (row.status === "dismissed") counts.dismissed = row.count;
      }
      return counts;
    },
    async recentActivity(limit: number) {
      const rows = await db.select({ eventType: learningEvents.eventType, repo: learningEvents.repo, payload: learningEvents.payload, createdAt: learningEvents.createdAt }).from(learningEvents).orderBy(desc(learningEvents.createdAt)).limit(limit);
      return rows.map((row) => ({
        eventType: row.eventType,
        repo: row.repo,
        payload: row.payload,
        createdAt: row.createdAt ?? new Date(),
      }));
    },
    async queueDepth() {
      const [reviews, outcomes] = await Promise.all([queue.getJobCounts("waiting", "active", "delayed"), outcomeQueue.getJobCounts("waiting", "active", "delayed")]);
      return (reviews.waiting ?? 0) + (reviews.active ?? 0) + (reviews.delayed ?? 0) + (outcomes.waiting ?? 0) + (outcomes.active ?? 0) + (outcomes.delayed ?? 0);
    },
    async failedJobs() {
      const [reviews, outcomes] = await Promise.all([queue.getFailedCount(), outcomeQueue.getFailedCount()]);
      return reviews + outcomes;
    },
    async countRulesByStatus() {
      const rows = await db
        .select({ status: repoRules.status, count: sql<number>`count(*)::int` })
        .from(repoRules)
        .groupBy(repoRules.status);
      const counts: RuleStatusCounts = { active: 0, candidate: 0, retired: 0 };
      for (const row of rows) {
        if (row.status === "active") counts.active = row.count;
        else if (row.status === "candidate") counts.candidate = row.count;
        else if (row.status === "retired") counts.retired = row.count;
      }
      return counts;
    },
    async listRules() {
      const rows = await db
        .select({
          id: repoRules.id,
          repo: repoRules.repo,
          ruleType: repoRules.ruleType,
          status: repoRules.status,
          patternKey: patterns.canonicalMessage,
          confidence: repoRules.confidence,
          evidenceCount: repoRules.evidenceCount,
          positiveCount: repoRules.positiveCount,
          negativeCount: repoRules.negativeCount,
          createdAt: repoRules.createdAt,
        })
        .from(repoRules)
        .leftJoin(patterns, eq(patterns.id, repoRules.patternId))
        .orderBy(desc(repoRules.createdAt))
        .limit(200);
      return rows.map((r) => ({
        id: r.id,
        repo: r.repo,
        ruleType: r.ruleType,
        status: r.status,
        pattern: r.patternKey ?? null,
        // pg returns numeric as a string; coerce to a number.
        confidence: r.confidence === null ? null : Number(r.confidence),
        evidenceCount: r.evidenceCount ?? 0,
        positiveCount: r.positiveCount ?? 0,
        negativeCount: r.negativeCount ?? 0,
        createdAt: r.createdAt ?? null,
      }));
    },
    async learningLag() {
      return getLearningLagSeconds(db);
    },
    async dismissalRateTrend() {
      return getDismissalRateTrend(db);
    },
    async probes() {
      const rows = await db.select({ patternId: learningEvents.aggregateId, payload: learningEvents.payload, createdAt: learningEvents.createdAt }).from(learningEvents).where(eq(learningEvents.eventType, "pattern.probed")).orderBy(desc(learningEvents.createdAt)).limit(20);
      return rows.map((row) => ({
        patternId: row.patternId.replace(/^pattern:/, ""),
        // SAFETY: probe events carry payload { findingId, filePath } (pipeline
        // contract, §5.7); an unknown payload renders as a readable fallback.
        filePath: String((row.payload as { filePath?: unknown })?.filePath ?? ""),
        at: (row.createdAt ?? new Date()).toISOString(),
      }));
    },
    async whyDisappeared(findingId) {
      const finding = await db.select({ findingId: findings.id, status: findings.status, filePath: findings.filePath, message: findings.message, severity: findings.severity, prId: findings.prId, patternId: findings.patternId }).from(findings).where(eq(findings.id, findingId)).limit(1);
      const row = finding[0];
      if (!row?.patternId) return null;

      const pattern = await db.select({ canonicalMessage: patterns.canonicalMessage, category: patterns.category }).from(patterns).where(eq(patterns.id, row.patternId)).limit(1);
      const rule = await db
        .select({ id: repoRules.id, status: repoRules.status, confidence: repoRules.confidence, evidenceCount: repoRules.evidenceCount, positiveCount: repoRules.positiveCount, negativeCount: repoRules.negativeCount })
        .from(repoRules)
        .where(eq(repoRules.patternId, row.patternId))
        .limit(1);

      const evidence = rule[0] ? await db.select({ prId: findings.prId, outcome: ruleEvidence.outcome, findingId: ruleEvidence.findingId }).from(ruleEvidence).innerJoin(findings, eq(findings.id, ruleEvidence.findingId)).where(eq(ruleEvidence.ruleId, rule[0].id)) : [];

      // §5.7: surface the last ε-probe so an operator can see the pattern is
      // still being checked, not silently fossilised.
      const probes = await db
        .select({ createdAt: learningEvents.createdAt })
        .from(learningEvents)
        .where(and(eq(learningEvents.eventType, "pattern.probed"), eq(learningEvents.aggregateId, `pattern:${row.patternId}`)))
        .orderBy(desc(learningEvents.createdAt))
        .limit(1);

      return {
        finding: { status: row.status, filePath: row.filePath, message: row.message, severity: row.severity, prId: row.prId },
        pattern: { canonicalMessage: pattern[0]?.canonicalMessage ?? "", category: pattern[0]?.category ?? "" },
        rule: rule[0] ? { status: rule[0].status, confidence: rule[0].confidence === null ? null : Number(rule[0].confidence), evidenceCount: rule[0].evidenceCount ?? 0, positiveCount: rule[0].positiveCount ?? 0, negativeCount: rule[0].negativeCount ?? 0 } : null,
        evidence: evidence.map((e) => ({ prId: e.prId, outcome: e.outcome })),
        lastProbe: probes[0]?.createdAt ? probes[0].createdAt.toISOString() : null,
      };
    },
  };
}
