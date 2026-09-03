import { describe, expect, it } from "vitest";

import { applyPostFilter } from "../src/review/postfilter/postfilter.ts";
import type { ExistingComment, Finding, PriorFinding } from "../src/review/types.ts";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    filePath: "src/auth.ts",
    lineStart: 42,
    lineEnd: 42,
    category: "security",
    patternId: "security:jwt-expiration",
    patternUuid: "11111111-1111-1111-1111-111111111111",
    severity: "error",
    message: "JWT expiration isn't validated.",
    ...overrides,
  };
}

// SAFETY: empty arrays are valid inputs for these post-filter collections.
const empty = {
  existingComments: [] as ExistingComment[],
  priorFindings: [] as PriorFinding[],
  protectedCategories: new Set(["security", "data", "concurrency"]),
};

describe("postfilter", () => {
  it("dedups by (pr_id, pattern_id): five phrasings become one comment", () => {
    const phrasings = Array.from({ length: 5 }, (_, i) => finding({ message: `phrasing ${i}` }));
    const result = applyPostFilter({ prId: "42", findings: phrasings, suppressedPatternIds: new Set(), ...empty });
    expect(result.findings).toHaveLength(1);
    expect(result.dropped).toHaveLength(4);
    expect(result.dropped.every((d) => d.reason === "duplicate")).toBe(true);
  });

  it("skips suppressed patterns deterministically", () => {
    const findings = [finding({ patternUuid: "22222222-2222-2222-2222-222222222222", severity: "warning" }), finding({ patternUuid: "11111111-1111-1111-1111-111111111111", severity: "warning" })];
    const result = applyPostFilter({ prId: "42", findings, suppressedPatternIds: new Set(["22222222-2222-2222-2222-222222222222"]), ...empty });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.patternUuid).toBe("11111111-1111-1111-1111-111111111111");
    expect(result.dropped[0]?.reason).toBe("suppressed");
  });

  it("§5.5: severity=error in a protected category is exempt from auto-suppression", () => {
    // error + protected category -> kept (defense in depth), even though the
    // pattern is in the suppressed set.
    const exempt = applyPostFilter({
      prId: "42",
      findings: [finding({ category: "security", severity: "error" })],
      suppressedPatternIds: new Set(["11111111-1111-1111-1111-111111111111"]),
      ...empty,
    });
    expect(exempt.findings).toHaveLength(1);
    expect(exempt.dropped).toHaveLength(0);
  });

  it("§5.5: suppression still applies to protected categories below error severity", () => {
    const suppressed = applyPostFilter({
      prId: "42",
      findings: [finding({ category: "security", severity: "warning" })],
      suppressedPatternIds: new Set(["11111111-1111-1111-1111-111111111111"]),
      ...empty,
    });
    expect(suppressed.findings).toHaveLength(0);
    expect(suppressed.dropped[0]?.reason).toBe("suppressed");
  });

  it("§5.5: errors outside a protected category are still suppressible", () => {
    const suppressed = applyPostFilter({
      prId: "42",
      findings: [finding({ category: "correctness", severity: "error" })],
      suppressedPatternIds: new Set(["11111111-1111-1111-1111-111111111111"]),
      ...empty,
    });
    expect(suppressed.findings).toHaveLength(0);
    expect(suppressed.dropped[0]?.reason).toBe("suppressed");
  });

  it("skips findings duplicating existing human comments", () => {
    const existingComments: ExistingComment[] = [{ filePath: "src/auth.ts", lineStart: 42, lineEnd: 42, category: "security", message: "JWT expiration isn't validated." }];
    const result = applyPostFilter({ prId: "42", findings: [finding()], suppressedPatternIds: new Set(), existingComments, priorFindings: [], protectedCategories: new Set() });
    expect(result.findings).toHaveLength(0);
    expect(result.dropped[0]?.reason).toBe("repeat-human");
  });

  it("cross-commit dedup: no re-flag on commit B unless lines changed", () => {
    const priorFindings: PriorFinding[] = [{ filePath: "src/auth.ts", lineStart: 42, lineEnd: 42, patternUuid: "11111111-1111-1111-1111-111111111111", commitSha: "commitA" }];
    // Same pattern at the same lines on a later commit → dropped.
    const sameLines = applyPostFilter({ prId: "42", findings: [finding()], suppressedPatternIds: new Set(), existingComments: [], priorFindings, protectedCategories: new Set() });
    expect(sameLines.findings).toHaveLength(0);
    expect(sameLines.dropped[0]?.reason).toBe("cross-commit");

    // Same pattern but the lines changed → re-flag.
    const changedLines = applyPostFilter({
      prId: "42",
      findings: [finding({ lineStart: 100, lineEnd: 100 })],
      suppressedPatternIds: new Set(),
      existingComments: [],
      priorFindings,
      protectedCategories: new Set(),
    });
    expect(changedLines.findings).toHaveLength(1);
  });
});
