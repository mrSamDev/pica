import { createHash } from "node:crypto";

import type { Config } from "../../config.ts";
import type { Db } from "../../db/client.ts";
import { ensureOutcome } from "../../db/outcomes.ts";
import { emitEvent, hasEvent } from "../../learning/events/emit.ts";
import { getReviewLearningContext, RETRIEVAL_VERSION, computeRulesVersion } from "../../learning/retrieval/retrieval.ts";
import { selectProbeCandidates } from "../../learning/retrieval/probes.ts";
import type { LLMClient } from "../../llm/client.ts";
import type { Metrics } from "../../observability/metrics.ts";
import type { PlatformClient } from "../../platform/types.ts";
import { parseReviewOutput } from "../parse/parse.ts";
import { applyPostFilter } from "../postfilter/postfilter.ts";
import { buildPrompt, PROMPT_VERSION } from "../prompts/build.ts";
import type { Finding, ReviewRequest } from "../types.ts";
import { chunkDiff } from "./chunk.ts";
import { withFeedbackFooter } from "./comment.ts";
import { ensurePattern, fetchPostedCommentId, fetchPriorFindings, insertFindings, insertFindingsReturning, insertPostedComment, recordLlmCall, recordReviewRepro, toFindingRow, updateFindingStatus, type FindingRow } from "./queries.ts";
import { buildCleanSummary, buildSummary, severityOrder } from "./summary.ts";

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

function dropStatus(reason: "suppressed" | "suppressed-glob" | "duplicate" | "repeat-human" | "cross-commit"): string {
  // Both suppression kinds are persisted under one "suppressed" status, so the
  // dashboard/metrics count them identically; only the probe path needs to tell
  // them apart (and it looks at DropReason, not this status).
  return reason === "suppressed" || reason === "suppressed-glob" ? "suppressed" : "duplicate";
}

export async function runReview(deps: ReviewDeps, request: ReviewRequest): Promise<ReviewResult> {
  const rawDiff = await deps.platform.fetchDiff(request.repo, request.prId);
  const chunks = chunkDiff(rawDiff);

  // Read model (§5.8): active rules + memory context are injected into every
  // prompt, so the model sees what the repo has learned, and the post-filter
  // enforces suppression deterministically after parsing.
  const learningContext = await getReviewLearningContext(deps.db, request.repo);

  const allFindings: Finding[] = [];
  for (const chunk of chunks) {
    const prompt = buildPrompt({ diff: chunk.raw, repo: request.repo, prId: request.prId, rulesText: learningContext.rulesText, memoryContext: learningContext.memoryContext });
    const raw = await deps.llm.review(prompt);
    if (request.mode !== "dry-run") {
      await recordLlmCall(deps.db, {
        reviewId: request.reviewId,
        model: deps.config.LLM_MODEL,
        provider: deps.config.LLM_PROVIDER,
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

  // §3 reproducibility: record which model, prompt, rules and retrieval version
  // produced this review. After the dry-run (which writes nothing) and before
  // any posting, so a crash leaves the row with its versions + status=failed.
  await recordReviewRepro(deps.db, request.reviewId, {
    model: deps.config.LLM_MODEL,
    promptVersion: PROMPT_VERSION,
    rulesVersion: computeRulesVersion([learningContext.rulesText || ""]),
    retrievalVersion: RETRIEVAL_VERSION,
  });

  const [priorFindings, existingComments] = await Promise.all([fetchPriorFindings(deps.db, request.repo, request.prId, request.commitSha), deps.platform.listComments(request.repo, request.prId)]);

  // Resolve the LLM pattern string to a stable patterns row uuid before the
  // postfilter, so suppression and cross-commit dedup compare uuids, not the
  // LLM's free-text keys.
  for (const finding of allFindings) {
    finding.patternUuid = await ensurePattern(deps.db, request.repo, finding.category, finding.patternId, "v1", finding.message);
  }

  const filtered = applyPostFilter({
    prId: request.prId,
    findings: allFindings,
    suppression: learningContext.suppression,
    protectedCategories: new Set(deps.config.LEARNER_PROTECTED_CATEGORIES),
    existingComments,
    priorFindings,
  });

  // §5.7 ε-probing: a suppressed pattern must keep generating evidence. Promote
  // qualifying dropped findings back up — at most one per pattern, only in a
  // new glob context, once per window. Probes bypass the posting cap so a low
  // cap can't kill the falsification mechanism.
  const suppressedFindings = filtered.dropped.filter((d) => d.reason === "suppressed").map((d) => d.finding);
  const probeCandidates = suppressedFindings.length > 0 ? await selectProbeCandidates(deps.db, { probeIntervalDays: deps.config.LEARNER_PROBE_INTERVAL_DAYS }, new Date(), suppressedFindings) : [];
  const probeSet = new Set(probeCandidates);
  const probeFindings = probeCandidates.map((finding) => ({ ...finding, isProbe: true as const }));
  const dropped = filtered.dropped.filter((d) => d.reason !== "suppressed" || !probeSet.has(d.finding));

  // Severity-sort so the most important findings are posted first when capped;
  // probes are appended after, exempt from the cap.
  const kept = [...filtered.findings].sort(severityOrder);
  const postOrder = [...kept, ...probeFindings];

  // Persist dropped findings with their terminal status so the dashboard can
  // count them and the learning loop can see what was suppressed.
  const droppedRows: FindingRow[] = [];
  for (const droppedFinding of dropped) {
    deps.metrics.findingsSuppressed.inc();
    droppedRows.push(toFindingRow(droppedFinding.finding, request.reviewId, request.repo, request.prId, request.commitSha, dropStatus(droppedFinding.reason), droppedFinding.finding.patternUuid));
  }

  // Insert findings atomically. Platform POSTs happen after, outside the
  // transaction, so a slow comment never holds a DB lock.
  const keptIds = await deps.db.transaction(async (tx) => {
    await insertFindings(tx, droppedRows);
    return insertFindingsReturning(
      tx,
      postOrder.map((finding) => toFindingRow(finding, request.reviewId, request.repo, request.prId, request.commitSha, "pending", finding.patternUuid)),
    );
  });

  const writes: Array<{ findingId: string; status: string; commentId?: string }> = [];
  // Probes that were actually posted carry a marker event so the rate limit
  // and dashboard probe view read the log like everything else.
  const postedProbes: Array<{ patternId: string; findingId: string; filePath: string; repo: string }> = [];
  let posted = 0;
  if (request.mode === "observe") {
    for (let i = 0; i < postOrder.length; i++) {
      const findingId = keptIds[i];
      if (findingId) writes.push({ findingId, status: "observed" });
    }
    if (request.summaryComment && kept.length > 0) {
      await deps.platform.createPrComment(request.repo, request.prId, buildSummary(kept));
    }
  } else {
    for (let i = 0; i < postOrder.length; i++) {
      const finding = postOrder[i];
      const findingId = keptIds[i];
      if (!finding || !findingId) continue;
      const isProbe = finding.isProbe === true;
      // The cap applies to regular findings only; probes bypass it (§5.7).
      if (!isProbe && posted >= request.postingCap) {
        writes.push({ findingId, status: "capped" });
        continue;
      }
      posted++;
      // Idempotent posting: reuse a stored comment_id on worker retry.
      const existing = await fetchPostedCommentId(deps.db, request.platform, findingId);
      let commentId = existing;
      if (!commentId) {
        const comment = await deps.platform.createInlineComment(request.repo, request.prId, { path: finding.filePath, line: finding.lineStart, commitSha: request.commitSha }, withFeedbackFooter(finding));
        commentId = comment.id;
        // Persist the comment link immediately, not in the final batched
        // transaction: if a later post in this loop throws, the worker retry
        // reuses this stored id instead of re-posting an identical comment.
        await insertPostedComment(deps.db, findingId, request.platform, commentId);
        await ensureOutcome(deps.db, findingId, "posted");
      }
      writes.push({ findingId, status: "posted", commentId });
      if (isProbe) {
        deps.metrics.probes.inc();
        postedProbes.push({ patternId: finding.patternUuid, findingId, filePath: finding.filePath, repo: request.repo });
      } else {
        deps.metrics.findingsPosted.inc();
      }
    }
    // A clean review still says so on the PR; silence reads like a dead bot.
    // The marker event makes a worker retry skip the repost.
    if (postOrder.length === 0) {
      const cleanKey = `review:${request.reviewId}:clean-comment`;
      if (!(await hasEvent(deps.db, cleanKey))) {
        await deps.platform.createPrComment(request.repo, request.prId, buildCleanSummary());
        await emitEvent(deps.db, { eventKey: cleanKey, repo: request.repo, eventType: "review.clean-comment", aggregateId: `review:${request.reviewId}`, payload: {} });
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
    // §5.7: record each posted probe as an immutable marker event so the rate
    // limit and the dashboard's probe view read the log like everything else.
    for (const probe of postedProbes) {
      await emitEvent(tx, {
        eventKey: `pattern:${probe.patternId}:probed:${probe.findingId}`,
        repo: probe.repo,
        eventType: "pattern.probed",
        aggregateId: `pattern:${probe.patternId}`,
        payload: { findingId: probe.findingId, filePath: probe.filePath },
      });
    }
    await emitEvent(tx, {
      eventKey: `review:${request.reviewId}:completed`,
      repo: request.repo,
      eventType: "review.completed",
      aggregateId: `review:${request.reviewId}`,
      payload: { prId: request.prId, findings: kept.length + probeFindings.length, posted },
    });
  });

  return { findings: kept, posted };
}
