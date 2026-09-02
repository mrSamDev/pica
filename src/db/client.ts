import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}
