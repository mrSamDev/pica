import { describe, expect, it } from "vitest";

import { parseReviewOutput } from "../src/review/parse/parse.ts";

const validOutput = JSON.stringify([
  {
    filePath: "src/auth.ts",
    lineStart: 42,
    lineEnd: 42,
    category: "security",
    patternId: "security:jwt-expiration",
    severity: "error",
    message: "JWT expiration isn't validated.",
  },
]);

describe("parse", () => {
  it("rejects malformed LLM output", () => {
    expect(() => parseReviewOutput("not json at all")).toThrow(/not valid JSON/);
    expect(() => parseReviewOutput("")).toThrow(/Empty/);
    expect(() => parseReviewOutput(JSON.stringify([{ filePath: "x" }]))).toThrow(/schema/);
    expect(() => parseReviewOutput(JSON.stringify({ not: "an array" }))).toThrow(/schema/);
  });

  it("accepts valid output with pattern_id", () => {
    const findings = parseReviewOutput(validOutput);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.patternId).toBe("security:jwt-expiration");
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.filePath).toBe("src/auth.ts");
  });

  it("strips code fences", () => {
    const fenced = `\`\`\`json\n${validOutput}\n\`\`\``;
    const findings = parseReviewOutput(fenced);
    expect(findings).toHaveLength(1);
  });
});
