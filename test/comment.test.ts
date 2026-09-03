import { describe, expect, it } from "vitest";

import type { Finding } from "../src/review/types.ts";
import { withFeedbackFooter } from "../src/review/pipeline/comment.ts";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    filePath: "src/auth.ts",
    lineStart: 42,
    lineEnd: 42,
    category: "security",
    patternId: "security:jwt-expiration",
    patternUuid: "00000000-0000-0000-0000-000000000000",
    severity: "error",
    message: "JWT expiration isn't validated.",
    ...overrides,
  };
}

describe("posted comment body (§5.12 feedback protocol)", () => {
  it("carries the location, the message, and the dismiss protocol", () => {
    const body = withFeedbackFooter(makeFinding());
    expect(body).toContain("src/auth.ts:42");
    expect(body).toContain("JWT expiration isn't validated.");
    expect(body).toContain("Not useful? Reply `dismiss: <reason>`");
  });
});
