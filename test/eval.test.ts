import { describe, expect, it } from "vitest";

import { computeMetrics, type EvalFinding } from "../src/eval/metrics.ts";

function f(filePath: string, lineStart: number, category: string): EvalFinding {
  return { filePath, lineStart, lineEnd: lineStart, category, message: "" };
}

describe("eval metrics", () => {
  it("computes precision and recall with fuzzy match", () => {
    const agent = [f("src/auth.ts", 42, "security"), f("src/user.ts", 10, "style"), f("src/api.ts", 5, "security")];
    const golden = [f("src/auth.ts", 44, "security"), f("src/user.ts", 10, "style"), f("src/db.ts", 3, "security")];

    const metrics = computeMetrics(agent, golden);

    // agent[0] matches golden[0] (line 42 vs 44, within tolerance).
    // agent[1] matches golden[1]. agent[2] matches nothing.
    expect(metrics.truePositives).toBe(2);
    expect(metrics.falsePositives).toBe(1);
    expect(metrics.falseNegatives).toBe(1);
    expect(metrics.precision).toBeCloseTo(2 / 3);
    expect(metrics.recall).toBeCloseTo(2 / 3);
  });

  it("handles empty inputs", () => {
    expect(computeMetrics([], [])).toEqual({ precision: 0, recall: 0, truePositives: 0, falsePositives: 0, falseNegatives: 0 });
    expect(computeMetrics([f("a.ts", 1, "x")], []).precision).toBe(0);
    expect(computeMetrics([], [f("a.ts", 1, "x")]).recall).toBe(0);
  });
});
