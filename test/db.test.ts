import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();

const expectedTables = ["finding_outcomes", "findings", "learning_events", "llm_calls", "patterns", "posted_comments", "repo_rules", "reviews", "rule_evidence", "webhook_events"].sort();

describe.skipIf(!dockerAvailable)("db schema", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("schema migration applies cleanly", async () => {
    if (pool === undefined) throw new Error("pool not initialized");
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: "./drizzle" });

    const result = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    const tables = result.rows.map((row) => row.table_name).sort();
    expect(tables).toEqual(expectedTables);
  });
});
