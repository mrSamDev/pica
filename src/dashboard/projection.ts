import type { Queue } from "bullmq";
import { desc, sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { findings, findingOutcomes, learningEvents, reviews } from "../db/schema.ts";

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

export interface DashboardQueries {
  countReviewsByStatus(): Promise<{ running: number; completed: number; failed: number }>;
  countFindingsByStatus(): Promise<{ posted: number; suppressed: number; duplicate: number }>;
  countOutcomesByStatus(): Promise<OutcomeCounts>;
  recentActivity(limit: number): Promise<ActivityItem[]>;
  queueDepth(): Promise<number>;
  failedJobs(): Promise<number>;
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
  };
}
