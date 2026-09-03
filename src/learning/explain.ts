import { and, asc, eq } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { findingOutcomes, findings, patterns, repoRules, ruleEvidence } from "../db/schema.ts";
import type { RulePayload } from "./retrieval/retrieval.ts";

// §11 explain-rule: rule -> findings -> outcomes. The evidence trail is the
// whole point — an agent that can't show why it learned something isn't
// trustworthy. Queries only; the CLI renders.

export interface RuleEvidenceItem {
  findingId: string;
  prId: string;
  filePath: string;
  lineStart: number | null;
  severity: string;
  outcome: string;
  dismissalReason: string | null;
}

export interface RuleExplanation {
  ruleId: string;
  repo: string;
  ruleType: string;
  status: string;
  glob: string | null;
  payload: RulePayload;
  pattern: { id: string; category: string; canonicalMessage: string } | null;
  confidence: number | null;
  evidenceCount: number;
  dismissedCount: number;
  resolvedCount: number;
  positiveCount: number;
  negativeCount: number;
  createdBy: string | null;
  firstObservedAt: Date | null;
  lastObservedAt: Date | null;
  deactivatedAt: Date | null;
  evidence: RuleEvidenceItem[];
  learnedFromPrs: string[];
}

export async function explainRule(db: Db, repo: string, ruleId: string): Promise<RuleExplanation | null> {
  const ruleRows = await db
    .select()
    .from(repoRules)
    .where(and(eq(repoRules.id, ruleId), eq(repoRules.repo, repo)))
    .limit(1);
  const rule = ruleRows[0];
  if (rule === undefined) return null;

  let patternInfo: RuleExplanation["pattern"] = null;
  if (rule.patternId !== null) {
    const patternRows = await db.select().from(patterns).where(eq(patterns.id, rule.patternId)).limit(1);
    const pattern = patternRows[0];
    if (pattern) {
      patternInfo = { id: pattern.id, category: pattern.category, canonicalMessage: pattern.canonicalMessage };
    }
  }

  // SAFETY: rule_evidence rows were written by the learner with the outcome
  // value straight from finding_outcomes.status, already restricted to
  // terminal evidence outcomes.
  const evidenceRows = await db
    .select({
      findingId: findings.id,
      prId: findings.prId,
      filePath: findings.filePath,
      lineStart: findings.lineStart,
      severity: findings.severity,
      outcome: ruleEvidence.outcome,
      dismissalReason: findingOutcomes.dismissalReason,
    })
    .from(ruleEvidence)
    .innerJoin(findings, eq(findings.id, ruleEvidence.findingId))
    .leftJoin(findingOutcomes, eq(findingOutcomes.findingId, ruleEvidence.findingId))
    .where(eq(ruleEvidence.ruleId, ruleId))
    .orderBy(asc(findings.createdAt));

  const evidence: RuleEvidenceItem[] = evidenceRows.map((row) => ({
    findingId: row.findingId,
    prId: row.prId,
    filePath: row.filePath,
    lineStart: row.lineStart,
    severity: row.severity,
    outcome: row.outcome,
    dismissalReason: row.dismissalReason ?? null,
  }));

  const learnedFromPrs = [...new Set(evidence.map((e) => e.prId))].sort();

  return {
    ruleId: rule.id,
    repo: rule.repo,
    ruleType: rule.ruleType,
    status: rule.status,
    glob: rule.glob,
    // SAFETY: repo_rules.payload was written by the learner or a manual rule
    // adder with exactly the fields RulePayload describes.
    payload: rule.payload as RulePayload,
    pattern: patternInfo,
    confidence: rule.confidence === null ? null : Number(rule.confidence),
    evidenceCount: rule.evidenceCount ?? 0,
    dismissedCount: evidence.filter((e) => e.outcome === "dismissed").length,
    resolvedCount: evidence.filter((e) => e.outcome === "resolved").length,
    positiveCount: rule.positiveCount ?? 0,
    negativeCount: rule.negativeCount ?? 0,
    createdBy: rule.createdBy,
    firstObservedAt: rule.firstObservedAt,
    lastObservedAt: rule.lastObservedAt,
    deactivatedAt: rule.deactivatedAt,
    evidence,
    learnedFromPrs,
  };
}

export interface RuleSummary {
  ruleId: string;
  ruleType: string;
  status: string;
  glob: string | null;
  patternId: string | null;
  patternCategory: string | null;
  patternMessage: string | null;
  confidence: number | null;
  createdBy: string | null;
}

// The listing for `explain-rule <repo>` with no selector: enough identity to
// pick a rule id, cheap enough to run on any repo.
export async function listRulesForRepo(db: Db, repo: string): Promise<RuleSummary[]> {
  const rows = await db
    .select({
      ruleId: repoRules.id,
      ruleType: repoRules.ruleType,
      status: repoRules.status,
      glob: repoRules.glob,
      patternId: repoRules.patternId,
      confidence: repoRules.confidence,
      createdBy: repoRules.createdBy,
      patternCategory: patterns.category,
      patternMessage: patterns.canonicalMessage,
    })
    .from(repoRules)
    .leftJoin(patterns, eq(patterns.id, repoRules.patternId))
    .where(eq(repoRules.repo, repo))
    .orderBy(asc(repoRules.createdAt));

  return rows.map((r) => ({
    ruleId: r.ruleId,
    ruleType: r.ruleType,
    status: r.status,
    glob: r.glob,
    patternId: r.patternId,
    patternCategory: r.patternCategory ?? null,
    patternMessage: r.patternMessage ?? null,
    confidence: r.confidence === null ? null : Number(r.confidence),
    createdBy: r.createdBy,
  }));
}
