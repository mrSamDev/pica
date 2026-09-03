import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue, Worker, type Job } from "bullmq";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";

import { createRedisConnection } from "../src/queue/connection.ts";
import { safeFetch } from "../src/platform/ssrf.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const ALLOWED = new Set(["trusted.example"]);
const ONE_KB = 1024;

function streamOf(chunks: number, onChunk?: () => void, onCancel?: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) {
        controller.close();
        return;
      }
      sent++;
      onChunk?.();
      controller.enqueue(encoder.encode("x".repeat(ONE_KB)));
    },
    cancel() {
      onCancel?.();
    },
  });
}

function responseOf(body: ReadableStream<Uint8Array>, contentLength?: number): Response {
  const headers: Record<string, string> = {};
  if (contentLength !== undefined) {
    headers["content-length"] = String(contentLength);
  }
  return new Response(body, { status: 200, headers });
}

describe("load: diff size cap holds under concurrent load", () => {
  it("rejects an oversized declared content-length without reading the body", async () => {
    let reads = 0;
    const fetchImpl: typeof fetch = async () =>
      responseOf(
        streamOf(10, () => reads++),
        10 * ONE_KB,
      );
    await expect(safeFetch("https://trusted.example/diff", { allowedHosts: ALLOWED, maxBytes: ONE_KB, fetchImpl })).rejects.toThrow("Response too large");
    // Never fully buffered. Undici may sniff one chunk for MIME type; a full
    // buffering of the 10-chunk body would read all of them before the throw
    // decision — the cap fires first, off the declared header.
    expect(reads).toBeLessThan(10);
  });

  it("rejects mid-stream without buffering the whole body, and cancels the stream", async () => {
    let cancelled = false;
    let chunks = 0;
    const fetchImpl: typeof fetch = async () =>
      responseOf(
        streamOf(
          50,
          () => chunks++,
          () => (cancelled = true),
        ),
      );
    // No content-length: the cap must hold while streaming.
    await expect(safeFetch("https://trusted.example/diff", { allowedHosts: ALLOWED, maxBytes: 4 * ONE_KB, fetchImpl })).rejects.toThrow("Response too large");
    expect(chunks).toBeLessThan(50);
    expect(cancelled).toBe(true);
  });

  it("a burst of mixed concurrent fetches: every result correct, nothing slips past the cap", async () => {
    const fetchImpl: typeof fetch = async (input, _init) => {
      const url = String(input);
      // Half oversized (8KB body, declared), half fine (2KB body).
      if (url.includes("big")) {
        return responseOf(streamOf(8), 8 * ONE_KB);
      }
      return responseOf(streamOf(2));
    };

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) => {
        const path = i % 2 === 0 ? "big" : "small";
        return safeFetch(`https://trusted.example/${path}`, { allowedHosts: ALLOWED, maxBytes: 4 * ONE_KB, fetchImpl });
      }),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected" && r.reason instanceof Error && r.reason.message === "Response too large");
    // 25 oversized rejected, 25 small succeeded — none lost to a different error.
    expect(rejected).toHaveLength(25);
    expect(fulfilled).toHaveLength(25);
  });
});

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)("load: queue handles a burst without loss", () => {
  let container: StartedRedisContainer | undefined;
  let connection: ReturnType<typeof createRedisConnection> | undefined;

  beforeAll(async () => {
    container = await new RedisContainer("redis:7-alpine").start();
    connection = createRedisConnection(container.getConnectionUrl());
  }, 120_000);

  afterAll(async () => {
    await connection?.quit();
    await container?.stop();
  });

  it("burst of 100 jobs: retries recover transients, terminal failures land in the DLQ, none lost", async () => {
    if (connection === undefined) throw new Error("connection not initialized");

    // Mirrors server.ts job options, with a small backoff so the test stays fast.
    const queue = new Queue("burst", {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 50 },
        removeOnComplete: { count: 1000 },
        removeOnFail: false,
      },
    });
    const TOTAL = 100;
    const jobs = Array.from({ length: TOTAL }, (_, i) => ({
      // Every 10th job always fails -> DLQ. Every 3rd (non-terminal) fails once
      // -> retry must recover it.
      kind: i % 10 === 9 ? "terminal" : i % 3 === 0 ? "transient" : "ok",
      seq: i,
    }));
    await queue.addBulk(jobs.map((job) => ({ name: "burst-job", data: job })));

    const processed = new Set<number>();
    const worker = new Worker(
      "burst",
      async (job: Job) => {
        // SAFETY: job.data is untyped by BullMQ; we enqueued exactly these
        // { kind, seq } payloads via addBulk above, so their shape is known.
        const data = job.data as (typeof jobs)[number];
        if (data.kind === "terminal") {
          throw new Error("permanent failure");
        }
        if (data.kind === "transient" && job.attemptsMade === 0) {
          throw new Error("transient failure");
        }
        processed.add(data.seq);
      },
      { connection, concurrency: 10 },
    );
    await worker.waitUntilReady();

    // Wait for every job to reach a terminal state (completed or retained-failed).
    const deadline = Date.now() + 30_000;
    let accounted = 0;
    while (Date.now() < deadline) {
      accounted = (await queue.getCompletedCount()) + (await queue.getFailedCount());
      if (accounted === TOTAL) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const completed = await queue.getCompleted();
    const failed = await queue.getFailed();
    // SAFETY: completed/failed payloads are the same { kind, seq } objects we enqueued.
    const completedSeqs = completed.map((job) => (job.data as (typeof jobs)[number]).seq);
    // SAFETY: failed payloads are the same { kind, seq } objects we enqueued.
    const failedSeqs = failed.map((job) => (job.data as (typeof jobs)[number]).seq);

    // At-least-once accounting: every seq is in exactly one terminal set, none lost.
    expect(accounted).toBe(TOTAL);
    expect(new Set([...completedSeqs, ...failedSeqs]).size).toBe(TOTAL);

    // Terminal jobs are exactly the always-fail ones, retained (the DLQ).
    expect(failedSeqs.sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => i * 10 + 9));

    // Transient jobs were recovered by retry and processed at least once.
    const transientSeqs = jobs.filter((j) => j.kind === "transient").map((j) => j.seq);
    for (const seq of transientSeqs) {
      expect(processed, `transient job ${seq} must complete after retry`).toContain(seq);
    }
    // The retry actually happened (transients failed on attempt 1 by design).
    expect(completedSeqs.length).toBe(TOTAL - 10);

    await worker.close();
    await queue.close();
  });
});
