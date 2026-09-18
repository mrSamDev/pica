import { getRepoConfig } from "../config.ts";

import { toReviewRequest, type WebhookPayload } from "./controller.ts";
import { handleOutcomeEvent, type OutcomeEvent } from "./outcome.ts";
import type { WebhookDeps } from "./types.ts";

// The normalized review path, shared by GitHub-native deliveries and any
// sender that already speaks the {repo, prId, commitSha, diffHref} contract.
export async function handleReviewRequest(deps: WebhookDeps, platform: "github" | "bitbucket", payload: WebhookPayload) {
  const repoConfig = getRepoConfig(deps.config, payload.repo);
  const request = toReviewRequest(payload, platform, repoConfig);
  const eventKey = `webhook:${request.prId}:${request.commitSha}`;

  // Idempotency: a redelivered webhook must not create a second review.
  if (await deps.store.hasEvent(eventKey)) {
    return { received: true, deduped: true };
  }

  const reviewId = await deps.store.createReview({
    repo: request.repo,
    prId: request.prId,
    commitSha: request.commitSha,
    status: "queued",
    mode: repoConfig.mode,
  });
  await deps.queue.enqueue({ ...request, reviewId });

  // Claim the dedup key only after the job is durably enqueued; otherwise an
  // enqueue failure burns the claim and redelivery skips a lost review.
  await deps.store.recordEvent({ platform, eventKey, validated: true, processed: true });

  return { received: true };
}

// A resolved review thread fans out to one outcome event per comment. Each
// gets its own idempotency key so a redelivery re-skips what it already did.
export async function handleOutcomeEvents(deps: WebhookDeps, platform: "github" | "bitbucket", events: OutcomeEvent[]) {
  for (const event of events) {
    const eventKey = `outcome:${platform}:${event.commentId}:${event.eventType}`;
    if (await deps.store.hasEvent(eventKey)) {
      continue;
    }
    // Apply before claiming the key. applyOutcome is idempotent (terminal or
    // invalid transitions are no-ops), so a redelivery after a failure re-runs
    // safely instead of losing the event; a partial thread fanout only retries
    // the comment that actually failed on redelivery.
    await handleOutcomeEvent({ findFinding: deps.findFinding, queue: deps.outcomeQueue }, { ...event, platform });
    await deps.store.recordEvent({ platform, eventKey, validated: true, processed: true });
  }
  return { received: true };
}
