import type { RuleExplanation, RuleSummary } from "../learning/explain.ts";
import type { WeeklyReport } from "../learning/report.ts";
import type { ReplayResult } from "../eval/replay.ts";
import type { ReviewLearningContext } from "../learning/retrieval/retrieval.ts";
import type { Finding } from "../review/types.ts";

// Pure text renderers for the §11 CLI demo. No I/O here — commands compose
// these, main.ts writes. Output is human-facing; tests assert on substrings.

function day(date: Date | null): string {
  return date === null ? "-" : date.toISOString().slice(0, 10);
}

export function renderDryRun(prId: string, findings: Finding[], context: ReviewLearningContext): string {
  const lines = [`PR #${prId}`, "", "AI REVIEW", "────────────────────────────"];
  if (findings.length === 0) {
    lines.push("No findings.");
  }
  for (const finding of findings) {
    lines.push(`⚠️  ${finding.filePath}:${finding.lineStart}`, `     ${finding.message}`);
  }
  const memoryLines = context.memoryContext.length === 0 ? 0 : context.memoryContext.split("\n").length;
  lines.push("", "Learning context:", `  ${countActiveRules(context)} active rules`, `  ${memoryLines} relevant historical findings`);
  return lines.join("\n");
}

// Active rules are the ones retrieval renders; retired/candidate rules do
// not influence reviews, so they are not counted in the learning context.
function countActiveRules(context: ReviewLearningContext): number {
  return context.rulesText.length === 0 ? 0 : context.rulesText.split("\n").length;
}

export function renderRuleList(rules: RuleSummary[]): string {
  if (rules.length === 0) {
    return "No rules for this repo.";
  }
  const lines = rules.map((r) => {
    const scope = r.glob ?? r.patternMessage ?? r.patternId ?? "-";
    return `${r.status.padEnd(9)} ${r.ruleType.padEnd(9)} ${scope}  id=${r.ruleId}${r.createdBy ? ` (${r.createdBy})` : ""}`;
  });
  return ["RULES", "────────────────────────────", ...lines, "", "explain-rule <repo> --rule <id> shows the evidence trail."].join("\n");
}

export function renderExplanation(e: RuleExplanation): string {
  const lines = [
    `RULE: ${e.ruleType}`,
    `PATTERN: ${e.pattern ? `${e.pattern.category} — ${e.pattern.canonicalMessage}` : "(repo-wide)"}`,
    `SCOPE: ${e.glob ?? e.pattern?.canonicalMessage ?? "-"}`,
    `STATUS: ${e.status}`,
    "",
    `Confidence: ${e.confidence === null ? "n/a (manual)" : `${Math.round(e.confidence * 100)}%`}`,
    "",
    "Evidence",
    "────────────────────────────",
    `${e.evidenceCount} similar findings`,
    `  ${e.dismissedCount} dismissed`,
    `  ${e.resolvedCount} resolved`,
  ];
  for (const item of e.evidence) {
    const reason = item.dismissalReason ? ` (${item.dismissalReason})` : "";
    lines.push(`  PR #${item.prId} ${item.filePath}:${item.lineStart} [${item.severity}] ${item.outcome}${reason}`);
  }
  lines.push("", `First seen: ${day(e.firstObservedAt)}`, `Last seen: ${day(e.lastObservedAt)}`);
  if (e.deactivatedAt !== null) {
    lines.push(`Retired at: ${day(e.deactivatedAt)}`);
  }
  lines.push(`Created by: ${e.createdBy ?? "-"}`);
  if (e.learnedFromPrs.length > 0) {
    lines.push("", "Learned from:", ...e.learnedFromPrs.map((pr) => `  PR #${pr}`));
  }
  return lines.join("\n");
}

export function renderWeeklyReport(report: WeeklyReport): string {
  const lines = [`Weekly learning report (${day(report.from)} – ${day(report.to)})`, "", `Rules learned: ${report.learnedRules.length}`];
  for (const r of report.learnedRules) {
    lines.push(`  ${r.repo}  pattern ${r.patternId}`);
  }
  lines.push("", `Rules retired: ${report.retiredRules.length}`);
  for (const r of report.retiredRules) {
    lines.push(`  ${r.repo}  retired by ${r.retiredBy}`);
  }
  lines.push("", "Dismissals by category:");
  if (report.dismissalsByCategory.length === 0) {
    lines.push("  (none this week)");
  }
  for (const d of report.dismissalsByCategory) {
    lines.push(`  ${d.category}: ${d.count}`);
  }
  lines.push("", `Dismissed errors needing human confirmation: ${report.needsConfirmation.length}`);
  for (const p of report.needsConfirmation) {
    lines.push(`  [NEEDS CONFIRMATION] ${p.repo}#${p.prId} ${p.filePath} — ${p.message}`);
    if (p.reason) lines.push(`    dismissed: ${p.reason}`);
    lines.push(`    confirm: confirm-dismissal ${p.repo} --finding ${p.findingId}`);
  }
  return lines.join("\n");
}

export function renderReplay(result: ReplayResult): string {
  const lines = ["Eval replay", `prompt_version: ${result.promptVersion}`, `rules_version: ${result.rulesVersion}`, `Precision: ${result.precision.toFixed(2)}`, `Recall: ${result.recall.toFixed(2)}`, "Per case:"];
  for (const c of result.perCase) {
    lines.push(`  ${c.repo} #${c.prId}  precision ${c.precision.toFixed(2)}  recall ${c.recall.toFixed(2)}`);
  }
  return lines.join("\n");
}
