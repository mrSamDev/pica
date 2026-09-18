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
      await queue.add("review", request, { jobId });
    },
  };
}
