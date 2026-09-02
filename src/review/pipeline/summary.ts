import type { Finding } from "../types.ts";

// Max findings shown in the observe-mode summary comment.
export const SUMMARY_CAP = 5;

const severityRank: Record<Finding["severity"], number> = {
  error: 0,
  warning: 1,
  suggestion: 2,
};

export function severityOrder(a: Finding, b: Finding): number {
  return severityRank[a.severity] - severityRank[b.severity];
}

/**
 * Render a capped, severity-prioritized summary of would-be findings. The
 * header states the full count so the team sees the spam that was avoided.
 */
export function buildSummary(findings: Finding[], cap: number = SUMMARY_CAP): string {
  const sorted = [...findings].sort(severityOrder);
  const shown = sorted.slice(0, cap);
  const count = findings.length;
  const header = count > cap ? `${count} findings detected, showing top ${shown.length}` : `${count} finding${count === 1 ? "" : "s"} detected`;
  const lines = shown.map((finding) => `- [${finding.severity}] ${finding.filePath}:${finding.lineStart} — ${finding.message}`);
  return [header, ...lines].join("\n");
}
