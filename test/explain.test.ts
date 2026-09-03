import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema.ts";
import { eq } from "drizzle-orm";
import { findings, findingOutcomes, patterns, repoRules } from "../src/db/schema.ts";
import { explainRule, listRulesForRepo } from "../src/learning/explain.ts";
import { runLearner } from "../src/learning/learner/learner.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();
const repo = "owner/explain";
const opts = { minEvidence: 3, activationThreshold: 0.7, severityWeights: { error: 3, warning: 2, suggestion: 1 } };

describe.skipIf(!dockerAvailable)("explain-rule (§11: rule -> findings -> outcomes)", () => {
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

  it("shows the full evidence trail: rule -> findings -> outcomes", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const patternId = randomUUID();
    await db.insert(patterns).values({ id: patternId, repo, category: "security", canonicalMessage: "security:jwt-exp", patternVersion: "v1", status: "active" });

    const findingIds: string[] = [];
    // 3 dismissed findings across two PRs + 1 resolved.
    for (const [i, prId] of ["182", "182", "187", "191"].entries()) {
      const findingId = randomUUID();
      findingIds.push(findingId);
      await db.insert(findings).values({ id: findingId, reviewId: null, repo, prId, commitSha: "abc", filePath: "src/auth.ts", lineStart: 40 + i, lineEnd: 40 + i, category: "security", patternId, severity: "suggestion", message: `m${i}`, messageHash: `h${i}`, status: "posted" });
      const status = i === 3 ? "resolved" : "dismissed";
      await db.insert(findingOutcomes).values({ findingId, status, dismissalReason: i === 3 ? null : "false positive" });
    }
    await runLearner(db, { findingId: findingIds[0]!, repo }, opts);

    const ruleRows = await db.select().from(repoRules).where(eq(repoRules.repo, repo));
    const ruleId = ruleRows[0]?.id;
    expect(ruleId).toBeDefined();

    const explanation = await explainRule(db, repo, ruleId!);
    expect(explanation).not.toBeNull();
    expect(explanation?.ruleType).toBe("ignore");
    expect(explanation?.status).toBe("candidate");
    expect(explanation?.pattern?.canonicalMessage).toBe("security:jwt-exp");
    expect(explanation?.pattern?.category).toBe("security");
    // 3 dismissed (weight 1) + 1 resolved: confidence (3+2)/(4+4) = 5/8.
    expect(explanation?.confidence).toBeCloseTo(5 / 8);

    // Evidence trail: every finding with its outcome.
    expect(explanation?.evidence).toHaveLength(4);
    const dismissed = explanation?.evidence.filter((e) => e.outcome === "dismissed");
    expect(dismissed).toHaveLength(3);
    expect(dismissed?.[0]?.filePath).toBe("src/auth.ts");
    expect(dismissed?.[0]?.dismissalReason).toBe("false positive");
    expect(explanation?.evidence.some((e) => e.outcome === "resolved")).toBe(true);

    // Learned-from PRs are the distinct PRs of the evidence findings.
    expect(explanation?.learnedFromPrs.sort()).toEqual(["182", "187", "191"]);
  });

  it("explains a manual rule with no evidence (glob + reason)", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const repo2 = "owner/explain-manual";
    await db.insert(repoRules).values({ id: "bbbbbbbb-2222-4222-8222-222222222222", repo: repo2, ruleType: "ignore", patternId: null, glob: "generated/**", payload: { reason: "build output" }, payloadHash: "h", status: "active", createdBy: "manual:cli" });

    const explanation = await explainRule(db, repo2, "bbbbbbbb-2222-4222-8222-222222222222");
    expect(explanation?.glob).toBe("generated/**");
    expect(explanation?.pattern).toBeNull();
    expect(explanation?.evidence).toEqual([]);
    // SAFETY: addManualRule wrote payload { reason: "build output" };
    // explainRule returned non-null (asserted above).
    expect((explanation!.payload as { reason?: string }).reason).toBe("build output");
  });

  it("returns null for an unknown rule", async () => {
    if (db === undefined) throw new Error("db not initialized");
    expect(await explainRule(db, repo, randomUUID())).toBeNull();
  });

  it("lists a repo's rules with their identity fields", async () => {
    if (db === undefined) throw new Error("db not initialized");
    const rules = await listRulesForRepo(db, repo);
    expect(rules.length).toBeGreaterThanOrEqual(1);
    const learned = rules.find((r) => r.createdBy === "auto:learning");
    expect(learned?.patternCategory).toBe("security");
    expect(learned?.status).toBe("candidate");
  });
});
