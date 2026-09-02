import { Worker } from "bullmq";
import type { Logger } from "pino";

import type { Redis } from "ioredis";

export function createWorker(connection: Redis, logger: Logger): Worker {
  const worker = new Worker(
    "reviews",
    async (job) => {
      logger.info({ jobId: job.id, name: job.name }, "processing review job");
      return job.data;
    },
    { connection },
  );
  return worker;
}
