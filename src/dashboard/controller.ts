import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DashboardQueries, FailedReview, ProbeItem, RuleSummary, WhyDisappeared } from "./projection.ts";
import { dashboardHtml, whyHtml } from "./view.ts";

// Built by `pnpm build:dashboard` (vite, see vite.config.ts) into dist/app.js.
// Read once at boot so a stale or missing bundle fails fast, not on first view.
function readDashboardBundle(): string {
  try {
    return readFileSync(join(import.meta.dirname, "dist/app.js"), "utf8");
  } catch {
    throw new Error("dashboard bundle missing — run `pnpm build:dashboard` before starting the server");
  }
}

const appBundle = readDashboardBundle();

export function getDashboardApp(): string {
  return appBundle;
}

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
    probes: ProbeItem[];
  };
  failedReviews: FailedReview[];
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
  const [system, findings, outcomes, activity, queueDepth, failedJobs, rules, learningLagMs, dismissalRateTrend, probes, failedReviews] = await Promise.all([
    queries.countReviewsByStatus(),
    queries.countFindingsByStatus(),
    queries.countOutcomesByStatus(),
    queries.recentActivity(20),
    queries.queueDepth(),
    queries.failedJobs(),
    queries.countRulesByStatus(),
    queries.learningLag(),
    queries.dismissalRateTrend(),
    queries.probes(),
    queries.failedReviews(10),
  ]);

  const state: DashboardState = {
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
      dismissalRateTrend,
      probes,
    },
    failedReviews,
    recentActivity: activity,
  };
  return state;
}
