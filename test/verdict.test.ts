import { describe, expect, it } from "vitest";

import { computeVerdict, trendDirection, type VerdictInput } from "../src/dashboard/verdict.ts";

function makeInput(overrides?: Partial<VerdictInput>): VerdictInput {
  return {
    posted: 30,
    suppressed: 12,
    resolved: 5,
    dismissed: 15,
    dismissalRateTrend: [0.6, 0.5, 0.4, 0.3],
    failedReviews: 0,
    failedJobs: 0,
    candidateRules: 2,
    ...overrides,
  };
}

describe("trendDirection", () => {
  it("short trend before MIN_TREND_POINTS points", () => {
    expect(trendDirection([])).toBe("short");
    expect(trendDirection([0.4, 0.2])).toBe("short");
  });

  it("falling when late third drops by TREND_DELTA or more", () => {
    expect(trendDirection([0.6, 0.55, 0.5, 0.45, 0.4, 0.3])).toBe("falling");
  });

  it("rising when late third climbs by TREND_DELTA or more", () => {
    expect(trendDirection([0.1, 0.15, 0.2, 0.3, 0.4, 0.5])).toBe("rising");
  });

  it("steady inside the noise band", () => {
    expect(trendDirection([0.4, 0.41, 0.42, 0.4, 0.39, 0.41])).toBe("steady");
  });
});

describe("computeVerdict", () => {
  it("attention outranks a falling trend — broken runs cannot hide behind learning prose", () => {
    const verdict = computeVerdict(makeInput({ failedReviews: 2 }));
    expect(verdict.status).toBe("attention");
    expect(verdict.reasons.some((r) => r.includes("2 reviews failed"))).toBe(true);
  });

  it("attention on dead-letter jobs", () => {
    const verdict = computeVerdict(makeInput({ failedJobs: 1 }));
    expect(verdict.status).toBe("attention");
    expect(verdict.reasons.some((r) => r.includes("dead-letter"))).toBe(true);
  });

  it("attention when the dismissal rate is rising", () => {
    const verdict = computeVerdict(makeInput({ dismissalRateTrend: [0.1, 0.2, 0.5] }));
    expect(verdict.status).toBe("attention");
    expect(verdict.reasons.some((r) => r.includes("rising"))).toBe(true);
  });

  it("uncertain below the evidence floor, whatever the trend says", () => {
    const verdict = computeVerdict(makeInput({ dismissed: 3, resolved: 1, suppressed: 0 }));
    expect(verdict.status).toBe("uncertain");
    expect(verdict.headline).toContain("not enough human feedback");
    expect(verdict.reasons.some((r) => r.includes("4 decisive outcomes"))).toBe(true);
  });

  it("uncertain names candidate rules waiting for evidence", () => {
    const verdict = computeVerdict(makeInput({ dismissed: 2, resolved: 0, candidateRules: 3 }));
    expect(verdict.reasons.some((r) => r.includes("3 candidate rules"))).toBe(true);
  });

  it("uncertain when the trend is too short to call", () => {
    const verdict = computeVerdict(makeInput({ dismissalRateTrend: [0.4] }));
    expect(verdict.status).toBe("uncertain");
    expect(verdict.reasons.some((r) => r.includes("not enough reviewed PRs"))).toBe(true);
  });

  it("uncertain when the dismissal rate is flat — the loop must show it is working", () => {
    const verdict = computeVerdict(makeInput({ dismissalRateTrend: [0.4, 0.4, 0.41, 0.39, 0.4, 0.41] }));
    expect(verdict.status).toBe("uncertain");
    expect(verdict.headline).toContain("steady");
  });

  it("improving when the dismissal rate falls with enough evidence", () => {
    const verdict = computeVerdict(makeInput());
    expect(verdict.status).toBe("improving");
    expect(verdict.headline).toContain("60% → 30%");
  });

  it("improving reports suppression share of review output", () => {
    const verdict = computeVerdict(makeInput({ posted: 28, suppressed: 12 }));
    expect(verdict.reasons.some((r) => r.includes("12 findings suppressed") && r.includes("30%"))).toBe(true);
  });

  it("improving without suppressions does not divide by zero", () => {
    const verdict = computeVerdict(makeInput({ posted: 40, suppressed: 0 }));
    expect(verdict.status).toBe("improving");
    expect(verdict.reasons.some((r) => r.startsWith("0 findings suppressed") && !r.includes("%"))).toBe(true);
  });

  it("every verdict always carries next actions", () => {
    for (const input of [makeInput({ failedReviews: 1 }), makeInput({ dismissed: 1, resolved: 0 }), makeInput()]) {
      const verdict = computeVerdict(input);
      expect(verdict.nextActions.length).toBeGreaterThan(0);
      expect(verdict.headline.length).toBeGreaterThan(0);
    }
  });
});
