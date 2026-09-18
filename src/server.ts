import { Queue } from "bullmq";
import { Pool } from "pg";

import { buildApp } from "./app.ts";
import { loadConfig, getLearnerConfig } from "./config.ts";
import { createDashboardQueries } from "./dashboard/projection.ts";
import { createDb } from "./db/client.ts";
import { runMigrations } from "./db/migrations.ts";
import { runLearner } from "./learning/learner/learner.ts";
import { createOpenRouterLLM } from "./llm/openrouter.ts";
import { createLogger } from "./observability/logger.ts";
import { createMetrics } from "./observability/metrics.ts";
import { getLearningLagSeconds } from "./learning/lag.ts";
import { getDismissalRate30d } from "./learning/metrics.ts";
import { decayStaleRules } from "./learning/learner/decay.ts";
import { createBitbucketClient } from "./platform/bitbucket.ts";
import { createGitHubClient } from "./platform/github.ts";
import { createPlatformTokenProvider } from "./platform/token.ts";
import { pollFeedback } from "./platform/poll.ts";
import { createRedisConnection } from "./queue/connection.ts";
import { createOutcomeWorker, type OutcomeJob } from "./queue/outcome.ts";
import { createReviewWorker } from "./queue/worker.ts";
import type { ReviewRequest } from "./review/types.ts";

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
const platformTokenProvider = createPlatformTokenProvider(config);
const platform =
  config.PLATFORM === "github"
    ? createGitHubClient({ tokenProvider: platformTokenProvider, allowedHosts, maxDiffBytes: config.MAX_DIFF_BYTES, timeoutMs: config.PLATFORM_TIMEOUT_MS })
    : createBitbucketClient({ tokenProvider: platformTokenProvider, allowedHosts, maxDiffBytes: config.MAX_DIFF_BYTES, timeoutMs: config.PLATFORM_TIMEOUT_MS });
const llm = createOpenRouterLLM({ apiKey: config.LLM_API_KEY, model: config.LLM_MODEL, timeoutMs: config.LLM_TIMEOUT_MS, reasoning: config.LLM_REASONING });
const reviewDeps = { db, platform, llm, config, metrics };
const worker = createReviewWorker(redis, reviewDeps, logger);
// BullMQ emits `failed` per job and `error` for internal problems; without
// listeners a failing review is invisible in logs (the error only lands in
// reviews.error via updateReviewStatus).
worker.on("failed", (job, error) => {
  // SAFETY: the reviews queue only ever receives webhook ReviewRequest payloads.
  const request = job?.data as ReviewRequest | undefined;
  logger.error({ jobId: job?.id, prId: request?.prId, err: error }, "review job failed");
});
worker.on("error", (error) => {
  logger.error({ err: error }, "review worker error");
});
const learnerConfig = getLearnerConfig(config);
const outcomeWorker = createOutcomeWorker(
  redis,
  {
    db,
    metrics,
    runLearner: async (input) => {
      await runLearner(db, input, learnerConfig);
    },
  },
  logger,
);
outcomeWorker.on("failed", (job, error) => {
  // SAFETY: the outcomes queue only ever receives webhook/poller OutcomeJob payloads.
  const outcomeJob = job?.data as OutcomeJob | undefined;
  logger.error({ jobId: job?.id, findingId: outcomeJob?.findingId, err: error }, "outcome job failed");
});
outcomeWorker.on("error", (error) => {
  logger.error({ err: error }, "outcome worker error");
});
const app = buildApp(config, logger, {
  db,
  queue,
  platform,
  llm,
  dashboardQueries: createDashboardQueries(db, queue, outcomeQueue),
  metrics,
  getLearningLag: () => getLearningLagSeconds(db),
  getDismissalRate: () => getDismissalRate30d(db, new Date()),
  auth: { username: config.DASHBOARD_USERNAME, password: config.DASHBOARD_PASSWORD },
});

// §5.7 decay sweep. Runs daily like the feedback poller; unref so it never
// keeps the process alive. A stale rule (no supporting dismissal for
// LEARNER_DECAY_DAYS) gets retired so the bot re-flags and re-learns instead
// of silently fossilising.
const decayTimer = setInterval(
  () => {
    decayStaleRules(db, new Date(), { decayDays: learnerConfig.decayDays }).catch((error) => {
      logger.error({ err: error }, "rule decay sweep failed");
    });
  },
  24 * 60 * 60 * 1000,
);
decayTimer.unref();

// Feedback poller. The advisory lock makes overlapping runs harmless, so a
// plain interval is enough; unref so it never keeps the process alive.
const pollTimer = setInterval(
  () => {
    pollFeedback({
      pool,
      db,
      platform,
      logger,
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
    clearInterval(decayTimer);
    Promise.all([app.close(), worker.close(), outcomeWorker.close(), pool.end()])
      .then(() => process.exit(0))
      .catch((error) => {
        logger.error({ err: error }, "error during shutdown");
        process.exit(1);
      });
  });
}

try {
  // §12: single-process deploy — apply pending migrations on boot. Drizzle's
  // journal table makes this a no-op once the schema is current, so `docker
  // compose up` boots the full stack with no separate migration step.
  await runMigrations(db);
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  logger.fatal({ err: error }, "failed to start server");
  process.exit(1);
}
