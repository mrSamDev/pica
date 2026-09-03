import type { DashboardQueries, RuleSummary, WhyDisappeared } from "./projection.ts";
import { dashboardHtml, whyHtml } from "./view.ts";

export interface DashboardState {
  system: {
    reviewsRunning: number;
    reviewsCompleted: number;
    reviewsFailed: number;
    queueDepth: number;
    failedJobs: number;
  };
  reviewBehavior: {
    findingsPerPr: number;
    posted: number;
    suppressed: number;
    duplicate: number;
  };
  outcomes: {
    posted: number;
    replied: number;
    resolved: number;
    dismissed: number;
  };
  learning: {
    activeRules: number;
    candidateRules: number;
    retiredRules: number;
    learningLagMs: number | null;
    dismissalRateTrend: number[];
  };
  recentActivity: unknown[];
}

export function getDashboardHtml(): string {
  return dashboardHtml;
}

export function getWhyHtml(): string {
  return whyHtml;
}

export async function getRulesState(queries: DashboardQueries): Promise<RuleSummary[]> {
  return queries.listRules();
}

export async function getWhyState(queries: DashboardQueries, findingId: string): Promise<WhyDisappeared | null> {
  return queries.whyDisappeared(findingId);
}

export async function getDashboardState(queries: DashboardQueries): Promise<DashboardState> {
  const [system, findings, outcomes, activity, queueDepth, failedJobs, rules, learningLagMs] = await Promise.all([
    queries.countReviewsByStatus(),
    queries.countFindingsByStatus(),
    queries.countOutcomesByStatus(),
    queries.recentActivity(20),
    queries.queueDepth(),
    queries.failedJobs(),
    queries.countRulesByStatus(),
    queries.learningLag(),
  ]);

  return {
    system: {
      reviewsRunning: system.running,
      reviewsCompleted: system.completed,
      reviewsFailed: system.failed,
      queueDepth,
      failedJobs,
    },
    reviewBehavior: {
      findingsPerPr: findings.posted + findings.suppressed + findings.duplicate,
      posted: findings.posted,
      suppressed: findings.suppressed,
      duplicate: findings.duplicate,
    },
    outcomes,
    learning: {
      activeRules: rules.active,
      candidateRules: rules.candidate,
      retiredRules: rules.retired,
      learningLagMs,
      dismissalRateTrend: [],
    },
    recentActivity: activity,
  };
}
