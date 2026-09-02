import { chunkDiff } from "../review/pipeline/chunk.ts";
import type { ReviewDeps } from "../review/pipeline/pipeline.ts";
import { parseReviewOutput } from "../review/parse/parse.ts";
import { buildPrompt } from "../review/prompts/build.ts";
import { computeMetrics, type EvalFinding } from "./metrics.ts";

export interface ReplayCase {
  repo: string;
  prId: string;
  diff: string;
  golden: EvalFinding[];
}

export interface ReplayResult {
  precision: number;
  recall: number;
  perCase: Array<{ prId: string; precision: number; recall: number }>;
}

export async function runReplay(deps: ReviewDeps, cases: ReplayCase[]): Promise<ReplayResult> {
  const perCase: ReplayResult["perCase"] = [];

  for (const c of cases) {
    const chunks = chunkDiff(c.diff);
    const agentFindings: EvalFinding[] = [];

    for (const chunk of chunks) {
      const prompt = buildPrompt({ diff: chunk.raw, repo: c.repo, prId: c.prId });
      const raw = await deps.llm.review(prompt);
      const findings = parseReviewOutput(raw);
      agentFindings.push(...findings.map((f) => ({ filePath: f.filePath, lineStart: f.lineStart, lineEnd: f.lineEnd, category: f.category, message: f.message })));
    }

    const metrics = computeMetrics(agentFindings, c.golden);
    perCase.push({ prId: c.prId, precision: metrics.precision, recall: metrics.recall });
  }

  const precision = perCase.reduce((sum, c) => sum + c.precision, 0) / (perCase.length || 1);
  const recall = perCase.reduce((sum, c) => sum + c.recall, 0) / (perCase.length || 1);

  return { precision, recall, perCase };
}
