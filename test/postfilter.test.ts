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
    severity: "error",
    message: "JWT expiration isn't validated.",
    ...overrides,
  };
}

// SAFETY: empty arrays are valid inputs for these post-filter collections.
const empty = { existingComments: [] as ExistingComment[], priorFindings: [] as PriorFinding[] };

describe("postfilter", () => {
  it("dedups by (pr_id, pattern_id): five phrasings become one comment", () => {
    const phrasings = Array.from({ length: 5 }, (_, i) => finding({ message: `phrasing ${i}` }));
    const result = applyPostFilter({ prId: "42", findings: phrasings, suppressedPatternIds: new Set(), ...empty });
    expect(result.findings).toHaveLength(1);
    expect(result.dropped).toHaveLength(4);
    expect(result.dropped.every((d) => d.reason === "duplicate")).toBe(true);
  });

  it("skips suppressed patterns deterministically", () => {
    const findings = [finding({ patternId: "complexity:high" }), finding({ patternId: "security:jwt-expiration" })];
    const result = applyPostFilter({ prId: "42", findings, suppressedPatternIds: new Set(["complexity:high"]), ...empty });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.patternId).toBe("security:jwt-expiration");
    expect(result.dropped[0]?.reason).toBe("suppressed");
  });

  it("skips findings duplicating existing human comments", () => {
    const existingComments: ExistingComment[] = [{ filePath: "src/auth.ts", lineStart: 42, lineEnd: 42, category: "security", message: "JWT expiration isn't validated." }];
    const result = applyPostFilter({ prId: "42", findings: [finding()], suppressedPatternIds: new Set(), existingComments, priorFindings: [] });
    expect(result.findings).toHaveLength(0);
    expect(result.dropped[0]?.reason).toBe("repeat-human");
  });

  it("cross-commit dedup: no re-flag on commit B unless lines changed", () => {
    const priorFindings: PriorFinding[] = [{ filePath: "src/auth.ts", lineStart: 42, lineEnd: 42, patternId: "security:jwt-expiration", commitSha: "commitA" }];
    // Same pattern at the same lines on a later commit → dropped.
    const sameLines = applyPostFilter({ prId: "42", findings: [finding()], suppressedPatternIds: new Set(), existingComments: [], priorFindings });
    expect(sameLines.findings).toHaveLength(0);
    expect(sameLines.dropped[0]?.reason).toBe("cross-commit");

    // Same pattern but the lines changed → re-flag.
    const changedLines = applyPostFilter({
      prId: "42",
      findings: [finding({ lineStart: 100, lineEnd: 100 })],
      suppressedPatternIds: new Set(),
      existingComments: [],
      priorFindings,
    });
    expect(changedLines.findings).toHaveLength(1);
  });
});
