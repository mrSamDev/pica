import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { findings, llmCalls, patterns, postedComments, repoRules, reviews } from "../../db/schema.ts";
import type { Finding, PriorFinding } from "../types.ts";

export interface FindingRow {
  reviewId: string;
  repo: string;
  prId: string;
  commitSha: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  category: string;
  patternId: string;
  severity: string;
  message: string;
  messageHash: string;
  status: string;
}

export function toFindingRow(finding: Finding, reviewId: string, repo: string, prId: string, commitSha: string, status: string, patternId: string): FindingRow {
  return {
    reviewId,
    repo,
    prId,
    commitSha,
    filePath: finding.filePath,
    lineStart: finding.lineStart,
    lineEnd: finding.lineEnd,
    category: finding.category,
    patternId,
    severity: finding.severity,
    message: finding.message,
    messageHash: createHash("sha256").update(finding.message).digest("hex"),
    status,
  };
}

export async function insertFindings(db: Db, rows: FindingRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(findings).values(rows).onConflictDoNothing();
}

export async function insertFindingsReturning(db: Db, rows: FindingRow[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const inserted = await db.insert(findings).values(rows).onConflictDoNothing().returning({ id: findings.id });
  return inserted.map((row) => row.id);
}

export async function updateFindingStatus(db: Db, id: string, status: string): Promise<void> {
  await db.update(findings).set({ status }).where(eq(findings.id, id));
}

export async function insertPostedComment(db: Db, findingId: string, platform: string, commentId: string): Promise<void> {
  // onConflictDoNothing: a worker retry reusing a stored comment_id must not
  // double-insert (unique index on platform + comment_id is the backstop).
  await db.insert(postedComments).values({ findingId, platform, commentId }).onConflictDoNothing();
}

// Idempotent posting: if a comment was already posted for this finding, return
// its stored comment_id so a worker retry reuses it instead of re-posting.
export async function fetchPostedCommentId(db: Db, platform: string, findingId: string): Promise<string | null> {
  const rows = await db
    .select({ commentId: postedComments.commentId })
    .from(postedComments)
    .where(and(eq(postedComments.platform, platform), eq(postedComments.findingId, findingId)))
    .limit(1);
  return rows[0]?.commentId ?? null;
}

export interface LlmCallRecord {
  reviewId: string;
  model: string;
  provider: string;
  promptHash: string;
  status: string;
}

export async function recordLlmCall(db: Db, call: LlmCallRecord): Promise<void> {
  await db.insert(llmCalls).values({
    reviewId: call.reviewId,
    model: call.model,
    provider: call.provider,
    promptHash: call.promptHash,
    status: call.status,
  });
}

/**
 * Resolve an LLM pattern_id string to a patterns row uuid, creating the row on
 * first sight. The pattern is the learning unit, so it gets a stable row.
 * Throws if the row cannot be created or found — a silent "" would corrupt the
 * finding's pattern link.
 */
export async function ensurePattern(db: Db, repo: string, category: string, patternId: string, patternVersion: string): Promise<string> {
  const inserted = await db.insert(patterns).values({ repo, category, canonicalMessage: patternId, patternVersion, status: "active" }).onConflictDoNothing().returning({ id: patterns.id });
  if (inserted[0]?.id) {
    return inserted[0].id;
  }
  // Conflict: another review created the row concurrently; fetch the existing id.
  const existing = await db
    .select({ id: patterns.id })
    .from(patterns)
    .where(and(eq(patterns.repo, repo), eq(patterns.category, category), eq(patterns.canonicalMessage, patternId)));
  const id = existing[0]?.id;
  if (!id) {
    throw new Error(`Failed to resolve pattern ${repo}/${category}/${patternId}`);
  }
  return id;
}

export async function fetchPriorFindings(db: Db, repo: string, prId: string): Promise<PriorFinding[]> {
  const rows = await db
    .select({
      filePath: findings.filePath,
      lineStart: findings.lineStart,
      lineEnd: findings.lineEnd,
      patternUuid: findings.patternId,
      commitSha: findings.commitSha,
    })
    .from(findings)
    .where(and(eq(findings.repo, repo), eq(findings.prId, prId)));
  return rows.map((row) => ({
    filePath: row.filePath,
    lineStart: row.lineStart ?? 0,
    lineEnd: row.lineEnd ?? 0,
    patternUuid: row.patternUuid ?? "",
    commitSha: row.commitSha,
  }));
}

export async function fetchSuppressedPatternIds(db: Db, repo: string): Promise<Set<string>> {
  const rows = await db
    .select({ patternId: repoRules.patternId })
    .from(repoRules)
    .where(and(eq(repoRules.repo, repo), eq(repoRules.status, "active"), eq(repoRules.ruleType, "ignore")));
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.patternId) ids.add(row.patternId);
  }
  return ids;
}

export async function updateReviewStatus(db: Db, reviewId: string, status: string, error?: string): Promise<void> {
  await db
    .update(reviews)
    .set({ status, error, completedAt: status === "done" || status === "failed" ? new Date() : undefined })
    .where(eq(reviews.id, reviewId));
}
