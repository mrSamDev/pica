import { describe, expect, it } from "vitest";

import { EVIDENCE_OUTCOMES, isEvidenceOutcome, outcomeToSignal } from "../src/learning/signals/signals.ts";

// §5.2 + §14: signals drive the learner. Replies must never reward.

describe("learning signals", () => {
  it("dismissed -> negative, resolved -> positive, replied -> neutral, stale -> weak", () => {
    expect(outcomeToSignal("dismissed")).toBe("negative");
    expect(outcomeToSignal("resolved")).toBe("positive");
    expect(outcomeToSignal("replied")).toBe("neutral");
    expect(outcomeToSignal("stale")).toBe("weak");
    expect(outcomeToSignal("inconclusive")).toBe("neutral");
    expect(outcomeToSignal("posted")).toBe("neutral");
  });

  it("only resolved and dismissed are evidence", () => {
    expect(Array.from(EVIDENCE_OUTCOMES).sort()).toEqual(["dismissed", "resolved"]);
    expect(isEvidenceOutcome("resolved")).toBe(true);
    expect(isEvidenceOutcome("dismissed")).toBe(true);
    expect(isEvidenceOutcome("replied")).toBe(false);
    expect(isEvidenceOutcome("inconclusive")).toBe(false);
    expect(isEvidenceOutcome("stale")).toBe(false);
    expect(isEvidenceOutcome("posted")).toBe(false);
  });
});
