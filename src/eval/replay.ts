import { chunkDiff } from "../review/pipeline/chunk.ts";
import { parseReviewOutput } from "../review/parse/parse.ts";
import { buildPrompt, PROMPT_VERSION } from "../review/prompts/build.ts";
import { computeRulesVersion } from "../learning/retrieval/retrieval.ts";
import { computeMetrics, type EvalFinding } from "./metrics.ts";
import type { LLMClient } from "../llm/client.ts";

// §10 offline eval harness: replay historical PRs against a golden set of
// human comments and report precision/recall per prompt_version x
// rules_version — prompt iteration without spamming real PRs.

export interface ReplayCase {
  repo: string;
  prId: string;
  diff: string;
  golden: EvalFinding[];
  // Learned rules + memory for this repo, threaded into the prompt so the
  // replay measures the rules the agent would actually run with.
  rulesText?: string;
  memoryContext?: string;
}

export interface ReplayDeps {
  llm: LLMClient;
}

export interface ReplayResult {
  promptVersion: string;
  rulesVersion: string;
  precision: number;
  recall: number;
  perCase: Array<{ repo: string; prId: string; precision: number; recall: number }>;
}

// rules_version fingerprint lives in learning/retrieval/retrieval.ts (shared
// with the review pipeline so eval and production labels are comparable).

export async function runReplay(deps: ReplayDeps, cases: ReplayCase[]): Promise<ReplayResult> {
  const perCase: ReplayResult["perCase"] = [];

  for (const c of cases) {
    const chunks = chunkDiff(c.diff);
    const agentFindings: EvalFinding[] = [];

    for (const chunk of chunks) {
      const prompt = buildPrompt({ diff: chunk.raw, repo: c.repo, prId: c.prId, rulesText: c.rulesText, memoryContext: c.memoryContext });
      const raw = await deps.llm.review(prompt);
      const findings = parseReviewOutput(raw);
      agentFindings.push(...findings.map((f) => ({ filePath: f.filePath, lineStart: f.lineStart, lineEnd: f.lineEnd, category: f.category, message: f.message })));
    }

    const metrics = computeMetrics(agentFindings, c.golden);
    perCase.push({ repo: c.repo, prId: c.prId, precision: metrics.precision, recall: metrics.recall });
  }

  const precision = perCase.reduce((sum, c) => sum + c.precision, 0) / (perCase.length || 1);
  const recall = perCase.reduce((sum, c) => sum + c.recall, 0) / (perCase.length || 1);

  return {
    promptVersion: PROMPT_VERSION,
    rulesVersion: computeRulesVersion(cases.map((c) => c.rulesText ?? "")),
    precision,
    recall,
    perCase,
  };
}
