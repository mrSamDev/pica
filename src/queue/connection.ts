import { Redis } from "ioredis";

export function createRedisConnection(url: string): Redis {
  // maxRetriesPerRequest: null is required by BullMQ so a worker can block on
  // a job without ioredis exhausting its retry budget.
  return new Redis(url, { maxRetriesPerRequest: null });
}
