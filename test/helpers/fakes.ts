import type { Queue } from "bullmq";
import { Gauge } from "prom-client";

import type { DashboardQueries } from "../../src/dashboard/projection.ts";
import type { Db } from "../../src/db/client.ts";
import type { LLMClient } from "../../src/llm/client.ts";
import type { Metrics } from "../../src/observability/metrics.ts";
import type { PlatformClient } from "../../src/platform/types.ts";

export function createFakeMetrics(): Metrics {
  // SAFETY: tests never read metric values; a no-op counter satisfies the type.
  const noop = { inc: () => {} } as Metrics["findingsPosted"];
  // SAFETY: a real, unregistered gauge satisfies the type without a cast; tests
  // never scrape it.
  const noopGauge = new Gauge({ name: "learning_lag_seconds", help: "test", registers: [] });
  return {
    findingsPosted: noop,
    findingsSuppressed: noop,
    probes: noop,
    outcome: noop,
    learningLag: noopGauge,
    dismissalRate: noopGauge,
    // SAFETY: tests never scrape the registry; an empty object satisfies the
    // type without ever dereferencing it.
    registry: {} as Metrics["registry"],
  };
}

export function createFakeDashboardQueries(overrides?: Partial<DashboardQueries>): DashboardQueries {
  return {
    countReviewsByStatus: async () => ({ running: 0, completed: 0, failed: 0 }),
    countFindingsByStatus: async () => ({ posted: 0, suppressed: 0, duplicate: 0 }),
    countOutcomesByStatus: async () => ({ posted: 0, replied: 0, resolved: 0, dismissed: 0 }),
    recentActivity: async () => [],
    queueDepth: async () => 0,
    failedJobs: async () => 0,
    countRulesByStatus: async () => ({ active: 0, candidate: 0, retired: 0 }),
    listRules: async () => [],
    learningLag: async () => null,
    dismissalRateTrend: async () => [],
    probes: async () => [],
    whyDisappeared: async () => null,
    ...overrides,
  };
}

export function createFakePlatform(): PlatformClient {
  return {
    fetchDiff: async () => "",
    listComments: async () => [],
    createInlineComment: async () => ({ id: "1" }),
    createPrComment: async () => ({ id: "1" }),
    getCommentState: async () => ({ resolved: false, deleted: false, replyCount: 0 }),
  };
}

export function createFakeLlm(): LLMClient {
  return { review: async () => "[]" };
}

// Stub db/queue for app tests that never touch the webhook or queue.
export function createUnusedDb(): Db {
  // SAFETY: never called in the app tests that use this; the real implementation is wired in server.ts and the integration tests.
  return {} as Db;
}

export function createUnusedQueue(): Queue {
  // SAFETY: never called in the app tests that use this; the real implementation is wired in server.ts and the integration tests.
  return {} as Queue;
}
