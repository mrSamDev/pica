import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

import { runReview, type ReviewDeps } from "../review/pipeline/pipeline.ts";
import { updateReviewStatus } from "../review/pipeline/queries.ts";
import type { ReviewRequest } from "../review/types.ts";

export function createReviewWorker(connection: Redis, deps: ReviewDeps, logger: Logger): Worker {
  const worker = new Worker(
    "reviews",
    async (job) => {
      // SAFETY: jobs are enqueued by the webhook with a ReviewRequest payload.
      const request = job.data as ReviewRequest;
      logger.info({ jobId: job.id, prId: request.prId }, "processing review job");
      await updateReviewStatus(deps.db, request.reviewId, "running");
      try {
        const result = await runReview(deps, request);
        await updateReviewStatus(deps.db, request.reviewId, "done");
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        await updateReviewStatus(deps.db, request.reviewId, "failed", message);
        throw error;
      }
    },
    { connection },
  );
  return worker;
}
