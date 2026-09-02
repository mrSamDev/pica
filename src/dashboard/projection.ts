import type { Queue } from "bullmq";
import { desc } from "drizzle-orm";

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
}

export function createDashboardQueries(db: Db, queue: Queue): DashboardQueries {
  return {
    async countReviewsByStatus() {
      const rows = await db.select({ status: reviews.status }).from(reviews);
      const counts = { running: 0, completed: 0, failed: 0 };
      for (const row of rows) {
        if (row.status === "running") counts.running++;
        else if (row.status === "done") counts.completed++;
        else if (row.status === "failed") counts.failed++;
      }
      return counts;
    },
    async countFindingsByStatus() {
      const rows = await db.select({ status: findings.status }).from(findings);
      const counts = { posted: 0, suppressed: 0, duplicate: 0 };
      for (const row of rows) {
        if (row.status === "posted") counts.posted++;
        else if (row.status === "suppressed") counts.suppressed++;
        else if (row.status === "duplicate") counts.duplicate++;
      }
      return counts;
    },
    async countOutcomesByStatus() {
      const rows = await db.select({ status: findingOutcomes.status }).from(findingOutcomes);
      const counts: OutcomeCounts = { posted: 0, replied: 0, resolved: 0, dismissed: 0 };
      for (const row of rows) {
        if (row.status === "posted") counts.posted++;
        else if (row.status === "replied") counts.replied++;
        else if (row.status === "resolved") counts.resolved++;
        else if (row.status === "dismissed") counts.dismissed++;
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
      const counts = await queue.getJobCounts("waiting", "active", "delayed");
      return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
    },
  };
}
