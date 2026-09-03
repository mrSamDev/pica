import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema.ts";
import { findings, findingOutcomes, learningEvents, patterns, repoRules, reviews, ruleEvidence } from "../src/db/schema.ts";
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

  it("counts rules by status via GROUP BY", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const pa = randomUUID();
    const pb = randomUUID();
    const pc = randomUUID();
    await db.insert(patterns).values([
      { id: pa, repo: "r", category: "security", canonicalMessage: "security:count-a", patternVersion: "v1", status: "active" },
      { id: pb, repo: "r", category: "security", canonicalMessage: "security:count-b", patternVersion: "v1", status: "active" },
      { id: pc, repo: "r", category: "security", canonicalMessage: "security:count-c", patternVersion: "v1", status: "active" },
    ]);
    await db.insert(repoRules).values([
      { repo: "r", ruleType: "ignore", patternId: pa, payload: { patternKey: "security:count-a" }, payloadHash: "h1", status: "active", confidence: "0.9", evidenceCount: 4, negativeCount: 4, positiveCount: 0, createdBy: "auto:learning" },
      { repo: "r", ruleType: "ignore", patternId: pb, payload: { patternKey: "security:count-b" }, payloadHash: "h2", status: "candidate" },
      { repo: "r", ruleType: "ignore", patternId: pc, payload: { patternKey: "security:count-c" }, payloadHash: "h3", status: "retired" },
    ]);
    const queries = makeQueries(db);
    expect(await queries.countRulesByStatus()).toEqual({ active: 1, candidate: 1, retired: 1 });
  });

  it("lists rules with evidence counts and pattern", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const p1 = randomUUID();
    await db.insert(patterns).values({ id: p1, repo: "r", category: "security", canonicalMessage: "security:listrule", patternVersion: "v1", status: "active" });
    await db.insert(repoRules).values({ repo: "r", ruleType: "ignore", patternId: p1, payload: { patternKey: "security:listrule" }, payloadHash: "h", status: "active", confidence: "0.85", evidenceCount: 6, negativeCount: 6, positiveCount: 0, createdBy: "auto:learning" });
    const queries = makeQueries(db);
    const rules = await queries.listRules();
    expect(rules.some((r) => r.pattern === "security:listrule" && r.confidence === 0.85 && r.evidenceCount === 6)).toBe(true);
  });

  it("why-disappeared: links a suppressed finding to its rule + evidence", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const patternId = randomUUID();
    const findingId = randomUUID();
    const ruleId = randomUUID();
    const evidenceFindingId = randomUUID();
    const reviewId = randomUUID();
    await db.insert(reviews).values({ id: reviewId, repo: "r", prId: "182", commitSha: "abc", status: "done", mode: "post" });
    await db.insert(patterns).values({ id: patternId, repo: "r", category: "security", canonicalMessage: "security:why", patternVersion: "v1", status: "active" });
    await db.insert(findings).values({ id: findingId, reviewId, repo: "r", prId: "200", commitSha: "a", filePath: "src/a.ts", lineStart: 1, lineEnd: 1, category: "security", patternId, severity: "error", message: "JWT not validated", messageHash: "h", status: "suppressed" });
    await db.insert(findings).values({ id: evidenceFindingId, reviewId, repo: "r", prId: "182", commitSha: "a", filePath: "src/b.ts", lineStart: 1, lineEnd: 1, category: "security", patternId, severity: "error", message: "JWT", messageHash: "h2", status: "posted" });
    await db.insert(repoRules).values({ id: ruleId, repo: "r", ruleType: "ignore", patternId, payload: { patternKey: "security:why" }, payloadHash: "h", status: "active", confidence: "0.9", evidenceCount: 3, negativeCount: 3, positiveCount: 0, createdBy: "auto:learning" });
    await db.insert(ruleEvidence).values({ ruleId, findingId: evidenceFindingId, outcome: "dismissed" });
    await db.insert(findingOutcomes).values({ findingId: evidenceFindingId, status: "dismissed" });

    const why = await makeQueries(db).whyDisappeared(findingId);
    expect(why?.finding.status).toBe("suppressed");
    expect(why?.pattern.canonicalMessage).toBe("security:why");
    expect(why?.rule?.status).toBe("active");
    expect(why?.rule?.confidence).toBeCloseTo(0.9);
    expect(why?.evidence).toEqual([{ prId: "182", outcome: "dismissed" }]);
    expect(why?.lastProbe).toBeNull();
  });

  it("why-disappeared: returns a rule-less record (post-filter drop, not a learned rule)", async () => {
    if (db === undefined) throw new Error("db not initialized");
    // A suppressed finding whose pattern has no learned rule must still resolve
    // (the earlier ""-uuid evidence query 500s; this guards that path).
    const patternId = randomUUID();
    const findingId = randomUUID();
    const reviewId = randomUUID();
    await db.insert(reviews).values({ id: reviewId, repo: "r", prId: "300", commitSha: "abc", status: "done", mode: "post" });
    await db.insert(patterns).values({ id: patternId, repo: "r", category: "security", canonicalMessage: "security:norule", patternVersion: "v1", status: "active" });
    await db.insert(findings).values({ id: findingId, reviewId, repo: "r", prId: "300", commitSha: "a", filePath: "src/a.ts", lineStart: 1, lineEnd: 1, category: "security", patternId, severity: "error", message: "dup", messageHash: "hd", status: "suppressed" });

    const why = await makeQueries(db).whyDisappeared(findingId);
    expect(why?.finding.status).toBe("suppressed");
    expect(why?.rule).toBeNull();
    expect(why?.evidence).toEqual([]);
  });

  it("§8: dismissal-rate trend is one rate per review over time, oldest first", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const d = db;
    // Two reviews in an isolated repo: 1 dis/1 res (0.5) then 1 dis (1.0).
    const spec = [
      { dismissed: 1, resolved: 1, completedAt: new Date("2026-01-01T00:00:00Z") },
      { dismissed: 1, resolved: 0, completedAt: new Date("2026-01-02T00:00:00Z") },
    ];
    for (const r of spec) {
      const reviewId = randomUUID();
      const prId = randomUUID();
      await d.insert(reviews).values({ id: reviewId, repo: "trend/a", prId, commitSha: "abc", status: "done", mode: "post", completedAt: r.completedAt });
      for (let i = 0; i < r.dismissed; i++) {
        const findingId = randomUUID();
        await d.insert(findings).values({ id: findingId, reviewId, repo: "trend/a", prId, commitSha: "a", filePath: `d${i}.ts`, lineStart: i, lineEnd: i, category: "c", severity: "warning", message: `dis${i}`, messageHash: `h${i}`, status: "posted" });
        await d.insert(findingOutcomes).values({ findingId, status: "dismissed" });
      }
      for (let i = 0; i < r.resolved; i++) {
        const findingId = randomUUID();
        await d.insert(findings).values({ id: findingId, reviewId, repo: "trend/a", prId, commitSha: "a", filePath: `r${i}.ts`, lineStart: i, lineEnd: i, category: "c", severity: "suggestion", message: `res${i}`, messageHash: `rh${i}`, status: "posted" });
        await d.insert(findingOutcomes).values({ findingId, status: "resolved" });
      }
    }
    const trend = await makeQueries(d).dismissalRateTrend();
    // This file's other tests seed decisive outcomes on null-dated reviews,
    // so only assert on the deterministic parts of our chronology: 0.5 appears,
    // and a 1.0 follows it (our second review's rate).
    expect(trend.includes(0.5)).toBe(true);
    const idx50 = trend.indexOf(0.5);
    expect(trend.slice(idx50).includes(1)).toBe(true);
  });

  it("§5.7: probes() lists recent ε-probe events and lastProbe surfaces on the drill-down", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const patternId = randomUUID();
    const findingId = randomUUID();
    const reviewId = randomUUID();
    const probedAt = new Date("2026-02-03T00:00:00Z");
    await db.insert(reviews).values({ id: reviewId, repo: "r", prId: "400", commitSha: "abc", status: "done", mode: "post" });
    await db.insert(patterns).values({ id: patternId, repo: "r", category: "correctness", canonicalMessage: "correctness:probed", patternVersion: "v1", status: "active" });
    await db.insert(findings).values({ id: findingId, reviewId, repo: "r", prId: "400", commitSha: "a", filePath: "src/lib/db.ts", lineStart: 1, lineEnd: 1, category: "correctness", patternId, severity: "warning", message: "probed", messageHash: "hp", status: "posted" });
    await db.insert(learningEvents).values({ eventKey: `pattern:${patternId}:probed:${findingId}`, repo: "r", eventType: "pattern.probed", aggregateId: `pattern:${patternId}`, payload: { findingId, filePath: "src/lib/db.ts" }, createdAt: probedAt });

    const probes = await makeQueries(db).probes();
    expect(probes[0]?.filePath).toBe("src/lib/db.ts");
    expect(new Date(probes[0]!.at).toISOString()).toBe(probedAt.toISOString());
    const why = await makeQueries(db).whyDisappeared(findingId);
    expect(why?.lastProbe).not.toBeNull();
  });
});
