export type Severity = "error" | "warning" | "suggestion";

export type ReviewMode = "observe" | "post" | "dry-run";

export interface Finding {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  category: string;
  patternId: string;
  severity: Severity;
  message: string;
}

export interface ReviewRequest {
  reviewId: string;
  repo: string;
  prId: string;
  commitSha: string;
  diffHref: string;
  platform: "github" | "bitbucket";
  // Posting behavior, snapshotted at enqueue time from per-repo config.
  mode: ReviewMode;
  postingCap: number;
  summaryComment: boolean;
}

export interface ExistingComment {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  category: string;
  message: string;
}

export interface PriorFinding {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  patternId: string;
  commitSha: string;
}
