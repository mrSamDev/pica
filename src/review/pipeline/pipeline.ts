import { createHash } from "node:crypto";

import type { Config } from "../../config.ts";
import type { Db } from "../../db/client.ts";
import { ensureOutcome } from "../../db/outcomes.ts";
import { emitEvent } from "../../learning/events.ts";
import type { LLMClient } from "../../llm/client.ts";
import type { Metrics } from "../../observability/metrics.ts";
import type { PlatformClient } from "../../platform/types.ts";
import { parseReviewOutput } from "../parse/parse.ts";
import { applyPostFilter } from "../postfilter/postfilter.ts";
import { buildPrompt } from "../prompts/build.ts";
import type { Finding, ReviewRequest } from "../types.ts";
import { chunkDiff } from "./chunk.ts";
import { ensurePattern, fetchPostedCommentId, fetchPriorFindings, fetchSuppressedPatternIds, insertFindings, insertFindingsReturning, insertPostedComment, recordLlmCall, toFindingRow, updateFindingStatus, type FindingRow } from "./queries.ts";
import { buildSummary, severityOrder } from "./summary.ts";

export interface ReviewDeps {
  db: Db;
  platform: PlatformClient;
  llm: LLMClient;
  config: Readonly<Config>;
  metrics: Metrics;
}

export interface ReviewResult {
  findings: Finding[];
  posted: number;
}

function dropStatus(reason: "suppressed" | "duplicate" | "repeat-human" | "cross-commit"): string {
  return reason === "suppressed" ? "suppressed" : "duplicate";
}

export async function runReview(deps: ReviewDeps, request: ReviewRequest): Promise<ReviewResult> {
  const rawDiff = await deps.platform.fetchDiff(request.diffHref);
  const chunks = chunkDiff(rawDiff);

  const allFindings: Finding[] = [];
  for (const chunk of chunks) {
    const prompt = buildPrompt({ diff: chunk.raw, repo: request.repo, prId: request.prId });
    const raw = await deps.llm.review(prompt);
    if (request.mode !== "dry-run") {
      await recordLlmCall(deps.db, {
        reviewId: request.reviewId,
        model: deps.config.LLM_MODEL,
        provider: "openrouter",
        promptHash: createHash("sha256").update(prompt).digest("hex"),
        status: "ok",
      });
    }
    allFindings.push(...parseReviewOutput(raw));
  }

  // dry-run: no DB writes, no posting. A future CLI prints the findings.
  // patternUuid is unresolved here, so the postfilter's dedup would collapse
  // distinct findings; return the raw findings as a preview instead.
  if (request.mode === "dry-run") {
    return { findings: allFindings, posted: 0 };
  }

  const [suppressedPatternIds, priorFindings, existingComments] = await Promise.all([fetchSuppressedPatternIds(deps.db, request.repo), fetchPriorFindings(deps.db, request.repo, request.prId), deps.platform.listComments(request.repo, request.prId)]);

  // Resolve the LLM pattern string to a stable patterns row uuid before the
  // postfilter, so suppression and cross-commit dedup compare uuids, not the
  // LLM's free-text keys.
  for (const finding of allFindings) {
    finding.patternUuid = await ensurePattern(deps.db, request.repo, finding.category, finding.patternId, "v1");
  }

  const filtered = applyPostFilter({
    prId: request.prId,
    findings: allFindings,
    suppressedPatternIds,
    existingComments,
    priorFindings,
  });

  // Severity-sort so the most important findings are posted first when capped.
  const kept = [...filtered.findings].sort(severityOrder);

  const keptRows: FindingRow[] = [];
  for (const finding of kept) {
    keptRows.push(toFindingRow(finding, request.reviewId, request.repo, request.prId, request.commitSha, "pending", finding.patternUuid));
  }

  // Persist dropped findings with their terminal status so the dashboard can
  // count them and the learning loop can see what was suppressed.
  const droppedRows: FindingRow[] = [];
  for (const dropped of filtered.dropped) {
    deps.metrics.findingsSuppressed.inc();
    droppedRows.push(toFindingRow(dropped.finding, request.reviewId, request.repo, request.prId, request.commitSha, dropStatus(dropped.reason), dropped.finding.patternUuid));
  }

  // Insert findings atomically. Platform POSTs happen after, outside the
  // transaction, so a slow comment never holds a DB lock.
  const keptIds = await deps.db.transaction(async (tx) => {
    await insertFindings(tx, droppedRows);
    return insertFindingsReturning(tx, keptRows);
  });

  const writes: Array<{ findingId: string; status: string; commentId?: string }> = [];
  let posted = 0;
  if (request.mode === "observe") {
    for (let i = 0; i < kept.length; i++) {
      const findingId = keptIds[i];
      if (findingId) writes.push({ findingId, status: "observed" });
    }
    if (request.summaryComment && kept.length > 0) {
      await deps.platform.createPrComment(request.repo, request.prId, buildSummary(kept));
    }
  } else {
    for (let i = 0; i < kept.length; i++) {
      const finding = kept[i];
      const findingId = keptIds[i];
      if (!finding || !findingId) continue;
      if (i < request.postingCap) {
        // Idempotent posting: reuse a stored comment_id on worker retry.
        const existing = await fetchPostedCommentId(deps.db, request.platform, findingId);
        let commentId = existing;
        if (!commentId) {
          const comment = await deps.platform.createInlineComment(request.repo, request.prId, { path: finding.filePath, line: finding.lineStart, commitSha: request.commitSha }, finding.message);
          commentId = comment.id;
        }
        writes.push({ findingId, status: "posted", commentId });
        deps.metrics.findingsPosted.inc();
        posted++;
      } else {
        writes.push({ findingId, status: "capped" });
      }
    }
  }

  await deps.db.transaction(async (tx) => {
    for (const write of writes) {
      await updateFindingStatus(tx, write.findingId, write.status);
      if (write.commentId) {
        await insertPostedComment(tx, write.findingId, request.platform, write.commentId);
        // The poller only looks at posted findings; seed the outcome row here.
        await ensureOutcome(tx, write.findingId, "posted");
      }
    }
    await emitEvent(tx, {
      eventKey: `review:${request.reviewId}:completed`,
      repo: request.repo,
      eventType: "review.completed",
      aggregateId: `review:${request.reviewId}`,
      payload: { prId: request.prId, findings: kept.length, posted },
    });
  });

  return { findings: kept, posted };
}
