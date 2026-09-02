import { dashboardHtml } from "./view.ts";

export interface DashboardState {
  system: {
    reviewsRunning: number;
    reviewsCompleted: number;
    reviewsFailed: number;
    queueDepth: number;
  };
  reviewBehavior: {
    findingsPerPr: number;
    posted: number;
    suppressed: number;
    duplicate: number;
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

// Read-model projection stub. Phase 1+ fills this from the event log.
export function getDashboardState(): DashboardState {
  return {
    system: {
      reviewsRunning: 0,
      reviewsCompleted: 0,
      reviewsFailed: 0,
      queueDepth: 0,
    },
    reviewBehavior: {
      findingsPerPr: 0,
      posted: 0,
      suppressed: 0,
      duplicate: 0,
    },
    learning: {
      activeRules: 0,
      candidateRules: 0,
      retiredRules: 0,
      learningLagMs: null,
      dismissalRateTrend: [],
    },
    recentActivity: [],
  };
}
