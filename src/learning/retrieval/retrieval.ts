import { and, desc, eq } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { findings, patterns, repoRules } from "../../db/schema.ts";

// §5.8 Read model. Retrieval excludes dismissed patterns (deterministic
// suppression) and renders active rules into the prompt's REPO RULES section.
// The post-filter is the hard enforcer; the prompt is the soft layer.

export interface ReviewLearningContext {
  rulesText: string;
  memoryContext: string;
  suppressedPatternIds: Set<string>;
}

// Display fields written by the learner (patternKey/reason) and manual rule
// adders. Unknown fields are ignored for rendering.
export interface RulePayload {
  patternKey?: string;
  reason?: string;
  pattern?: string;
  description?: string;
  pathPrefix?: string;
  reviewDepth?: string;
}

export function formatRule(rule: typeof repoRules.$inferSelect): string {
  // SAFETY: repo_rules.payload is written by the learner or manual rule adders
  // using exactly these fields; a foreign payload renders via the default case.
  const p = rule.payload as RulePayload;
  switch (rule.ruleType) {
    case "ignore": {
      const scope = rule.glob ?? p.patternKey ?? "";
      const reason = p.reason ? ` (${p.reason})` : "";
      return `- [ignore] Stop flagging "${scope}"${reason}`;
    }
    case "emphasize":
      return `- [emphasize] Emphasize "${p.pattern ?? ""}"${p.reason ? ` (${p.reason})` : ""}`;
    case "style":
      return `- [style] ${p.description ?? ""}`;
    case "scope":
      return `- [scope] ${p.pathPrefix ?? ""}: ${p.reviewDepth ?? ""}`;
    default:
      return `- [${rule.ruleType}] ${JSON.stringify(p)}`;
  }
}

export function renderRules(rules: (typeof repoRules.$inferSelect)[]): string {
  if (rules.length === 0) return "";
  const sorted = [...rules].sort((a, b) => (a.ruleType + (a.glob ?? "")).localeCompare(b.ruleType + (b.glob ?? "")));
  return sorted.map(formatRule).join("\n");
}

export async function getReviewLearningContext(db: Db, repo: string): Promise<ReviewLearningContext> {
  const activeRules = await db
    .select()
    .from(repoRules)
    .where(and(eq(repoRules.repo, repo), eq(repoRules.status, "active")));
  const rulesText = renderRules(activeRules);

  const suppressedPatternIds = new Set<string>();
  for (const rule of activeRules) {
    if (rule.ruleType === "ignore" && rule.patternId) suppressedPatternIds.add(rule.patternId);
  }

  const memoryContext = await buildMemoryContext(db, repo, suppressedPatternIds);
  return { rulesText, memoryContext, suppressedPatternIds };
}

// Compact memory of patterns the repo has flagged before, excluding any pattern
// an active ignore rule suppresses (§5.8: retrieval excludes dismissed). Kept
// small so a long-lived repo doesn't blow up the prompt.
async function buildMemoryContext(db: Db, repo: string, suppressed: ReadonlySet<string>): Promise<string> {
  const rows = await db
    .select({
      patternKey: patterns.canonicalMessage,
      category: patterns.category,
      patternId: patterns.id,
      message: findings.message,
      createdAt: findings.createdAt,
    })
    .from(findings)
    .innerJoin(patterns, eq(patterns.id, findings.patternId))
    .where(eq(findings.repo, repo))
    .orderBy(desc(findings.createdAt))
    .limit(60);

  const byPattern = new Map<string, string>();
  for (const row of rows) {
    if (!row.patternId || suppressed.has(row.patternId)) continue;
    const key = `${row.category}:${row.patternKey}`;
    if (!byPattern.has(key)) byPattern.set(key, row.message ?? "");
  }

  const lines = Array.from(byPattern.entries())
    .slice(0, 15)
    .map(([key, example]) => `- ${key}${example ? ` — e.g. "${example.slice(0, 200)}"` : ""}`);
  return lines.join("\n");
}
