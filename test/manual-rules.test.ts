import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema.ts";
import { learningEvents, repoRules } from "../src/db/schema.ts";
import { addManualRule, resolveRuleId, retireManualRule } from "../src/learning/rules/manual.ts";
import { isRuleSnapshot, type RuleSnapshot } from "../src/learning/events/snapshot.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();
const repo = "owner/repo";

describe.skipIf(!dockerAvailable)("manual rules (§11: rule add / rule retire)", () => {
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

  it("rule add creates an active rule and emits rule.manual_added with a snapshot", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const result = await addManualRule(db, { repo, ruleType: "ignore", glob: "generated/**", payload: { reason: "build output" } });
    expect(result.outcome).toBe("created");

    const rules = await db.select().from(repoRules).where(eq(repoRules.repo, repo));
    expect(rules).toHaveLength(1);
    expect(rules[0]?.status).toBe("active");
    expect(rules[0]?.glob).toBe("generated/**");
    expect(rules[0]?.createdBy).toBe("manual:cli");

    const events = await db.select().from(learningEvents).where(eq(learningEvents.eventType, "rule.manual_added"));
    expect(events).toHaveLength(1);
    expect(events[0]?.eventKey).toBe(`rule:${result.ruleId}:manual_added`);
    // The event carries a full snapshot so a rebuild reproduces the rule.
    expect(isRuleSnapshot(events[0]?.payload)).toBe(true);
    // SAFETY: isRuleSnapshot validated the payload above.
    const snapshot = events[0]!.payload as RuleSnapshot;
    expect(snapshot.ruleId).toBe(result.ruleId);
    expect(snapshot.glob).toBe("generated/**");
    expect(snapshot.status).toBe("active");
    expect(snapshot.createdBy).toBe("manual:cli");
  });

  it("re-adding the same (ruleType, glob) updates the payload instead of duplicating", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const repo2 = "owner/repo2";
    await addManualRule(db, { repo: repo2, ruleType: "ignore", glob: "dist/**", payload: { reason: "old" } });
    const second = await addManualRule(db, { repo: repo2, ruleType: "ignore", glob: "dist/**", payload: { reason: "build artifact" } });

    expect(second.outcome).toBe("updated");
    const rules = await db.select().from(repoRules).where(eq(repoRules.repo, repo2));
    expect(rules).toHaveLength(1);
    // SAFETY: addManualRule wrote payload { reason: ... } on this rule;
    // rules has length 1 asserted above, so the row exists.
    expect((rules[0]!.payload as { reason?: string }).reason).toBe("build artifact");

    const added = await db.select().from(learningEvents).where(eq(learningEvents.eventType, "rule.manual_added"));
    expect(added.filter((e) => e.repo === repo2)).toHaveLength(1);
    // The payload change is evented as a rule.updated snapshot.
    const updated = (await db.select().from(learningEvents).where(eq(learningEvents.eventType, "rule.updated"))).filter((e) => e.repo === repo2);
    expect(updated).toHaveLength(1);
    expect(isRuleSnapshot(updated[0]?.payload)).toBe(true);
    // SAFETY: isRuleSnapshot validated the payload above; the event exists
    // because the length assertion passed.
    expect((updated[0]!.payload as RuleSnapshot).ruleId).toBe(second.ruleId);
  });

  it("rule retire sets retired + deactivatedAt and emits rule.manual_retired", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const repo3 = "owner/repo3";
    const added = await addManualRule(db, { repo: repo3, ruleType: "ignore", glob: "vendor/**", payload: { reason: "vendored" } });
    const retired = await retireManualRule(db, { repo: repo3, ruleId: added.ruleId, retiredBy: "sam" });
    expect(retired.outcome).toBe("retired");

    const rules = await db.select().from(repoRules).where(eq(repoRules.repo, repo3));
    expect(rules[0]?.status).toBe("retired");
    expect(rules[0]?.deactivatedAt).toBeInstanceOf(Date);

    const events = await db.select().from(learningEvents).where(eq(learningEvents.eventType, "rule.manual_retired"));
    expect(events).toHaveLength(1);
    expect(events[0]?.eventKey).toBe(`rule:${added.ruleId}:manual_retired`);
    // SAFETY: retireManualRule emits payload { ruleId, retiredBy, retiredAt };
    // events has length 1 asserted above, so the row exists.
    expect((events[0]!.payload as { retiredBy: string }).retiredBy).toBe("sam");

    // Retiring again is a no-op: no second event, no resurrect path.
    const again = await retireManualRule(db, { repo: repo3, ruleId: added.ruleId, retiredBy: "sam" });
    expect(again.outcome).toBe("already-retired");
    const eventsAfter = await db.select().from(learningEvents).where(eq(learningEvents.eventType, "rule.manual_retired"));
    expect(eventsAfter).toHaveLength(1);
  });

  it("adding over a retired rule is a no-op (retire is terminal this phase)", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const repo4 = "owner/repo4";
    const added = await addManualRule(db, { repo: repo4, ruleType: "ignore", glob: "gen/**", payload: { reason: "r" } });
    await retireManualRule(db, { repo: repo4, ruleId: added.ruleId, retiredBy: "sam" });

    const readd = await addManualRule(db, { repo: repo4, ruleType: "ignore", glob: "gen/**", payload: { reason: "new reason" } });
    expect(readd.outcome).toBe("noop-retired");
    const rules = await db.select().from(repoRules).where(eq(repoRules.repo, repo4));
    expect(rules).toHaveLength(1);
    expect(rules[0]?.status).toBe("retired");
    // SAFETY: the retire guard must leave the original payload untouched;
    // rules has length 1 asserted above, so the row exists.
    expect((rules[0]!.payload as { reason?: string }).reason).toBe("r");
  });

  it("re-adding the same payload is a no-op: no row bump, no event", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const repo6 = "owner/repo6";
    await addManualRule(db, { repo: repo6, ruleType: "ignore", glob: "same/**", payload: { reason: "same" } });
    const before = await db.select().from(repoRules).where(eq(repoRules.repo, repo6));
    const beforeEvents = (await db.select().from(learningEvents).where(eq(learningEvents.eventType, "rule.updated"))).filter((e) => e.repo === repo6);

    const again = await addManualRule(db, { repo: repo6, ruleType: "ignore", glob: "same/**", payload: { reason: "same" } });

    expect(again.outcome).toBe("unchanged");
    const after = await db.select().from(repoRules).where(eq(repoRules.repo, repo6));
    expect(after[0]?.lastObservedAt?.toISOString()).toBe(before[0]?.lastObservedAt?.toISOString());
    const afterEvents = (await db.select().from(learningEvents).where(eq(learningEvents.eventType, "rule.updated"))).filter((e) => e.repo === repo6);
    expect(afterEvents).toHaveLength(beforeEvents.length);
  });

  it("resolveRuleId finds a rule by id or by pattern", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const repo5 = "owner/repo5";
    const patternId = randomUUID();
    await db.insert(schema.patterns).values({ id: patternId, repo: repo5, category: "security", canonicalMessage: "security:test", patternVersion: "v1", status: "active" });
    await db.insert(repoRules).values({ id: "aaaaaaaa-1111-4111-8111-111111111111", repo: repo5, ruleType: "ignore", patternId, payload: { reason: "r" }, payloadHash: "h", status: "active", createdBy: "auto:learning" });

    expect(await resolveRuleId(db, repo5, { ruleId: "aaaaaaaa-1111-4111-8111-111111111111" })).toBe("aaaaaaaa-1111-4111-8111-111111111111");
    expect(await resolveRuleId(db, repo5, { patternId })).toBe("aaaaaaaa-1111-4111-8111-111111111111");
    expect(await resolveRuleId(db, repo5, { ruleId: randomUUID() })).toBeNull();
  });
});
