import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Queue, QueueEvents, Worker } from "bullmq";

import { createRedisConnection } from "../src/queue/connection.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)("queue", () => {
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

  it("queue connects to testcontainers redis", async () => {
    if (connection === undefined) throw new Error("connection not initialized");

    const queue = new Queue("reviews", { connection });
    const queueEvents = new QueueEvents("reviews", { connection });
    const worker = new Worker("reviews", async (job) => job.data, { connection });
    await worker.waitUntilReady();
    const job = await queue.add("test-job", { hello: "world" });
    const result = await job.waitUntilFinished(queueEvents, 10_000);
    expect(result).toEqual({ hello: "world" });
    await worker.close();
    await queueEvents.close();
    await queue.close();
  });

  it("retained failed jobs act as the v1 DLQ", async () => {
    if (connection === undefined) throw new Error("connection not initialized");

    const queue = new Queue("dlq-test", {
      connection,
      defaultJobOptions: { attempts: 2, backoff: { type: "exponential", delay: 100 }, removeOnComplete: { count: 10 }, removeOnFail: false },
    });
    const worker = new Worker(
      "dlq-test",
      async () => {
        throw new Error("always fails");
      },
      { connection },
    );
    await worker.waitUntilReady();

    await queue.add("fail-job", {});
    // Wait for the job to exhaust its attempts and land in the failed set.
    const deadline = Date.now() + 10_000;
    let failed = 0;
    while (Date.now() < deadline) {
      failed = await queue.getFailedCount();
      if (failed >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(failed).toBeGreaterThanOrEqual(1);

    await worker.close();
    await queue.close();
  });
});
