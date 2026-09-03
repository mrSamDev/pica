import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema.ts";
import { findings, findingOutcomes, patterns, postedComments, reviews } from "../src/db/schema.ts";
import { classifyCommentState, pollFeedback, type CommentStateFetcher } from "../src/platform/poll.ts";
import type { CommentState } from "../src/platform/types.ts";
import type { OutcomeJob, OutcomeQueue } from "../src/queue/outcome.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)("feedback poller", () => {
  let pg: StartedPostgreSqlContainer | undefined;
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;

  beforeAll(async () => {
    pg = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: pg.getConnectionUri() });
    const raw = drizzle(pool);
    await migrate(raw, { migrationsFolder: "./drizzle" });
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await pg?.stop();
  });

  async function seedFinding(commentId: string, postedAt: Date): Promise<string> {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = randomUUID();
    const patternId = randomUUID();
    const findingId = randomUUID();
    await db.insert(reviews).values({ id: reviewId, repo: "owner/repo", prId: "42", commitSha: "abc", status: "done", mode: "post" });
    await db.insert(patterns).values({ id: patternId, repo: "owner/repo", category: "security", canonicalMessage: `security:jwt:${commentId}`, patternVersion: "v1", status: "active" });
    await db.insert(findings).values({ id: findingId, reviewId, repo: "owner/repo", prId: "42", commitSha: "abc", filePath: "src/a.ts", lineStart: 1, lineEnd: 1, category: "security", patternId, severity: "error", message: `JWT ${commentId}`, messageHash: "h", status: "posted" });
    await db.insert(postedComments).values({ findingId, platform: "github", commentId, postedAt });
    await db.insert(findingOutcomes).values({ findingId, status: "posted" });
    return findingId;
  }

  function makeQueue() {
    const jobs: OutcomeJob[] = [];
    const queue: OutcomeQueue = {
      enqueue: async (job) => {
        jobs.push(job);
      },
    };
    return { jobs, queue } satisfies { jobs: OutcomeJob[]; queue: OutcomeQueue };
  }

  it("poller dedups via advisory lock: a second instance skips when the lock is held", async () => {
    if (pool === undefined || db === undefined) throw new Error("setup not initialized");
    const client = await pool.connect();
    await client.query("SELECT pg_advisory_lock(1, 0)");
    try {
      const platform: CommentStateFetcher = {
        getCommentState: async () => {
          throw new Error("platform must not be called when the lock is held");
        },
      };
      const { jobs, queue } = makeQueue();
      await pollFeedback({ pool, db, platform, queue });
      expect(jobs).toHaveLength(0);
    } finally {
      await client.query("SELECT pg_advisory_unlock(1, 0)");
      client.release();
    }
  });

  it("poller skips a comment whose state fetch fails transiently (H1): no fake dismissal, batch continues", async () => {
    if (pool === undefined || db === undefined) throw new Error("setup not initialized");
    // c-fails is 0.5h old (picked up in the 1h batch) and its platform fetch throws.
    // It must be skipped — not classified as deleted/dismissed — and the healthy
    // comment in the same batch must still be processed.
    const failsFinding = await seedFinding("c-fails", new Date(Date.now() - 30 * 60 * 1000));
    const okFinding = await seedFinding("c-ok", new Date(Date.now() - 30 * 60 * 1000));
    const states = new Map<string, CommentState>([["c-ok", { resolved: false, deleted: true, replyCount: 0 }]]);
    const platform: CommentStateFetcher = {
      getCommentState: async (_repo, _pr, commentId) => {
        if (commentId === "c-fails") throw new Error("502 upstream");
        return states.get(commentId)!;
      },
    };
    const { jobs, queue } = makeQueue();
    await pollFeedback({ pool, db, platform, queue });

    // Only the healthy comment produced a job; the failing one was skipped.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.findingId).toBe(okFinding);
    expect(jobs[0]!.to).toBe("dismissed");
    expect(jobs.map((j) => j.findingId)).not.toContain(failsFinding);
  });

  it("poller closes a reply that never resolves: a replied comment is inconclusive at the 7d poll", async () => {
    if (pool === undefined || db === undefined) throw new Error("setup not initialized");
    const _repliedId = await seedFinding("c-replied-7d", new Date(Date.now() - 167.5 * 60 * 60 * 1000));
    // Replied at 7d with no terminal outcome: closes to inconclusive, not a
    // second \"replied\" no-op that would leave it non-terminal forever.
    const states = new Map<string, CommentState>([["c-replied-7d", { resolved: false, deleted: false, replyCount: 2 }]]);
    const platform: CommentStateFetcher = {
      getCommentState: async (_repo, _pr, commentId) => states.get(commentId) ?? { resolved: false, deleted: false, replyCount: 0 },
    };
    const { jobs, queue } = makeQueue();
    await pollFeedback({ pool, db, platform, queue });
    expect(jobs.map((j) => j.to)).toContain("inconclusive");
  });

  it("poller observes terminal outcomes: resolved / dismissed / replied / inconclusive", async () => {
    if (pool === undefined || db === undefined) throw new Error("setup not initialized");
    const resolvedId = await seedFinding("c-resolved", new Date(Date.now() - 30 * 60 * 1000));
    const dismissedId = await seedFinding("c-dismissed", new Date(Date.now() - 30 * 60 * 1000));
    const repliedId = await seedFinding("c-replied", new Date(Date.now() - 30 * 60 * 1000));
    const inconclusiveId = await seedFinding("c-inconclusive", new Date(Date.now() - 167.5 * 60 * 60 * 1000));

    const states = new Map<string, CommentState>([
      ["c-resolved", { resolved: true, deleted: false, replyCount: 0 }],
      ["c-dismissed", { resolved: false, deleted: true, replyCount: 0 }],
      ["c-replied", { resolved: false, deleted: false, replyCount: 2 }],
      ["c-inconclusive", { resolved: false, deleted: false, replyCount: 0 }],
    ]);
    const platform: CommentStateFetcher = {
      getCommentState: async (_repo, _pr, commentId) => states.get(commentId) ?? { resolved: false, deleted: false, replyCount: 0 },
    };
    const { jobs, queue } = makeQueue();
    await pollFeedback({ pool, db, platform, queue });

    const byFinding = new Map(jobs.map((job) => [job.findingId, job.to]));
    expect(byFinding.get(resolvedId)).toBe("resolved");
    expect(byFinding.get(dismissedId)).toBe("dismissed");
    expect(byFinding.get(repliedId)).toBe("replied");
    expect(byFinding.get(inconclusiveId)).toBe("inconclusive");
  });

  it("classifyCommentState is pure", () => {
    expect(classifyCommentState({ resolved: true, deleted: false, replyCount: 0 }, 1)).toBe("resolved");
    expect(classifyCommentState({ resolved: false, deleted: true, replyCount: 0 }, 1)).toBe("dismissed");
    expect(classifyCommentState({ resolved: false, deleted: false, replyCount: 1 }, 1)).toBe("replied");
    expect(classifyCommentState({ resolved: false, deleted: false, replyCount: 0 }, 168)).toBe("inconclusive");
    // A replied comment at 7d closes to inconclusive rather than staying open
    // forever: the leading indicator is not a terminal outcome, so the poller
    // must not report it as \"replied\" (which the state machine rejects as a
    // no-op). At 1d the reply is still a leading indicator.
    expect(classifyCommentState({ resolved: false, deleted: false, replyCount: 2 }, 168)).toBe("inconclusive");
    expect(classifyCommentState({ resolved: false, deleted: false, replyCount: 2 }, 24)).toBe("replied");
    expect(classifyCommentState({ resolved: false, deleted: false, replyCount: 0 }, 1)).toBeNull();
  });
});
