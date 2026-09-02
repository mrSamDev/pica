import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Queue, QueueEvents } from "bullmq";

import { createRedisConnection } from "../src/queue/connection.ts";
import { createWorker } from "../src/queue/worker.ts";
import { createLogger } from "../src/observability/logger.ts";
import { loadConfig } from "../src/config.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();

const config = loadConfig({
  DATABASE_URL: "postgres://localhost:5432/pica",
  REDIS_URL: "redis://localhost:6379",
  LOG_LEVEL: "silent",
});
const logger = createLogger(config);

describe.skipIf(!dockerAvailable)("queue", () => {
  let container: StartedRedisContainer | undefined;
  let connection: ReturnType<typeof createRedisConnection> | undefined;
  let worker: ReturnType<typeof createWorker> | undefined;

  beforeAll(async () => {
    container = await new RedisContainer("redis:7-alpine").start();
    connection = createRedisConnection(container.getConnectionUrl());
    worker = createWorker(connection, logger);
  }, 120_000);

  afterAll(async () => {
    await worker?.close();
    await connection?.quit();
    await container?.stop();
  });

  it("queue connects to testcontainers redis", async () => {
    if (connection === undefined) throw new Error("connection not initialized");
    if (worker === undefined) throw new Error("worker not initialized");

    const queue = new Queue("reviews", { connection });
    const queueEvents = new QueueEvents("reviews", { connection });
    const job = await queue.add("test-job", { hello: "world" });
    const result = await job.waitUntilFinished(queueEvents, 10_000);
    expect(result).toEqual({ hello: "world" });
    await queueEvents.close();
    await queue.close();
  });
});
