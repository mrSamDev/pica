import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { loadConfig } from "../src/config.ts";
import * as schema from "../src/db/schema.ts";
import { findings, reviews } from "../src/db/schema.ts";
import type { LLMClient } from "../src/llm/client.ts";
import type { PlatformClient } from "../src/platform/types.ts";
import { runReview } from "../src/review/pipeline/pipeline.ts";
import type { Finding, ReviewMode, ReviewRequest, Severity } from "../src/review/types.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();

const config = loadConfig({
  DATABASE_URL: "postgres://localhost:5432/pica",
  REDIS_URL: "redis://localhost:6379",
  WEBHOOK_SECRET: "test-webhook-secret",
  LLM_API_KEY: "test-llm-key",
  PLATFORM_TOKEN: "test-platform-token",
  LOG_LEVEL: "silent",
});

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index 123..456 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -40,3 +40,4 @@
 const token = getToken();
+if (!token.exp) { throw new Error("missing exp"); }
`;

function makeFindings(count: number): Finding[] {
  const severities: Severity[] = ["error", "warning", "suggestion"];
  return Array.from({ length: count }, (_, i) => ({
    filePath: "src/auth.ts",
    lineStart: 40 + i,
    lineEnd: 40 + i,
    category: "security",
    patternId: `security:pattern-${i}`,
    severity: severities[i % 3] ?? "suggestion",
    message: `finding ${i}`,
  }));
}

function makeLlm(findings: Finding[]): LLMClient {
  return { review: async () => JSON.stringify(findings) };
}

// Comment ids must be globally unique across the shared DB (posted_comments
// unique constraint on platform + comment_id), like real platform ids.
let commentSeq = 0;

function makePlatform() {
  const inline: Array<{ repo: string; prId: string; content: string }> = [];
  const pr: Array<{ repo: string; prId: string; content: string }> = [];
  const platform: PlatformClient = {
    async fetchDiff() {
      return DIFF;
    },
    async listComments() {
      return [];
    },
    async createInlineComment(repo, prId, _target, content) {
      inline.push({ repo, prId, content });
      return { id: `i-${++commentSeq}` };
    },
    async createPrComment(repo, prId, content) {
      pr.push({ repo, prId, content });
      return { id: `p-${++commentSeq}` };
    },
    async getCommentState() {
      return { resolved: false, deleted: false, replyCount: 0 };
    },
  };
  return { platform, inline, pr };
}

function makeRequest(reviewId: string, prId: string, mode: ReviewMode, overrides?: Partial<ReviewRequest>): ReviewRequest {
  return {
    reviewId,
    repo: "owner/repo",
    prId,
    commitSha: "abc123",
    diffHref: "https://api.github.com/repos/owner/repo/pulls/42",
    platform: "github",
    mode,
    postingCap: 10,
    summaryComment: false,
    ...overrides,
  };
}

describe.skipIf(!dockerAvailable)("pipeline mode gating", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const raw = drizzle(pool);
    await migrate(raw, { migrationsFolder: "./drizzle" });
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  async function seedReview(reviewId: string, mode: ReviewMode): Promise<void> {
    if (db === undefined) throw new Error("db not initialized");
    await db.insert(reviews).values({ id: reviewId, repo: "owner/repo", prId: "42", commitSha: "abc123", status: "running", mode });
  }

  it("observe mode records findings but does not post", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = "11111111-1111-1111-1111-111111111111";
    await seedReview(reviewId, "observe");
    const { platform, inline, pr } = makePlatform();
    const result = await runReview({ db, platform, llm: makeLlm(makeFindings(3)), config }, makeRequest(reviewId, "42", "observe"));

    expect(result.posted).toBe(0);
    expect(inline).toHaveLength(0);
    expect(pr).toHaveLength(0);

    const rows = await db.select().from(findings).where(eq(findings.reviewId, reviewId));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === "observed")).toBe(true);
  });

  it("observe mode emits capped summary", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = "22222222-2222-2222-2222-222222222222";
    await seedReview(reviewId, "observe");
    const { platform, inline, pr } = makePlatform();
    const result = await runReview({ db, platform, llm: makeLlm(makeFindings(7)), config }, makeRequest(reviewId, "43", "observe", { summaryComment: true }));

    expect(result.posted).toBe(0);
    expect(inline).toHaveLength(0);
    expect(pr).toHaveLength(1);
    const lines = pr[0]?.content.split("\n") ?? [];
    expect(lines[0]).toContain("7 findings detected, showing top 5");
    expect(lines.length - 1).toBe(5);
    // Severity-prioritized: errors first.
    expect(lines[1]).toContain("[error]");
  });

  it("post mode posts comments", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = "33333333-3333-3333-3333-333333333333";
    await seedReview(reviewId, "post");
    const { platform, inline, pr } = makePlatform();
    const result = await runReview({ db, platform, llm: makeLlm(makeFindings(3)), config }, makeRequest(reviewId, "44", "post"));

    expect(result.posted).toBe(3);
    expect(inline).toHaveLength(3);
    expect(pr).toHaveLength(0);

    const rows = await db.select().from(findings).where(eq(findings.reviewId, reviewId));
    expect(rows.every((row) => row.status === "posted")).toBe(true);
  });

  it("dry-run mode prints findings, posts nothing", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = "44444444-4444-4444-4444-444444444444";
    await seedReview(reviewId, "dry-run");
    const { platform, inline, pr } = makePlatform();
    const result = await runReview({ db, platform, llm: makeLlm(makeFindings(3)), config }, makeRequest(reviewId, "45", "dry-run"));

    expect(result.findings).toHaveLength(3);
    expect(result.posted).toBe(0);
    expect(inline).toHaveLength(0);
    expect(pr).toHaveLength(0);
    // dry-run makes no DB writes.
    const rows = await db.select().from(findings).where(eq(findings.reviewId, reviewId));
    expect(rows).toHaveLength(0);
  });

  it("per-repo posting cap enforced in post mode", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = "55555555-5555-5555-5555-555555555555";
    await seedReview(reviewId, "post");
    const { platform, inline, pr } = makePlatform();
    const result = await runReview({ db, platform, llm: makeLlm(makeFindings(5)), config }, makeRequest(reviewId, "46", "post", { postingCap: 2 }));

    expect(result.posted).toBe(2);
    expect(inline).toHaveLength(2);
    expect(pr).toHaveLength(0);

    const rows = await db.select().from(findings).where(eq(findings.reviewId, reviewId));
    expect(rows.filter((row) => row.status === "posted")).toHaveLength(2);
    expect(rows.filter((row) => row.status === "capped")).toHaveLength(3);
  });
});
