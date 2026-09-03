import { describe, expect, it } from "vitest";

import { globMatchesPath } from "../src/review/glob.ts";

describe("globMatchesPath", () => {
  it("matches a trailing ** directory ignore", () => {
    expect(globMatchesPath("generated/**", "generated/a.ts")).toBe(true);
    expect(globMatchesPath("generated/**", "generated/x/y.ts")).toBe(true);
  });

  it("does not over-match a trailing ** ignore", () => {
    // Root-anchored: a sibling dir with a similar name must not match.
    expect(globMatchesPath("generated/**", "src/generated/a.ts")).toBe(false);
    expect(globMatchesPath("generated/**", "generator/a.ts")).toBe(false);
    expect(globMatchesPath("generated/**", "src/auth.ts")).toBe(false);
  });

  it("matches ** between segments as zero or more directories", () => {
    expect(globMatchesPath("src/**/*.test.ts", "src/x.test.ts")).toBe(true);
    expect(globMatchesPath("src/**/*.test.ts", "src/a/b/x.test.ts")).toBe(true);
    expect(globMatchesPath("src/**/*.test.ts", "src/a.ts")).toBe(false);
  });

  it("matches a leading ** at any depth", () => {
    expect(globMatchesPath("**/generated/**", "src/generated/a.ts")).toBe(true);
    expect(globMatchesPath("**/generated/**", "a/b/c/generated/x.ts")).toBe(true);
    expect(globMatchesPath("**/generated/**", "src/other/a.ts")).toBe(false);
  });

  it("matches a single * without crossing slashes", () => {
    expect(globMatchesPath("src/*.ts", "src/auth.ts")).toBe(true);
    expect(globMatchesPath("src/*.ts", "src/sub/auth.ts")).toBe(false);
  });

  it("match ? for a single char", () => {
    expect(globMatchesPath("src/a?.ts", "src/a1.ts")).toBe(true);
    expect(globMatchesPath("src/a?.ts", "src/a.ts")).toBe(false);
  });
});
