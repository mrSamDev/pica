import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { DashboardQueries, FailedReview, ProbeItem, RuleSummary, WhyDisappeared } from "./projection.ts";
import type { LlmStatus } from "./llm-status.ts";
import { dashboardHtml, errorsHtml, whyHtml } from "./view.ts";
import { computeDashboardVerdict, type Verdict } from "./verdict.ts";

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
    learningLagSeconds: number | null;
    dismissalRateTrend: number[];
    probes: ProbeItem[];
  };
  failedReviews: FailedReview[];
  recentActivity: unknown[];
  llm: LlmStatus | null;
  verdict: Verdict;
}

export function getDashboardHtml(): string {
  return dashboardHtml;
}

export function getErrorsHtml(): string {
  return errorsHtml;
}

export function getWhyHtml(): string {
  return whyHtml;
}

export async function getRulesState(queries: DashboardQueries): Promise<RuleSummary[]> {
  return queries.listRules();
}

export interface ErrorsState {
  total: number;
  failures: FailedReview[];
}

// The dedicated failed-reviews page: the true total plus a bounded list. 500 is
// a display cap, not a data limit — an operator triaging an outage reads the
// newest failures and the total tells them whether more are hidden.
export async function getErrorsState(queries: DashboardQueries): Promise<ErrorsState> {
  const [counts, failures] = await Promise.all([queries.countReviewsByStatus(), queries.failedReviews(500)]);
  return { total: counts.failed, failures };
}

export async function getWhyState(queries: DashboardQueries, findingId: string): Promise<WhyDisappeared | null> {
  return queries.whyDisappeared(findingId);
}

export async function getDashboardState(queries: DashboardQueries, getLlmStatus: () => LlmStatus | null): Promise<DashboardState> {
  const [system, findings, outcomes, activity, queueDepth, failedJobs, rules, learningLagSeconds, dismissalRateTrend, probes, failedReviews] = await Promise.all([
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
    queries.failedReviews(100),
  ]);

  const state: Omit<DashboardState, "verdict"> = {
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
      // getLearningLagSeconds returns fractional seconds; the response schema
      // pins this as integer|null, so an unrounded float throws in the
      // serializer. The dashboard labels the row in seconds, so the field is
      // seconds — rounded, not converted.
      learningLagSeconds: learningLagSeconds === null ? null : Math.round(learningLagSeconds),
      dismissalRateTrend,
      probes,
    },
    failedReviews,
    recentActivity: activity,
    llm: getLlmStatus(),
  };
  return { ...state, verdict: computeDashboardVerdict(state) };
}
