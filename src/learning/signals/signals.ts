import type { OutcomeStatus } from "../feedback/state.ts";

// §5.2 Map outcomes to learning signals. Only terminal outcomes count as
// evidence. Replies are NOT positive evidence — engagement ≠ correctness.
// This is the single source of truth the learner reads.

export type LearningSignal = "negative" | "positive" | "neutral" | "weak";

export function outcomeToSignal(status: OutcomeStatus): LearningSignal {
  switch (status) {
    case "dismissed":
      return "negative";
    case "resolved":
      return "positive";
    case "replied":
      // Leading indicator only, never counted as evidence.
      return "neutral";
    case "stale":
      return "weak";
    case "pending":
    case "posted":
    case "inconclusive":
      return "neutral";
  }
}

// The only statuses that produce learning evidence. Terminal, decisive.
export const EVIDENCE_OUTCOMES: ReadonlySet<OutcomeStatus> = new Set(["resolved", "dismissed"]);

export function isEvidenceOutcome(status: OutcomeStatus): boolean {
  return EVIDENCE_OUTCOMES.has(status);
}
