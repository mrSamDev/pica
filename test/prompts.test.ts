import { describe, expect, it } from "vitest";

import { CATEGORIES } from "../src/learning/taxonomy/taxonomy.ts";
import { buildPrompt } from "../src/review/prompts/build.ts";

describe("review prompt (§5.4 taxonomy at the boundary)", () => {
  it("enumerates the canonical taxonomy so the LLM emits stable, non-fragmenting categories", () => {
    const prompt = buildPrompt({ diff: "d", repo: "owner/repo", prId: "1" });
    // The prompt must tell the model which categories are canonical; otherwise
    // it invents "auth" vs "security" and evidence fragments across pattern rows.
    expect(prompt).toContain(`category is one of: ${CATEGORIES.join(", ")}.`);
    for (const category of CATEGORIES) {
      expect(prompt).toContain(category);
    }
  });
});
