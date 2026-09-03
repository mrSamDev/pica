import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema.ts";
import { learningEvents } from "../src/db/schema.ts";
import { emitEvent } from "../src/learning/events/emit.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();

// §3, §5.3: the event stream is idempotent (retry-safe) and immutable.

describe.skipIf(!dockerAvailable)("learning events", () => {
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

  it("event_key is deterministic: emitting the same event twice is a no-op (no double-count)", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const event = {
      eventKey: "finding:11111111-1111-1111-1111-111111111111:outcome:dismissed",
      repo: "owner/repo",
      eventType: "finding.outcome_changed",
      aggregateId: "finding:11111111-1111-1111-1111-111111111111",
      payload: { status: "dismissed" },
    };

    await emitEvent(db, event);
    await emitEvent(db, event);

    const rows = await db.select().from(learningEvents).where(eq(learningEvents.eventKey, event.eventKey));
    expect(rows).toHaveLength(1);
  });

  it("events are immutable: UPDATE and DELETE are rejected by the DB trigger", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const event = {
      eventKey: "finding:22222222-2222-2222-2222-222222222222:outcome:resolved",
      repo: "owner/repo",
      eventType: "finding.outcome_changed",
      aggregateId: "finding:22222222-2222-2222-2222-222222222222",
      payload: { status: "resolved" },
    };
    await emitEvent(db, event);

    await expect(
      db
        .update(learningEvents)
        .set({ payload: { status: "dismissed" } })
        .where(eq(learningEvents.eventKey, event.eventKey)),
    ).rejects.toThrow();
    await expect(db.delete(learningEvents).where(eq(learningEvents.eventKey, event.eventKey))).rejects.toThrow();

    // History is untouched.
    const rows = await db.select().from(learningEvents).where(eq(learningEvents.eventKey, event.eventKey));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ status: "resolved" });
  });
});
