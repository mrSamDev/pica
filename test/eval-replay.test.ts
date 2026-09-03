import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { PROMPT_VERSION } from "../src/review/prompts/build.ts";
import { runReplay, type ReplayCase } from "../src/eval/replay.ts";

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
@@ -40,1 +40,2 @@
+if (!token.exp) { throw new Error("missing exp"); }
`;

const AGENT_JSON = JSON.stringify([{ filePath: "src/auth.ts", lineStart: 40, lineEnd: 40, category: "security", patternId: "security:jwt-expiration", severity: "warning", message: "JWT expiration isn't validated." }]);

const GOLDEN = [{ filePath: "src/auth.ts", lineStart: 41, lineEnd: 41, category: "security", message: "JWT expiration isn't validated." }];

function makeLlm() {
  const prompts: string[] = [];
  return {
    prompts,
    llm: {
      review: async (prompt: string) => {
        prompts.push(prompt);
        return AGENT_JSON;
      },
    },
  };
}

describe("eval --replay (§10: precision/recall per prompt_version x rules_version)", () => {
  it("threads learned rules into the replay prompts and labels the result", async () => {
    const { llm, prompts } = makeLlm();
    const cases: ReplayCase[] = [{ repo: "owner/api", prId: "142", diff: DIFF, golden: GOLDEN, rulesText: '- [ignore] Stop flagging "generated/**" (build output)' }];

    const result = await runReplay({ llm }, cases);

    expect(result.promptVersion).toBe(PROMPT_VERSION);
    expect(result.rulesVersion).not.toBe("none");
    // The rule text reached the prompt the LLM actually saw.
    expect(prompts[0]).toContain("Stop flagging");
    // Agent finding fuzzy-matches the golden comment (line 40 vs 41).
    expect(result.precision).toBeCloseTo(1);
    expect(result.recall).toBeCloseTo(1);
    expect(result.perCase).toEqual([{ repo: "owner/api", prId: "142", precision: 1, recall: 1 }]);
  });

  it("rules_version is a deterministic hash of the rules used, or 'none' when empty", async () => {
    const { llm } = makeLlm();
    const rulesText = '- [ignore] Stop flagging "dist/**"';
    const expected = createHash("sha256").update(rulesText).digest("hex").slice(0, 12);

    const withRules = await runReplay({ llm }, [{ repo: "r", prId: "1", diff: DIFF, golden: [], rulesText }]);
    const withRulesAgain = await runReplay({ llm }, [{ repo: "r", prId: "1", diff: DIFF, golden: [], rulesText }]);
    const withoutRules = await runReplay({ llm }, [{ repo: "r", prId: "1", diff: DIFF, golden: [] }]);

    expect(withRules.rulesVersion).toBe(expected);
    expect(withRulesAgain.rulesVersion).toBe(withRules.rulesVersion);
    expect(withoutRules.rulesVersion).toBe("none");
  });

  it("multiple repos: the version hashes all repos' rules, cases stay per-repo", async () => {
    const { llm } = makeLlm();
    const rulesA = '- [ignore] Stop flagging "a/**"';
    const rulesB = '- [ignore] Stop flagging "b/**"';
    const expected = createHash("sha256").update([rulesA, rulesB].sort().join("\n")).digest("hex").slice(0, 12);

    const result = await runReplay({ llm }, [
      { repo: "a", prId: "1", diff: DIFF, golden: GOLDEN, rulesText: rulesA },
      { repo: "b", prId: "2", diff: DIFF, golden: [], rulesText: rulesB },
    ]);

    expect(result.rulesVersion).toBe(expected);
    expect(result.perCase.map((c) => c.repo)).toEqual(["a", "b"]);
  });
});
