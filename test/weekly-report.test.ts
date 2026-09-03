import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema.ts";
import { findings, findingOutcomes, learningEvents, patterns } from "../src/db/schema.ts";
import { weeklyReport } from "../src/learning/report.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();
const repo = "owner/report";

const NOW = new Date("2026-09-08T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe.skipIf(!dockerAvailable)("weekly report (§11: learned/retired + dismissals by category)", () => {
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

  let lineSeed = 0;
  async function seedDismissedFinding(category: string, dismissedAt: Date): Promise<void> {
    if (db === undefined) throw new Error("db not initialized");
    const findingId = randomUUID();
    const patternId = randomUUID();
    const line = ++lineSeed;
    await db.insert(patterns).values({ id: patternId, repo, category, canonicalMessage: `${category}:${randomUUID()}`, patternVersion: "v1", status: "active" });
    await db.insert(findings).values({ id: findingId, reviewId: null, repo, prId: "9", commitSha: "abc", filePath: "src/x.ts", lineStart: line, lineEnd: line, category, patternId, severity: "suggestion", message: `m${line}`, messageHash: randomUUID(), status: "posted" });
    await db.insert(findingOutcomes).values({ findingId, status: "dismissed", dismissalReason: "noisy", updatedAt: dismissedAt });
  }

  it("lists rules learned/retired in the window and dismissals by category", async () => {
    if (db === undefined) throw new Error("db not initialized");

    // Rule activations: one in-window, one ancient.
    await db.insert(learningEvents).values({ eventKey: "pattern:recent:activated", repo, eventType: "rule.activated", aggregateId: `pattern:${randomUUID()}`, payload: { ruleId: randomUUID() }, createdAt: daysAgo(2) });
    await db.insert(learningEvents).values({ eventKey: "pattern:ancient:activated", repo, eventType: "rule.activated", aggregateId: `pattern:${randomUUID()}`, payload: { ruleId: randomUUID() }, createdAt: daysAgo(12) });

    // Manual retires: one in-window, one ancient.
    await db.insert(learningEvents).values({ eventKey: "rule:recent:manual_retired", repo, eventType: "rule.manual_retired", aggregateId: `rule:${randomUUID()}`, payload: { ruleId: randomUUID(), retiredBy: "sam", retiredAt: daysAgo(3).toISOString() }, createdAt: daysAgo(3) });
    await db.insert(learningEvents).values({ eventKey: "rule:ancient:manual_retired", repo, eventType: "rule.manual_retired", aggregateId: `rule:${randomUUID()}`, payload: { ruleId: randomUUID(), retiredBy: "sam", retiredAt: daysAgo(20).toISOString() }, createdAt: daysAgo(20) });

    // Dismissals: 2 security + 1 style in-window, 1 ancient security.
    await seedDismissedFinding("security", daysAgo(1));
    await seedDismissedFinding("security", daysAgo(4));
    await seedDismissedFinding("style", daysAgo(2));
    await seedDismissedFinding("security", daysAgo(15));

    const report = await weeklyReport(db, NOW);

    expect(report.from.toISOString()).toBe(daysAgo(7).toISOString());
    expect(report.to.toISOString()).toBe(NOW.toISOString());

    expect(report.learnedRules).toHaveLength(1);
    expect(report.learnedRules[0]?.activatedAt.toISOString()).toBe(daysAgo(2).toISOString());
    expect(report.learnedRules[0]?.repo).toBe(repo);

    expect(report.retiredRules).toHaveLength(1);
    expect(report.retiredRules[0]?.retiredBy).toBe("sam");
    expect(report.retiredRules[0]?.retiredAt.toISOString()).toBe(daysAgo(3).toISOString());

    const byCategory = new Map(report.dismissalsByCategory.map((d) => [d.category, d.count]));
    expect(byCategory.get("security")).toBe(2);
    expect(byCategory.get("style")).toBe(1);
  });

  it("empty week: zeroed report, not an error", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const empty = await weeklyReport(db, NOW, "owner/empty-repo");
    expect(empty.learnedRules).toEqual([]);
    expect(empty.retiredRules).toEqual([]);
    expect(empty.dismissalsByCategory).toEqual([]);
  });

  it("§5.5: a dismissed error appears flagged for human confirmation until confirmed", async () => {
    if (db === undefined) throw new Error("db not initialized");
    // Two dismissed error findings in-window: one confirmed, one not.
    const findingId = randomUUID();
    const patternId = randomUUID();
    await db.insert(patterns).values({ id: patternId, repo, category: "correctness", canonicalMessage: `correctness:err:${randomUUID()}`, patternVersion: "v1", status: "active" });
    await db.insert(findings).values({ id: findingId, reviewId: null, repo, prId: "9", commitSha: "abc", filePath: "src/c.ts", lineStart: 1, lineEnd: 1, category: "correctness", patternId, severity: "error", message: "data race", messageHash: randomUUID(), status: "posted" });
    await db.insert(findingOutcomes).values({ findingId, status: "dismissed", dismissalReason: "fp", updatedAt: daysAgo(2) });

    const confirmedId = randomUUID();
    const confirmedPattern = randomUUID();
    await db.insert(patterns).values({ id: confirmedPattern, repo, category: "correctness", canonicalMessage: `correctness:err-c:${randomUUID()}`, patternVersion: "v1", status: "active" });
    await db
      .insert(findings)
      .values({ id: confirmedId, reviewId: null, repo, prId: "9", commitSha: "abc", filePath: "src/d.ts", lineStart: 1, lineEnd: 1, category: "correctness", patternId: confirmedPattern, severity: "error", message: "confirmed race", messageHash: randomUUID(), status: "posted" });
    await db.insert(findingOutcomes).values({ findingId: confirmedId, status: "dismissed", updatedAt: daysAgo(1) });
    await db.insert(learningEvents).values({ eventKey: `finding:${confirmedId}:dismissal_confirmed`, repo, eventType: "finding.dismissal_confirmed", aggregateId: `finding:${confirmedId}`, payload: { findingId: confirmedId, confirmedBy: "sam" }, createdAt: daysAgo(1) });

    const report = await weeklyReport(db, NOW);
    expect(report.needsConfirmation).toHaveLength(1);
    const pending = report.needsConfirmation[0]!;
    expect(pending.findingId).toBe(findingId);
    expect(pending.severity).toBe("error");
    expect(pending.message).toBe("data race");
  });
});
