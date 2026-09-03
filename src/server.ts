import { Queue } from "bullmq";
import { Pool } from "pg";

import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createDashboardQueries } from "./dashboard/projection.ts";
import { createDb } from "./db/client.ts";
import { createOpenRouterLLM } from "./llm/openrouter.ts";
import { createLogger } from "./observability/logger.ts";
import { createMetrics } from "./observability/metrics.ts";
import { createBitbucketClient } from "./platform/bitbucket.ts";
import { createGitHubClient } from "./platform/github.ts";
import { pollFeedback } from "./platform/poll.ts";
import { createRedisConnection } from "./queue/connection.ts";
import { createOutcomeWorker } from "./queue/outcome.ts";
import { createReviewWorker } from "./queue/worker.ts";

const config = loadConfig(process.env);
const logger = createLogger(config);
const metrics = createMetrics();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const db = createDb(pool);
const redis = createRedisConnection(config.REDIS_URL);
// Retained failed jobs are the v1 DLQ (bounded so Redis doesn't grow forever);
// the dashboard surfaces getFailedCount(). Retries with exponential backoff
// give transient LLM/platform errors a chance.
const jobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 1000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 1000 },
};
const queue = new Queue("reviews", { connection: redis, defaultJobOptions: jobOptions });
const outcomeQueue = new Queue("outcomes", { connection: redis, defaultJobOptions: jobOptions });
const allowedHosts = new Set(config.ALLOWED_HOSTS);
const platform = config.PLATFORM === "github" ? createGitHubClient({ token: config.PLATFORM_TOKEN, allowedHosts, maxDiffBytes: config.MAX_DIFF_BYTES }) : createBitbucketClient({ token: config.PLATFORM_TOKEN, allowedHosts, maxDiffBytes: config.MAX_DIFF_BYTES });
const llm = createOpenRouterLLM({ apiKey: config.LLM_API_KEY, model: config.LLM_MODEL, timeoutMs: config.LLM_TIMEOUT_MS });
const reviewDeps = { db, platform, llm, config, metrics };
const worker = createReviewWorker(redis, reviewDeps, logger);
const outcomeWorker = createOutcomeWorker(redis, { db, metrics }, logger);
const app = buildApp(config, logger, {
  db,
  queue,
  platform,
  llm,
  dashboardQueries: createDashboardQueries(db, queue, outcomeQueue),
  metrics,
});

// Feedback poller. The advisory lock makes overlapping runs harmless, so a
// plain interval is enough; unref so it never keeps the process alive.
const pollTimer = setInterval(
  () => {
    pollFeedback({
      pool,
      db,
      platform,
      queue: {
        enqueue: async (job) => {
          await outcomeQueue.add("outcome", job);
        },
      },
    }).catch((error) => {
      logger.error({ err: error }, "feedback poll failed");
    });
  },
  60 * 60 * 1000,
);
pollTimer.unref();

// Graceful shutdown: stop accepting new connections, drain in-flight requests.
// Docker/Kubernetes send SIGTERM on deploy/scale-down.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    clearInterval(pollTimer);
    Promise.all([app.close(), worker.close(), outcomeWorker.close(), pool.end()])
      .then(() => process.exit(0))
      .catch((error) => {
        logger.error({ err: error }, "error during shutdown");
        process.exit(1);
      });
  });
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  logger.fatal({ err: error }, "failed to start server");
  process.exit(1);
}
