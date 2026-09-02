export interface EvalFinding {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  category: string;
  message: string;
}

export interface EvalMetrics {
  precision: number;
  recall: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

const LINE_TOLERANCE = 5;

function matches(agent: EvalFinding, golden: EvalFinding): boolean {
  return agent.filePath === golden.filePath && agent.category === golden.category && Math.abs(agent.lineStart - golden.lineStart) <= LINE_TOLERANCE;
}

/**
 * Compare agent findings against a golden set of human comments. A finding is a
 * true positive if it fuzzy-matches a golden comment on file, category, and
 * line (within tolerance). Each golden comment is matched at most once.
 */
export function computeMetrics(agentFindings: EvalFinding[], golden: EvalFinding[]): EvalMetrics {
  const matchedGolden = new Set<number>();
  let truePositives = 0;

  for (const agent of agentFindings) {
    const index = golden.findIndex((g, i) => !matchedGolden.has(i) && matches(agent, g));
    if (index !== -1) {
      matchedGolden.add(index);
      truePositives++;
    }
  }

  const falsePositives = agentFindings.length - truePositives;
  const falseNegatives = golden.length - truePositives;
  const precision = agentFindings.length === 0 ? 0 : truePositives / agentFindings.length;
  const recall = golden.length === 0 ? 0 : truePositives / golden.length;

  return { precision, recall, truePositives, falsePositives, falseNegatives };
}
