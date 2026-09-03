import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { Db } from "./client.ts";

// Resolved from this module so it works both from the repo root (tests, dev)
// and from /app in the Docker image.
const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Apply pending drizzle migrations. Idempotent: drizzle tracks applied
 * migrations in its journal table, so a restart with nothing pending is a
 * no-op. Called on boot (§12 single-process deploy) so `docker compose up`
 * boots the full stack with no separate migration step.
 */
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
