import { describe, expect, it } from "vitest";

import { buildSummary, SUMMARY_CAP } from "../src/review/pipeline/summary.ts";
import type { Finding, Severity } from "../src/review/types.ts";

function finding(severity: Severity, message: string, lineStart = 1): Finding {
  return { filePath: "src/a.ts", lineStart, lineEnd: lineStart, category: "security", patternId: "p", patternUuid: "p", severity, message };
}

describe("buildSummary", () => {
  it("caps at SUMMARY_CAP findings", () => {
    const findings = Array.from({ length: 10 }, (_, i) => finding("suggestion", `msg ${i}`, i));
    const summary = buildSummary(findings);
    const lines = summary.split("\n");
    expect(lines[0]).toContain("10 findings detected, showing top 5");
    expect(lines.length - 1).toBe(SUMMARY_CAP);
  });

  it("prioritizes errors before warnings before suggestions", () => {
    const findings = [finding("suggestion", "suggestion msg"), finding("error", "error msg"), finding("warning", "warning msg")];
    const summary = buildSummary(findings);
    const lines = summary.split("\n").slice(1);
    expect(lines[0]).toContain("[error]");
    expect(lines[1]).toContain("[warning]");
    expect(lines[2]).toContain("[suggestion]");
  });

  it("states count without 'showing top' when under cap", () => {
    const summary = buildSummary([finding("error", "only one")]);
    expect(summary.split("\n")[0]).toBe("1 finding detected");
  });
});
