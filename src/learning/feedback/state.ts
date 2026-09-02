// Outcome state machine (§5.1). All outcome mutations funnel through one
// serialized queue and are validated against this table before writing.
//
// Note: the plan lists `posted -> stale` for "7d no signal", but the poller
// emits `inconclusive` for that condition (phase-2 test list + schema comment).
// `stale` stays a valid transition reserved for probe/manual reopen.

export type OutcomeStatus = "pending" | "posted" | "replied" | "resolved" | "dismissed" | "stale" | "inconclusive";

export const TERMINAL_STATUSES: ReadonlySet<OutcomeStatus> = new Set(["resolved", "dismissed", "stale", "inconclusive"]);

const TRANSITIONS: Record<OutcomeStatus, ReadonlySet<OutcomeStatus>> = {
  pending: new Set(["posted"]),
  posted: new Set(["replied", "resolved", "dismissed", "stale", "inconclusive"]),
  replied: new Set(["resolved", "dismissed", "inconclusive"]),
  resolved: new Set(),
  dismissed: new Set(),
  stale: new Set(),
  inconclusive: new Set(),
};

export function canTransition(from: OutcomeStatus, to: OutcomeStatus): boolean {
  return TRANSITIONS[from].has(to);
}

export function transition(from: OutcomeStatus, to: OutcomeStatus): OutcomeStatus {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid outcome transition: ${from} -> ${to}`);
  }
  return to;
}

export function isTerminal(status: OutcomeStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

// Terminal states reopen only via probe or manual action, never silently.
export function reopen(from: OutcomeStatus, to: OutcomeStatus): OutcomeStatus {
  if (!isTerminal(from)) {
    throw new Error(`Cannot reopen non-terminal state: ${from}`);
  }
  if (isTerminal(to)) {
    throw new Error(`Reopen target must be non-terminal: ${to}`);
  }
  return to;
}
