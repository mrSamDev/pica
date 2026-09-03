import { and, eq, gte, lt } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";

import type { Db } from "../db/client.ts";
import { incrementPollCount } from "../db/outcomes.ts";
import { findingOutcomes, findings, postedComments } from "../db/schema.ts";
import { isTerminal, type OutcomeStatus } from "../learning/feedback/state.ts";
import type { OutcomeQueue } from "../queue/outcome.ts";
import type { CommentState } from "./types.ts";

// Advisory lock namespace. Session-level so it survives across the whole poll
// and is released explicitly; prevents two instances polling the same window.
const LOCK_KEY1 = 1;
const LOCK_KEY2 = 0;

const BATCHES = [
  { label: "1h", ageHours: 1 },
  { label: "24h", ageHours: 24 },
  { label: "7d", ageHours: 168 },
];

export interface CommentStateFetcher {
  getCommentState(repo: string, prId: string, commentId: string): Promise<CommentState>;
}

export interface PollDeps {
  pool: Pool;
  db: Db;
  platform: CommentStateFetcher;
  queue: OutcomeQueue;
}

export interface PollableComment {
  findingId: string;
  repo: string;
  prId: string;
  commentId: string;
  postedAt: Date;
}

export async function pollFeedback(deps: PollDeps): Promise<void> {
  const client = await deps.pool.connect();
  try {
    if (!(await acquirePollLock(client))) {
      return;
    }
    for (const batch of BATCHES) {
      await pollBatch(deps, batch.ageHours);
    }
  } finally {
    await releasePollLock(client);
    client.release();
  }
}

async function acquirePollLock(client: PoolClient): Promise<boolean> {
  const result = await client.query("SELECT pg_try_advisory_lock($1, $2) AS acquired", [LOCK_KEY1, LOCK_KEY2]);
  return result.rows[0]?.acquired === true;
}

async function releasePollLock(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_unlock($1, $2)", [LOCK_KEY1, LOCK_KEY2]);
}

async function pollBatch(deps: PollDeps, ageHours: number): Promise<void> {
  const cutoffUpper = new Date(Date.now() - (ageHours - 1) * 60 * 60 * 1000);
  const cutoffLower = new Date(Date.now() - ageHours * 60 * 60 * 1000);

  const comments = await selectFindingsToPoll(deps.db, cutoffLower, cutoffUpper);
  for (const comment of comments) {
    await incrementPollCount(deps.db, comment.findingId);
    const state = await deps.platform.getCommentState(comment.repo, comment.prId, comment.commentId);
    const to = classifyCommentState(state, ageHours);
    if (to) {
      await deps.queue.enqueue({ findingId: comment.findingId, repo: comment.repo, to, source: "poller" });
    }
  }
}

async function selectFindingsToPoll(db: Db, from: Date, to: Date): Promise<PollableComment[]> {
  const rows = await db
    .select({
      findingId: findings.id,
      repo: findings.repo,
      prId: findings.prId,
      commentId: postedComments.commentId,
      postedAt: postedComments.postedAt,
      status: findingOutcomes.status,
    })
    .from(postedComments)
    .innerJoin(findings, eq(postedComments.findingId, findings.id))
    .innerJoin(findingOutcomes, eq(findingOutcomes.findingId, findings.id))
    .where(and(gte(postedComments.postedAt, from), lt(postedComments.postedAt, to)));

  return rows
    .filter((row) => {
      // SAFETY: status column is text; the state machine owns the valid values.
      return !row.status || !isTerminal(row.status as OutcomeStatus);
    })
    .map((row) => ({
      findingId: row.findingId,
      repo: row.repo,
      prId: row.prId,
      commentId: row.commentId,
      postedAt: row.postedAt ?? new Date(),
    }));
}

// Pure classification so the poller's terminal-outcome behavior is testable
// without a database. 7d with no signal -> inconclusive (terminal).
export function classifyCommentState(state: CommentState, ageHours: number): OutcomeStatus | null {
  if (state.deleted) return "dismissed";
  if (state.resolved) return "resolved";
  // A reply is a leading indicator, not a terminal outcome. Once a comment
  // reaches the 7d no-signal window, close it to inconclusive even if it has
  // replies — otherwise a replied finding is re-classified \"replied\" (which
  // the state machine rejects as a replied->replied no-op) and never closes.
  if (ageHours >= 168) return "inconclusive";
  if (state.replyCount > 0) return "replied";
  return null;
}
