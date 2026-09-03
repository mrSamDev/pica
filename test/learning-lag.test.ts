import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema.ts";
import { findings, learningEvents, patterns } from "../src/db/schema.ts";
import { getLearningLagSeconds } from "../src/learning/lag.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)("learning lag", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const raw = drizzle(pool);
    await migrate(raw, { migrationsFolder: "./drizzle" });
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("returns null when no rule has activated", async () => {
    if (db === undefined) throw new Error("db not initialized");
    expect(await getLearningLagSeconds(db)).toBeNull();
  });

  it("measures lag from first dismissal to rule activation", async () => {
    if (db === undefined) throw new Error("db not initialized");

    const patternId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const findingId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const dismissedAt = new Date("2026-01-01T00:00:00Z");
    const activatedAt = new Date("2026-01-01T01:00:00Z");

    await db.insert(patterns).values({ id: patternId, repo: "owner/repo", category: "security", canonicalMessage: "security:jwt", patternVersion: "v1", status: "active" });
    await db.insert(findings).values({ id: findingId, reviewId: null, repo: "owner/repo", prId: "1", commitSha: "a", filePath: "src/a.ts", lineStart: 1, lineEnd: 1, category: "security", patternId, severity: "error", message: "m", messageHash: "h", status: "posted" });
    await db.insert(learningEvents).values({ eventKey: "finding:1:dismissed", repo: "owner/repo", eventType: "finding.outcome_changed", aggregateId: `finding:${findingId}`, payload: { status: "dismissed" }, createdAt: dismissedAt });
    await db.insert(learningEvents).values({ eventKey: "pattern:1:activated", repo: "owner/repo", eventType: "rule.activated", aggregateId: `pattern:${patternId}`, payload: {}, createdAt: activatedAt });

    const lag = await getLearningLagSeconds(db);
    expect(lag).toBe(3600);
  });
});
