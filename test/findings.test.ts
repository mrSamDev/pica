import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema.ts";
import { findings, patterns, reviews } from "../src/db/schema.ts";
import { insertFindings, toFindingRow } from "../src/review/pipeline/queries.ts";
import type { Finding } from "../src/review/types.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();

const finding: Finding = {
  filePath: "src/auth.ts",
  lineStart: 42,
  lineEnd: 42,
  category: "security",
  patternId: "22222222-2222-2222-2222-222222222222",
  patternUuid: "22222222-2222-2222-2222-222222222222",
  severity: "error",
  message: "JWT expiration isn't validated.",
};

describe.skipIf(!dockerAvailable)("findings insert", () => {
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

  it("insert is idempotent via unique constraint + onConflictDoNothing", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const reviewId = "11111111-1111-1111-1111-111111111111";
    const patternId = "22222222-2222-2222-2222-222222222222";
    await db.insert(reviews).values({ id: reviewId, repo: "owner/repo", prId: "42", commitSha: "abc123", status: "done", mode: "post" });
    await db.insert(patterns).values({ id: patternId, repo: "owner/repo", category: "security", canonicalMessage: "security:jwt-expiration", patternVersion: "v1", status: "active" });
    const row = toFindingRow(finding, reviewId, "owner/repo", "42", "abc123", "posted", patternId);

    await insertFindings(db, [row]);
    await insertFindings(db, [row]);

    const rows = await db.select().from(findings);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.patternId).toBe("22222222-2222-2222-2222-222222222222");
  });
});
