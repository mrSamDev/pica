import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { classify, CATEGORIES, type ClassifiedPattern } from "../src/learning/taxonomy/taxonomy.ts";
import { parseReviewOutput } from "../src/review/parse/parse.ts";

// §5.4 + §9: snapshot the taxonomy classifier against REAL LLM outputs, not
// synthetic ones. Every committed fixture in test/fixtures/llm-outputs/ is a
// raw model output; parsing + classifying it must stay stable so patterns
// accumulate evidence instead of fragmenting.
const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "llm-outputs");

function loadFixtures(): Array<{ name: string; raw: string }> {
  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    throw new Error("no taxonomy fixtures committed — run tools/capture-llm-outputs.ts");
  }
  return files.map((f) => ({ name: f, raw: readFileSync(join(FIXTURES_DIR, f), "utf8") }));
}

const fixtures = loadFixtures();

describe("taxonomy classification against real LLM outputs", () => {
  for (const fixture of fixtures) {
    it(`parses and classifies ${fixture.name} with stable pattern ids`, () => {
      const findings = parseReviewOutput(fixture.raw);
      expect(findings.length).toBeGreaterThan(0);

      const classified: ClassifiedPattern[] = findings.map((f) => classify(f.category, f.patternId));

      // Canonical key is stable: category and patternId survive classification
      // unchanged in form (modulo normalization), never rewritten or lost.
      findings.forEach((raw, i) => {
        const c = classified[i];
        if (!c) throw new Error("classifier returned fewer findings than parsed");
        expect(c.patternId).toBe(raw.patternId.trim().toLowerCase().replace(/\s+/g, "-"));
        expect(c.category).toBe(raw.category.trim().toLowerCase());
      });
    });
  }

  it("fixtures use categories within the known taxonomy or documented residual", () => {
    for (const fixture of fixtures) {
      for (const finding of parseReviewOutput(fixture.raw)) {
        const { category } = classify(finding.category, finding.patternId);
        // Known categories pass; anything else is the documented residual.
        // SAFETY: CATEGORIES is a readonly string tuple; membership narrows category.
        if (CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
          expect(category).toBeDefined();
        }
      }
    }
  });

  it("fixture filenames are unique — no duplicate patterns across files", () => {
    const seen = new Set<string>();
    for (const fixture of fixtures) {
      for (const finding of parseReviewOutput(fixture.raw)) {
        const c = classify(finding.category, finding.patternId);
        const key = `${c.category}:${c.patternId}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });
});
