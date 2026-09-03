import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { createDb } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrations.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const EXPECTED_TABLES = ["reviews", "patterns", "findings", "posted_comments", "finding_outcomes", "learning_events", "repo_rules", "rule_evidence", "webhook_events", "llm_calls"] as const;

const dockerAvailable = await isDockerAvailable();

describe.skipIf(!dockerAvailable)("migrations", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg17").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("applies all migrations, and a second run is a no-op", async () => {
    if (pool === undefined) throw new Error("pool not initialized");
    const db = createDb(pool);

    await runMigrations(db);

    // Every table from the schema exists after the first run.
    const result = await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    const tables = new Set(result.rows.map((row) => row.table_name));
    for (const name of EXPECTED_TABLES) {
      expect(tables, `table ${name} must exist`).toContain(name);
    }

    // Boot-migrate runs on every start; the journal must make it safe.
    await expect(runMigrations(db)).resolves.toBeUndefined();
  });
});
