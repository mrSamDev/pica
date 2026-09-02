import { Worker, type Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

import type { Db } from "../db/client.ts";
import { ensureOutcome, getOutcome, updateOutcome } from "../db/outcomes.ts";
import { emitEvent } from "../learning/events.ts";
import { canTransition, isTerminal, type OutcomeStatus } from "../learning/feedback/state.ts";

export interface OutcomeJob {
  findingId: string;
  repo: string;
  to: OutcomeStatus;
  reason?: string;
  resolverUser?: string;
  source: "webhook" | "poller";
}

export interface OutcomeQueue {
  enqueue(job: OutcomeJob): Promise<void>;
}

export function createOutcomeQueue(queue: Queue): OutcomeQueue {
  return {
    async enqueue(job: OutcomeJob) {
      await queue.add("outcome", job);
    },
  };
}

export interface OutcomeDeps {
  db: Db;
}

// Apply one outcome mutation. The state machine rejects invalid transitions and
// terminal states never reopen silently, so a stale webhook or poller write is
// a no-op rather than a corruption. DB errors throw so BullMQ retries.
export async function applyOutcome(deps: OutcomeDeps, job: OutcomeJob): Promise<void> {
  const current = await getOutcome(deps.db, job.findingId);
  if (current === null) {
    // No outcome row yet (e.g. a webhook fired before the finding was posted).
    await ensureOutcome(deps.db, job.findingId, job.to);
    await emitOutcomeEvent(deps.db, job);
    return;
  }
  if (isTerminal(current)) {
    return;
  }
  if (!canTransition(current, job.to)) {
    return;
  }
  await updateOutcome(deps.db, job.findingId, {
    status: job.to,
    reason: job.reason,
    resolverUser: job.resolverUser,
    resolvedAt: job.to === "resolved" ? new Date() : undefined,
  });
  await emitOutcomeEvent(deps.db, job);
}

async function emitOutcomeEvent(db: Db, job: OutcomeJob): Promise<void> {
  await emitEvent(db, {
    eventKey: `finding:${job.findingId}:outcome:${job.to}`,
    repo: job.repo,
    eventType: "finding.outcome_changed",
    aggregateId: `finding:${job.findingId}`,
    payload: { status: job.to, source: job.source, reason: job.reason },
  });
}

export function createOutcomeWorker(connection: Redis, deps: OutcomeDeps, logger: Logger): Worker {
  // concurrency 1: the serialization guarantee that webhook + poller writes
  // cannot race. All outcome mutations funnel through this single worker.
  const worker = new Worker(
    "outcomes",
    async (job) => {
      // SAFETY: jobs are enqueued by the webhook/poller with an OutcomeJob payload.
      const data = job.data as OutcomeJob;
      logger.info({ jobId: job.id, findingId: data.findingId, to: data.to }, "applying outcome");
      await applyOutcome(deps, data);
    },
    { connection, concurrency: 1 },
  );
  return worker;
}
