import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema.ts";
import { learningEvents } from "../src/db/schema.ts";
import { parseArgs } from "../src/cli/args.ts";
import { runCommand, type CliDeps } from "../src/cli/commands.ts";
import { loadConfig } from "../src/config.ts";
import type { Finding } from "../src/review/types.ts";
import { createFakeMetrics, createFakePlatform } from "./helpers/fakes.ts";
import { isDockerAvailable } from "./helpers/docker.ts";

const dockerAvailable = await isDockerAvailable();

const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
@@ -40,1 +40,2 @@
+if (!token.exp) { throw new Error("missing exp"); }
`;

const FINDING: Finding = { filePath: "src/auth.ts", lineStart: 40, lineEnd: 40, category: "security", patternId: "security:jwt-expiration", patternUuid: "", severity: "warning", message: "JWT expiration isn't validated." };

describe("cli args", () => {
  it("parses each command", () => {
    expect(parseArgs(["review", "--dry-run", "--repo", "owner/api", "--pr", "142", "--diff-href", "https://x"])).toEqual({ name: "review", repo: "owner/api", prId: "142", diffHref: "https://x", dryRun: true });
    expect(parseArgs(["explain-rule", "owner/api", "--rule", "abc"])).toEqual({ name: "explain-rule", repo: "owner/api", ruleId: "abc", patternId: undefined });
    expect(parseArgs(["rule", "add", "owner/api", "--ignore", "generated/**", "--reason", "build output"])).toEqual({ name: "rule-add", repo: "owner/api", ruleType: "ignore", glob: "generated/**", payload: { reason: "build output" } });
    expect(parseArgs(["rule", "retire", "owner/api", "--rule", "abc", "--by", "sam"])).toEqual({ name: "rule-retire", repo: "owner/api", ruleId: "abc", patternId: undefined, retiredBy: "sam" });
    expect(parseArgs(["eval", "--replay", "cases.json", "--golden", "golden.json"])).toEqual({ name: "eval", casesPath: "cases.json", goldenPath: "golden.json" });
    expect(parseArgs(["report", "--weekly", "--repo", "owner/api"])).toEqual({ name: "report", weekly: true, repo: "owner/api" });
    expect(parseArgs(["confirm-dismissal", "owner/api", "--finding", "abc", "--by", "sam"])).toEqual({ name: "confirm-dismissal", repo: "owner/api", findingId: "abc", confirmedBy: "sam" });
    expect(parseArgs(["rebuild-read-model"])).toEqual({ name: "rebuild-read-model" });
  });

  it("rejects bad usage", () => {
    expect(() => parseArgs([])).toThrow(/usage/i);
    expect(() => parseArgs(["nonsense"])).toThrow(/unknown command/i);
    expect(() => parseArgs(["review", "--repo", "owner/api"])).toThrow(/--pr/);
  });
});

describe.skipIf(!dockerAvailable)("cli commands", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool | undefined;
  let db: NodePgDatabase<typeof schema> | undefined;
  let deps: CliDeps | undefined;

  const config = loadConfig({
    DATABASE_URL: "postgres://localhost:5432/pica",
    REDIS_URL: "redis://localhost:6379",
    WEBHOOK_SECRET: "s",
    LLM_API_KEY: "k",
    PLATFORM_TOKEN: "t",
    LOG_LEVEL: "silent",
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const raw = drizzle(pool);
    await migrate(raw, { migrationsFolder: "./drizzle" });
    db = drizzle(pool, { schema });
    deps = {
      db,
      platform: { ...createFakePlatform(), fetchDiff: async () => DIFF },
      llm: { review: async () => JSON.stringify([FINDING]) },
      config,
      metrics: createFakeMetrics(),
      now: () => new Date("2026-09-08T12:00:00Z"),
    };
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("review --dry-run prints findings + learning context (§11 output)", async () => {
    if (deps === undefined) throw new Error("deps not initialized");
    const out = await runCommand(deps, parseArgs(["review", "--dry-run", "--repo", "owner/api", "--pr", "142", "--diff-href", "https://diff"]));
    expect(out).toContain("PR #142");
    expect(out).toContain("src/auth.ts:40");
    expect(out).toContain("JWT expiration isn't validated.");
    expect(out).toMatch(/Learning context:\n  \d+ active rules\n  \d+ relevant historical findings/);
  });

  it("explain-rule renders the §11 evidence trail", async () => {
    if (deps === undefined || db === undefined) throw new Error("not initialized");
    const out1 = await runCommand(deps, parseArgs(["rule", "add", "owner/explain", "--ignore", "generated/**", "--reason", "build output"]));
    expect(out1).toContain("created");

    // No selector: lists rules with ids so a user can pick.
    const listed = await runCommand(deps, parseArgs(["explain-rule", "owner/explain"]));
    expect(listed).toContain("ignore");
    expect(listed).toContain("generated/**");

    const ruleId = listed.match(/([0-9a-f-]{36})/)?.[1];
    expect(ruleId).toBeDefined();

    const explained = await runCommand(deps, parseArgs(["explain-rule", "owner/explain", "--rule", ruleId!]));
    expect(explained).toContain("RULE: ignore");
    expect(explained).toContain("SCOPE: generated/**");
    expect(explained).toContain("Created by: manual:cli");
  });

  it("rule add + rule retire emit manual events", async () => {
    if (deps === undefined || db === undefined) throw new Error("not initialized");
    const added = await runCommand(deps, parseArgs(["rule", "add", "owner/retire", "--ignore", "vendor/**", "--reason", "vendored"]));
    expect(added).toContain("Rule");
    const retiredOut = await runCommand(deps, parseArgs(["rule", "retire", "owner/retire", "--ignore", "vendor/**", "--by", "sam"]));
    expect(retiredOut).toContain("retired");

    const addedEvents = await db.select().from(learningEvents);
    expect(addedEvents.some((e) => e.eventType === "rule.manual_added")).toBe(true);
    expect(addedEvents.some((e) => e.eventType === "rule.manual_retired")).toBe(true);
  });

  it("report --weekly renders learned/retired + dismissals by category", async () => {
    if (deps === undefined) throw new Error("not initialized");
    const out = await runCommand(deps, parseArgs(["report", "--weekly"]));
    expect(out).toContain("Weekly learning report");
    expect(out).toMatch(/Rules learned: \d+/);
    expect(out).toMatch(/Rules retired: \d+/);
    expect(out).toMatch(/Dismissals by category:/);
  });

  it("eval --replay prints precision/recall per prompt_version x rules_version", async () => {
    if (deps === undefined) throw new Error("not initialized");
    const dir = mkdtempSync(join(tmpdir(), "pica-eval-"));
    const casesPath = join(dir, "cases.json");
    const goldenPath = join(dir, "golden.json");
    writeFileSync(casesPath, JSON.stringify([{ repo: "owner/api", prId: "142", diff: DIFF }]));
    writeFileSync(goldenPath, JSON.stringify({ "142": [{ filePath: "src/auth.ts", lineStart: 41, lineEnd: 41, category: "security", message: "JWT expiration isn't validated." }] }));

    const out = await runCommand(deps, parseArgs(["eval", "--replay", casesPath, "--golden", goldenPath]));
    expect(out).toContain("prompt_version: v1");
    expect(out).toMatch(/rules_version: (none|[0-9a-f]{12})/);
    expect(out).toMatch(/Precision: \d+\.\d+/);
    expect(out).toMatch(/Recall: \d+\.\d+/);
    expect(out).toContain("owner/api #142");
  });

  it("rebuild-read-model prints a convergence summary", async () => {
    if (deps === undefined) throw new Error("not initialized");
    const out = await runCommand(deps, parseArgs(["rebuild-read-model"]));
    expect(out).toMatch(/Rebuilt \d+ rules from \d+ events/);
  });

  it("unknown rule retire fails fast", async () => {
    if (deps === undefined) throw new Error("not initialized");
    await expect(runCommand(deps, parseArgs(["rule", "retire", "owner/missing", "--rule", randomUUID(), "--by", "sam"]))).rejects.toThrow(/not found/);
  });

  it("§5.5: confirm-dismissal routes a dismissed error to the learner + idempotent event", async () => {
    if (deps === undefined || db === undefined) throw new Error("not initialized");
    // A dismissed error finding (non-protected category) awaiting confirmation.
    const findingId = randomUUID();
    const patternId = randomUUID();
    await db.insert(schema.patterns).values({ id: patternId, repo: "owner/confirm", category: "correctness", canonicalMessage: "correctness:confirm", patternVersion: "v1", status: "active" });
    await db.insert(schema.findings).values({ id: findingId, reviewId: null, repo: "owner/confirm", prId: "1", commitSha: "abc", filePath: "src/a.ts", lineStart: 1, lineEnd: 1, category: "correctness", patternId, severity: "error", message: "race", messageHash: "h", status: "posted" });
    await db.insert(schema.findingOutcomes).values({ findingId, status: "dismissed", dismissalReason: "fp" });

    const out = await runCommand(deps, parseArgs(["confirm-dismissal", "owner/confirm", "--finding", findingId, "--by", "sam"]));
    expect(out).toContain("confirmed");
    const confirmedEvents = await db.select().from(learningEvents).where(eq(learningEvents.eventType, "finding.dismissal_confirmed"));
    expect(confirmedEvents.length).toBeGreaterThan(0);

    // Idempotent: confirming again writes no second event (fixed event key).
    await runCommand(deps, parseArgs(["confirm-dismissal", "owner/confirm", "--finding", findingId, "--by", "sam"]));
    const after = await db.select().from(learningEvents).where(eq(learningEvents.eventType, "finding.dismissal_confirmed"));
    expect(after).toHaveLength(confirmedEvents.length);

    // Only dismissed errors can be confirmed.
    const resolvedId = randomUUID();
    await db.insert(schema.findings).values({ id: resolvedId, reviewId: null, repo: "owner/confirm", prId: "2", commitSha: "b", filePath: "src/b.ts", lineStart: 1, lineEnd: 1, category: "correctness", patternId, severity: "error", message: "done", messageHash: "h2", status: "posted" });
    await db.insert(schema.findingOutcomes).values({ findingId: resolvedId, status: "resolved" });
    await expect(runCommand(deps, parseArgs(["confirm-dismissal", "owner/confirm", "--finding", resolvedId]))).rejects.toThrow(/dismissed error/);
  });
});
