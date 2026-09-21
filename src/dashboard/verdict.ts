import type { DashboardState } from "./controller.ts";

// The operator's question is not "what are the numbers" but "is this working
// and what should I do next". The verdict layer answers it from the same data
// the panels already show — no new queries, just interpretation.

export type VerdictStatus = "improving" | "uncertain" | "attention";

export interface Verdict {
  status: VerdictStatus;
  headline: string;
  reasons: string[];
  nextActions: string[];
}

// Inputs are deliberately narrower than DashboardState: only the fields the
// verdict may read, so tests can construct them without fakes.
export interface VerdictInput {
  posted: number;
  suppressed: number;
  resolved: number;
  dismissed: number;
  dismissalRateTrend: number[];
  failedReviews: number;
  failedJobs: number;
  candidateRules: number;
}

// Observe-first honesty: below this many decisive human outcomes (dismissed +
// resolved) the loop cannot honestly claim a direction.
const MIN_DECISIVE_OUTCOMES = 10;
// Comparing early vs late thirds needs at least one point per third.
const MIN_TREND_POINTS = 3;
// Dismissal-rate change between thirds that counts as a real direction, not
// noise. One dismissal moves the rate a lot early on; the floor keeps that
// from reading as a trend.
const TREND_DELTA = 0.05;

type TrendDirection = "falling" | "rising" | "steady" | "short";

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// dismissalRateTrend is oldest -> newest, one point per reviewed PR with
// decisive outcomes (src/learning/metrics.ts). Falling is learning.
export function trendDirection(trend: number[]): TrendDirection {
  if (trend.length < MIN_TREND_POINTS) return "short";
  const third = Math.floor(trend.length / 3);
  const early = average(trend.slice(0, third));
  const late = average(trend.slice(-third));
  if (early - late >= TREND_DELTA) return "falling";
  if (late - early >= TREND_DELTA) return "rising";
  return "steady";
}

export function computeVerdict(input: VerdictInput): Verdict {
  const decisive = input.dismissed + input.resolved;
  const attention: string[] = [];
  if (input.failedReviews > 0) {
    attention.push(`${input.failedReviews} review${input.failedReviews === 1 ? "" : "s"} failed and need a look`);
  }
  if (input.failedJobs > 0) {
    attention.push(`${input.failedJobs} job${input.failedJobs === 1 ? "" : "s"} stuck in the dead-letter queue`);
  }
  const direction = trendDirection(input.dismissalRateTrend);
  if (direction === "rising") {
    attention.push("dismissal rate is rising — the loop is getting noisier, not quieter");
  }
  if (attention.length > 0) {
    return {
      status: "attention",
      headline: "Needs attention",
      reasons: attention,
      nextActions: ["Inspect the failed reviews panel below", input.failedJobs > 0 ? "Re-drive the dead-letter queue, then watch this verdict flip back" : "Check recent activity for what changed"],
    };
  }

  if (decisive < MIN_DECISIVE_OUTCOMES) {
    return {
      status: "uncertain",
      headline: "Learning uncertain — not enough human feedback yet",
      reasons: [
        `${decisive} decisive outcome${decisive === 1 ? "" : "s"} so far; the loop needs ~${MIN_DECISIVE_OUTCOMES} before its direction means anything`,
        input.candidateRules > 0 ? `${input.candidateRules} candidate rule${input.candidateRules === 1 ? "" : "s"} waiting for their evidence threshold` : "no candidate rules yet",
      ],
      nextActions: ["Run pica observe-first: review PRs, dismiss or resolve findings as you normally would", "Every dismissal is a training signal — nothing else to configure"],
    };
  }

  if (direction === "short" || direction === "steady") {
    const steady = direction === "steady" ? ` at ~${pct(average(input.dismissalRateTrend))}` : "";
    return {
      status: "uncertain",
      headline: `Learning uncertain — dismissal rate steady${steady} across reviewed PRs`,
      reasons: [
        direction === "short" ? "not enough reviewed PRs yet to call a trend" : "the loop has evidence but is not yet visibly improving",
        input.candidateRules > 0 ? `${input.candidateRules} candidate rule${input.candidateRules === 1 ? "" : "s"} still gathering evidence` : "no rules waiting — feedback volume is the constraint",
      ],
      nextActions: ["Keep responding to findings — a falling dismissal rate is the whole bet", "If the rate stays flat after ~20 reviewed PRs, the loop is not working; the numbers will say so"],
    };
  }

  // direction === "falling": enough decisive outcomes and a clear downtrend.
  const trend = input.dismissalRateTrend;
  const reviewed = input.posted + input.suppressed;
  const share = reviewed > 0 && input.suppressed > 0 ? ` (${pct(input.suppressed / reviewed)} of review output never reaches you)` : "";
  return {
    status: "improving",
    headline: `Noise reduced — dismissal rate ${pct(trend[0]!)} → ${pct(trend[trend.length - 1]!)}`,
    reasons: [
      `${input.suppressed} finding${input.suppressed === 1 ? "" : "s"} suppressed by learned rules${share}`,
      input.candidateRules > 0 ? `${input.candidateRules} candidate rule${input.candidateRules === 1 ? "" : "s"} still gathering evidence` : "no rules waiting — the learner is keeping up with feedback",
    ],
    nextActions: ["Keep responding to findings — every dismissal or resolve sharpens the next review", "Check ε-probes below: suppressed patterns are still being re-tested, so a wrong suppression resurfaces"],
  };
}

export function computeDashboardVerdict(state: Omit<DashboardState, "verdict">): Verdict {
  return computeVerdict({
    posted: state.reviewBehavior.posted,
    suppressed: state.reviewBehavior.suppressed,
    resolved: state.outcomes.resolved,
    dismissed: state.outcomes.dismissed,
    dismissalRateTrend: state.learning.dismissalRateTrend,
    failedReviews: state.failedReviews.length,
    failedJobs: state.system.failedJobs,
    candidateRules: state.learning.candidateRules,
  });
}
