import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import type { SuppressionRules } from "../../review/types.ts";
import { findings, patterns, repoRules } from "../../db/schema.ts";

// §5.8 Read model. Retrieval excludes dismissed patterns (deterministic
// suppression) and renders active rules into the prompt's REPO RULES section.
// The post-filter is the hard enforcer; the prompt is the soft layer.

// §3 / §13: distinguishes retrieval strategies (V1 taxonomy/pattern vs V2
// embeddings) so §5.7 quasi-experiments can compare dismissal rates across a
// switch. A content hash would churn on every review and couldn't express the
// strategy flip; exact-bytes reproducibility lives in `llm_calls.prompt_hash`.
// Bump only when the retrieval logic changes shape.
export const RETRIEVAL_VERSION = "v1";

// rules_version: deterministic fingerprint over the rendered rules actually
// injected into a prompt (or the replay's rules). "none" when no rules were
// in play, so an unlabeled run can never masquerade as a rules run. Shared by
// the review pipeline and the eval harness so their rules_version labels are
// comparable (§10).
export function computeRulesVersion(rulesTexts: string[]): string {
  const nonEmpty = [...new Set(rulesTexts.filter((t) => t.length > 0))].sort();
  if (nonEmpty.length === 0) return "none";
  return createHash("sha256").update(nonEmpty.join("\n")).digest("hex").slice(0, 12);
}

export interface ReviewLearningContext {
  rulesText: string;
  memoryContext: string;
  suppression: SuppressionRules;
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

  // Deterministic suppression the post-filter enforces. Learner-created ignore
  // rules suppress a pattern everywhere (patternId set, glob null); manual
  // ignore rules suppress a path (glob set, patternId null). The protected
  // category exemption lives in the post-filter, not here.
  const patternIds = new Set<string>();
  const globs: string[] = [];
  for (const rule of activeRules) {
    if (rule.ruleType !== "ignore") continue;
    if (rule.glob !== null) {
      globs.push(rule.glob);
    } else if (rule.patternId) {
      patternIds.add(rule.patternId);
    }
  }

  const memoryContext = await buildMemoryContext(db, repo, patternIds);
  return { rulesText, memoryContext, suppression: { patternIds, globs } };
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
