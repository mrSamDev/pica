import type { Queue } from "bullmq";

import type { ReviewRequest } from "../review/types.ts";

export interface ReviewQueue {
  enqueue(request: ReviewRequest): Promise<void>;
}

export function createReviewQueue(queue: Queue): ReviewQueue {
  return {
    async enqueue(request: ReviewRequest) {
      await queue.add("review", request);
    },
  };
}
