import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";

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
  const ids: string[] = [];
  for (const row of rows) {
    const inserted = await db.insert(findings).values(row).onConflictDoNothing().returning({ id: findings.id });
    const id = inserted[0]?.id;
    if (id) {
      ids.push(id);
      continue;
    }
    // Conflict: a worker retry re-posting the same review has already inserted
    // this finding (idempotent posting, §4). Resolve the existing row so the
    // retry attributes status updates + comment links to it instead of posting
    // to nothing. The unique index is (repo, pr_id, commit_sha, file_path,
    // line_start, line_end, message).
    const existing = await db
      .select({ id: findings.id })
      .from(findings)
      .where(and(eq(findings.repo, row.repo), eq(findings.prId, row.prId), eq(findings.commitSha, row.commitSha), eq(findings.filePath, row.filePath), eq(findings.lineStart, row.lineStart), eq(findings.lineEnd, row.lineEnd), eq(findings.message, row.message)))
      .limit(1);
    const existingId = existing[0]?.id;
    // SAFETY: the finding was just (re)inserted with onConflictDoNothing, so a
    // pre-existing row for these exact unique-index columns is guaranteed.
    if (!existingId) throw new Error("failed to resolve finding id after upsert");
    ids.push(existingId);
  }
  return ids;
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

// Prior findings drive cross-commit dedup: don't re-flag on a new commit a
// pattern already flagged at the same lines on an earlier commit. The current
// commit must be excluded — a worker retry re-runs the same review, so the
// prior rows include its OWN pending findings; matching them would drop every
// finding and report posted: 0.
export async function fetchPriorFindings(db: Db, repo: string, prId: string, excludeCommitSha: string): Promise<PriorFinding[]> {
  const rows = await db
    .select({
      filePath: findings.filePath,
      lineStart: findings.lineStart,
      lineEnd: findings.lineEnd,
      patternUuid: findings.patternId,
      commitSha: findings.commitSha,
    })
    .from(findings)
    .where(and(eq(findings.repo, repo), eq(findings.prId, prId), ne(findings.commitSha, excludeCommitSha)));
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
    .set({
      status,
      error,
      startedAt: status === "running" ? new Date() : undefined,
      completedAt: status === "done" || status === "failed" ? new Date() : undefined,
    })
    .where(eq(reviews.id, reviewId));
}

// §3 reproducibility: record exactly which model, prompt version, rules and
// retrieval version produced a review, so "why did the bot decide this" stays
// answerable months later. Enqueued-but-never-processed reviews keep NULLs.
export interface ReviewRepro {
  model: string;
  promptVersion: string;
  rulesVersion: string;
  retrievalVersion: string;
}

export async function recordReviewRepro(db: Db, reviewId: string, repro: ReviewRepro): Promise<void> {
  await db
    .update(reviews)
    .set({
      model: repro.model,
      promptVersion: repro.promptVersion,
      rulesVersion: repro.rulesVersion,
      retrievalVersion: repro.retrievalVersion,
    })
    .where(eq(reviews.id, reviewId));
}
