import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema.ts";
import { findings, findingOutcomes, reviews } from "../src/db/schema.ts";
import { createDashboardQueries } from "../src/dashboard/projection.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();

function makeQueries(db: NodePgDatabase<typeof schema>) {
  // SAFETY: these tests only exercise the DB-backed count queries; the queue
  // params are never touched, so an empty object satisfies the type.
  return createDashboardQueries(db, {} as never, {} as never);
}

describe.skipIf(!dockerAvailable)("dashboard projection", () => {
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

  it("counts reviews by status via GROUP BY", async () => {
    if (db === undefined) throw new Error("db not initialized");
    await db.insert(reviews).values([
      { repo: "r", prId: "1", commitSha: "a", status: "running", mode: "post" },
      { repo: "r", prId: "2", commitSha: "b", status: "done", mode: "post" },
      { repo: "r", prId: "3", commitSha: "c", status: "done", mode: "post" },
      { repo: "r", prId: "4", commitSha: "d", status: "failed", mode: "post" },
    ]);
    const queries = makeQueries(db);
    expect(await queries.countReviewsByStatus()).toEqual({ running: 1, completed: 2, failed: 1 });
  });

  it("counts findings by status via GROUP BY", async () => {
    if (db === undefined) throw new Error("db not initialized");
    await db.insert(findings).values([
      { repo: "r", prId: "1", commitSha: "a", filePath: "a.ts", lineStart: 1, lineEnd: 1, category: "c", severity: "error", message: "m1", messageHash: "h1", status: "posted" },
      { repo: "r", prId: "1", commitSha: "a", filePath: "a.ts", lineStart: 2, lineEnd: 2, category: "c", severity: "error", message: "m2", messageHash: "h2", status: "suppressed" },
      { repo: "r", prId: "1", commitSha: "a", filePath: "a.ts", lineStart: 3, lineEnd: 3, category: "c", severity: "error", message: "m3", messageHash: "h3", status: "suppressed" },
      { repo: "r", prId: "1", commitSha: "a", filePath: "a.ts", lineStart: 4, lineEnd: 4, category: "c", severity: "error", message: "m4", messageHash: "h4", status: "duplicate" },
    ]);
    const queries = makeQueries(db);
    expect(await queries.countFindingsByStatus()).toEqual({ posted: 1, suppressed: 2, duplicate: 1 });
  });

  it("counts outcomes by status via GROUP BY", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const findingIds = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333", "44444444-4444-4444-4444-444444444444"];
    await db.insert(findings).values(findingIds.map((id, i) => ({ id, repo: "r", prId: "1", commitSha: "a", filePath: `a${i}.ts`, lineStart: i, lineEnd: i, category: "c", severity: "error", message: `m${i}`, messageHash: `h${i}`, status: "posted" })));
    await db.insert(findingOutcomes).values([
      { findingId: findingIds[0]!, status: "posted" },
      { findingId: findingIds[1]!, status: "resolved" },
      { findingId: findingIds[2]!, status: "resolved" },
      { findingId: findingIds[3]!, status: "dismissed" },
    ]);
    const queries = makeQueries(db);
    expect(await queries.countOutcomesByStatus()).toEqual({ posted: 1, replied: 0, resolved: 2, dismissed: 1 });
  });
});
