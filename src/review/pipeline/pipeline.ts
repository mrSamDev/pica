import { createHash } from "node:crypto";

import type { Config } from "../../config.ts";
import type { Db } from "../../db/client.ts";
import { ensureOutcome } from "../../db/outcomes.ts";
import { emitEvent } from "../../learning/events.ts";
import type { LLMClient } from "../../llm/client.ts";
import type { PlatformClient } from "../../platform/types.ts";
import { parseReviewOutput } from "../parse/parse.ts";
import { applyPostFilter } from "../postfilter/postfilter.ts";
import { buildPrompt } from "../prompts/build.ts";
import type { Finding, ReviewRequest } from "../types.ts";
import { chunkDiff } from "./chunk.ts";
import { ensurePattern, fetchPriorFindings, fetchSuppressedPatternIds, insertFindings, insertFindingsReturning, insertPostedComment, recordLlmCall, toFindingRow, updateFindingStatus } from "./queries.ts";
import { buildSummary, severityOrder } from "./summary.ts";

export interface ReviewDeps {
  db: Db;
  platform: PlatformClient;
  llm: LLMClient;
  config: Readonly<Config>;
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

  const [suppressedPatternIds, priorFindings, existingComments] = await Promise.all([fetchSuppressedPatternIds(deps.db, request.repo), fetchPriorFindings(deps.db, request.repo, request.prId), deps.platform.listComments(request.repo, request.prId)]);

  const filtered = applyPostFilter({
    prId: request.prId,
    findings: allFindings,
    suppressedPatternIds,
    existingComments,
    priorFindings,
  });

  // dry-run: no DB writes, no posting. A future CLI prints the findings.
  if (request.mode === "dry-run") {
    return { findings: filtered.findings, posted: 0 };
  }

  // Severity-sort so the most important findings are posted first when capped.
  const kept = [...filtered.findings].sort(severityOrder);

  const keptRows = [];
  for (const finding of kept) {
    const patternId = await ensurePattern(deps.db, request.repo, finding.category, finding.patternId, "v1");
    keptRows.push(toFindingRow(finding, request.reviewId, request.repo, request.prId, request.commitSha, "pending", patternId));
  }
  const keptIds = await insertFindingsReturning(deps.db, keptRows);

  // Persist dropped findings with their terminal status so the dashboard can
  // count them and the learning loop can see what was suppressed.
  const droppedRows = [];
  for (const dropped of filtered.dropped) {
    const patternId = await ensurePattern(deps.db, request.repo, dropped.finding.category, dropped.finding.patternId, "v1");
    droppedRows.push(toFindingRow(dropped.finding, request.reviewId, request.repo, request.prId, request.commitSha, dropStatus(dropped.reason), patternId));
  }
  await insertFindings(deps.db, droppedRows);

  let posted = 0;
  if (request.mode === "observe") {
    // Record + count, don't spam the team. Optionally one capped summary comment.
    for (let i = 0; i < kept.length; i++) {
      const findingId = keptIds[i];
      if (findingId) await updateFindingStatus(deps.db, findingId, "observed");
    }
    if (request.summaryComment && kept.length > 0) {
      await deps.platform.createPrComment(request.repo, request.prId, buildSummary(kept));
    }
  } else {
    // post mode: inline comments, capped at postingCap.
    for (let i = 0; i < kept.length; i++) {
      const finding = kept[i];
      const findingId = keptIds[i];
      if (!finding || !findingId) continue;
      if (i < request.postingCap) {
        const comment = await deps.platform.createInlineComment(request.repo, request.prId, { path: finding.filePath, line: finding.lineStart, commitSha: request.commitSha }, finding.message);
        await updateFindingStatus(deps.db, findingId, "posted");
        await insertPostedComment(deps.db, findingId, request.platform, comment.id);
        // The poller only looks at posted findings; seed the outcome row here.
        await ensureOutcome(deps.db, findingId, "posted");
        posted++;
      } else {
        await updateFindingStatus(deps.db, findingId, "capped");
      }
    }
  }

  await emitEvent(deps.db, {
    eventKey: `review:${request.reviewId}:completed`,
    repo: request.repo,
    eventType: "review.completed",
    aggregateId: `review:${request.reviewId}`,
    payload: { prId: request.prId, findings: kept.length, posted },
  });

  return { findings: kept, posted };
}
