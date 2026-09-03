import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema.ts";
import { findings, patterns } from "../src/db/schema.ts";
import { embed } from "../src/learning/retrieval/embed.ts";
import { findRelatedPatterns } from "../src/learning/retrieval/semantic.ts";
import { getReviewLearningContext } from "../src/learning/retrieval/retrieval.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

// §5.10 V2: semantic retrieval against pgvector. Proves the demonstrated pair
// (docs/retrieval-problem.md) is found by embedding distance where exact
// taxonomy matching splits it.
const dockerAvailable = await isDockerAvailable();
const repo = "owner/repo";

const A = "JWT expiration isn't validated; a rejected token still passes.";
const B = "JWT expiry isn't validated; a rejected token still passes.";
const C = "Hardcoded signing secret in source; move to env config.";

describe.skipIf(!dockerAvailable)("semantic retrieval (pgvector)", () => {
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

  // The container DB is shared across tests; clear learning tables so each
  // test starts from empty (patterns/findings are the only ones we write).
  beforeEach(async () => {
    if (db === undefined) throw new Error("db not initialized");
    await db.delete(findings);
    await db.delete(patterns);
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("findRelatedPatterns finds the near-duplicate sibling but not unrelated patterns", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const aId = randomUUID();
    const bId = randomUUID();
    await db.insert(patterns).values([
      { id: aId, repo, category: "security", canonicalMessage: "security:jwt-expiration", patternVersion: "v1", status: "active", embedding: embed(A) },
      { id: bId, repo, category: "security", canonicalMessage: "security:jwt-expiry-validation", patternVersion: "v1", status: "active", embedding: embed(B) },
      { id: randomUUID(), repo, category: "security", canonicalMessage: "security:hardcoded-secret", patternVersion: "v1", status: "active", embedding: embed(C) },
      // Pre-v2 row: NULL embedding must be skipped, not matched.
      { id: randomUUID(), repo, category: "concurrency", canonicalMessage: "concurrency:check-then-act", patternVersion: "v1", status: "active" },
    ]);

    const related = await findRelatedPatterns(db, repo, A, { limit: 10, excludePatternId: aId });
    expect(related).toContain("security:jwt-expiry-validation");
    expect(related).not.toContain("security:jwt-expiration"); // exact sibling excluded
    expect(related).not.toContain("security:hardcoded-secret");
    expect(related).not.toContain("concurrency:check-then-act");
  });

  it("memory context annotates related-but-distinct patterns as one issue", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const aId = randomUUID();
    const bId = randomUUID();
    await db.insert(patterns).values([
      { id: aId, repo, category: "security", canonicalMessage: "security:jwt-expiration", patternVersion: "v1", status: "active", embedding: embed(A) },
      { id: bId, repo, category: "security", canonicalMessage: "security:jwt-expiry-validation", patternVersion: "v1", status: "active", embedding: embed(B) },
    ]);
    const stamp = new Date().toISOString();
    await db.insert(findings).values([
      { id: randomUUID(), reviewId: null, repo, prId: "1", commitSha: stamp, filePath: "src/a.ts", lineStart: 1, lineEnd: 1, category: "security", patternId: aId, severity: "error", message: A, messageHash: "h1", status: "posted" },
      { id: randomUUID(), reviewId: null, repo, prId: "2", commitSha: "b", filePath: "src/b.ts", lineStart: 1, lineEnd: 1, category: "security", patternId: bId, severity: "error", message: B, messageHash: "h2", status: "posted" },
    ]);

    const ctx = await getReviewLearningContext(db, repo);
    // Both keys present, and the semantic link is surfaced so the prompt knows
    // they are one defect, not two unrelated ones.
    expect(ctx.memoryContext).toContain("security:jwt-expiration");
    expect(ctx.memoryContext).toContain("security:jwt-expiry-validation");
    // The related line surfaces the semantic link between the fragmented pair.
    expect(ctx.memoryContext).toMatch(/related: .*jwt-expiration ≈ .*jwt-expiry-validation/);
  });
});
