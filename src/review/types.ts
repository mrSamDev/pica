export type Severity = "error" | "warning" | "suggestion";

export type ReviewMode = "observe" | "post" | "dry-run";

export interface Finding {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  category: string;
  // LLM-emitted pattern key (e.g. "security:jwt-expiration"); the lookup key
  // for ensurePattern. Never compared against DB UUIDs.
  patternId: string;
  // Resolved patterns row uuid. The postfilter compares on this, so the LLM
  // string space and the DB uuid space can never be mixed.
  patternUuid: string;
  severity: Severity;
  message: string;
  // §5.7: true when this finding is an ε-probe re-flagging a suppressed
  // pattern in a new context (never set by the LLM).
  isProbe?: boolean;
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
  patternUuid: string;
  commitSha: string;
}

// Deterministic suppression the post-filter enforces. Pattern suppression comes
// from learned/manual ignore rules on a pattern id (suppress it everywhere);
// glob suppression comes from manual ignore rules with a path glob and no
// pattern id (`rule add --ignore "generated/**"`). No rule carries both
// (the learner never sets glob; manual ignores never set patternId).
export interface SuppressionRules {
  patternIds: ReadonlySet<string>;
  globs: readonly string[];
}
