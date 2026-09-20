import type { Queue } from "bullmq";

import type { ReviewRequest } from "../review/types.ts";

export interface ReviewQueue {
  enqueue(request: ReviewRequest): Promise<void>;
}

export function createReviewQueue(queue: Queue): ReviewQueue {
  return {
    async enqueue(request: ReviewRequest) {
      // A stable jobId makes the enqueue idempotent: a redelivered webhook
      // re-adds the same id and BullMQ returns the existing job instead of
      // enqueueing a second pipeline run for the same PR commit.
      const jobId = `review@${request.repo}@${request.prId}@${request.commitSha}`;
      // The pipeline is idempotent (finding dedup + existing-comment check),
      // so a retried job can't double-post — but a transient LLM outage must
      // not land a review straight in the DLQ.
      await queue.add("review", request, { jobId, attempts: 3, backoff: { type: "exponential", delay: 30_000 } });
    },
  };
}
