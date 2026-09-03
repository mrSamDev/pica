import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Command } from "./args.ts";
import { renderDryRun, renderExplanation, renderReplay, renderRuleList, renderWeeklyReport } from "./render.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { findings, findingOutcomes } from "../db/schema.ts";
import { emitEvent } from "../learning/events/emit.ts";
import { runReplay, type ReplayCase } from "../eval/replay.ts";
import { explainRule, listRulesForRepo } from "../learning/explain.ts";
import { addManualRule, resolveRuleId, retireManualRule } from "../learning/rules/manual.ts";
import { weeklyReport } from "../learning/report.ts";
import { getReviewLearningContext } from "../learning/retrieval/retrieval.ts";
import { rebuildReadModel } from "../learning/retrieval/rebuild.ts";
import type { LLMClient } from "../llm/client.ts";
import type { Metrics } from "../observability/metrics.ts";
import type { PlatformClient } from "../platform/types.ts";
import { runReview } from "../review/pipeline/pipeline.ts";

export interface CliDeps {
  db: Db;
  platform: PlatformClient;
  llm: LLMClient;
  config: Readonly<Config>;
  metrics: Metrics;
  now(): Date;
}

export async function runCommand(deps: CliDeps, command: Command): Promise<string> {
  switch (command.name) {
    case "review":
      return runDryRunReview(deps, command);
    case "explain-rule":
      return runExplainRule(deps, command);
    case "rule-add":
      return runRuleAdd(deps, command);
    case "rule-retire":
      return runRuleRetire(deps, command);
    case "eval":
      return runEval(deps, command);
    case "report":
      return weeklyReport(deps.db, deps.now(), command.repo).then(renderWeeklyReport);
    case "confirm-dismissal":
      return confirmDismissal(deps.db, command);
    case "rebuild-read-model": {
      const result = await rebuildReadModel(deps.db);
      return `Rebuilt ${result.rules} rules from ${result.events} events.`;
    }
  }
}

// §5.5 human routing: the CLI emits a finding.dismissal_confirmed event that
// lets a dismissed error count as learning evidence. Idempotent — confirming
// twice writes one event (onConflictDoNothing on a fixed key).
async function confirmDismissal(db: Db, command: Extract<Command, { name: "confirm-dismissal" }>): Promise<string> {
  const rows = await db
    .select({ findingId: findings.id, outcome: findingOutcomes.status, severity: findings.severity })
    .from(findings)
    .innerJoin(findingOutcomes, eq(findingOutcomes.findingId, findings.id))
    .where(and(eq(findings.id, command.findingId), eq(findings.repo, command.repo)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`finding ${command.findingId} not found in ${command.repo}`);
  }
  if (row.outcome !== "dismissed" || row.severity !== "error") {
    throw new Error("only a dismissed error finding can be routed for confirmation");
  }
  await emitEvent(db, {
    eventKey: `finding:${command.findingId}:dismissal_confirmed`,
    repo: command.repo,
    eventType: "finding.dismissal_confirmed",
    aggregateId: `finding:${command.findingId}`,
    payload: { findingId: command.findingId, confirmedBy: command.confirmedBy },
  });
  return `Dismissal of ${command.findingId} confirmed by ${command.confirmedBy} — it now counts as learning evidence.`;
}

async function runDryRunReview(deps: CliDeps, command: Extract<Command, { name: "review" }>): Promise<string> {
  // §11: dry-run prints findings + the learning context without writing or
  // posting anything.
  const context = await getReviewLearningContext(deps.db, command.repo);
  const result = await runReview(deps, {
    reviewId: randomUUID(),
    repo: command.repo,
    prId: command.prId,
    commitSha: "dry-run",
    diffHref: command.diffHref,
    platform: deps.config.PLATFORM,
    mode: "dry-run",
    postingCap: 0,
    summaryComment: false,
  });
  return renderDryRun(command.prId, result.findings, context);
}

async function runExplainRule(deps: CliDeps, command: Extract<Command, { name: "explain-rule" }>): Promise<string> {
  if (command.ruleId === undefined && command.patternId === undefined) {
    return renderRuleList(await listRulesForRepo(deps.db, command.repo));
  }
  const ruleId = command.ruleId ?? (await resolveRuleId(deps.db, command.repo, { patternId: command.patternId }));
  if (ruleId === null) {
    throw new Error(`no rule found in ${command.repo}`);
  }
  const explanation = await explainRule(deps.db, command.repo, ruleId);
  if (explanation === null) {
    throw new Error(`rule ${ruleId} not found in ${command.repo}`);
  }
  return renderExplanation(explanation);
}

async function runRuleAdd(deps: CliDeps, command: Extract<Command, { name: "rule-add" }>): Promise<string> {
  const result = await addManualRule(deps.db, { repo: command.repo, ruleType: command.ruleType, glob: command.glob, payload: command.payload });
  const scope = command.glob ?? Object.values(command.payload)[0] ?? command.ruleType;
  switch (result.outcome) {
    case "created":
      return `Rule ${result.ruleId} created: ${command.ruleType} ${scope}`;
    case "updated":
      return `Rule ${result.ruleId} updated: ${command.ruleType} ${scope}`;
    case "unchanged":
      return `Rule ${result.ruleId} already set: ${command.ruleType} ${scope}`;
    case "noop-retired":
      return `Rule ${result.ruleId} is retired — re-adding is a no-op (retire is terminal).`;
  }
}

async function runRuleRetire(deps: CliDeps, command: Extract<Command, { name: "rule-retire" }>): Promise<string> {
  const ruleId = command.ruleId ?? (await resolveRuleId(deps.db, command.repo, { patternId: command.patternId, glob: command.glob }));
  if (ruleId === null) {
    throw new Error(`no matching rule found in ${command.repo}`);
  }
  const result = await retireManualRule(deps.db, { repo: command.repo, ruleId, retiredBy: command.retiredBy });
  return result.outcome === "retired" ? `Rule ${result.ruleId} retired.` : `Rule ${result.ruleId} was already retired.`;
}

// CLI inputs are operator-chosen files: parse at this boundary, fail fast on
// anything that isn't the documented shape.
const evalCasesSchema = z.array(z.object({ repo: z.string(), prId: z.string(), diff: z.string() })).min(1);
const goldenSchema = z.record(z.string(), z.array(z.object({ filePath: z.string(), lineStart: z.number(), lineEnd: z.number(), category: z.string(), message: z.string() })));

async function runEval(deps: CliDeps, command: Extract<Command, { name: "eval" }>): Promise<string> {
  const caseFile = evalCasesSchema.parse(JSON.parse(readFileSync(command.casesPath, "utf8")));
  const goldenFile = goldenSchema.parse(JSON.parse(readFileSync(command.goldenPath, "utf8")));

  const rulesByRepo = new Map<string, { rulesText: string; memoryContext: string }>();
  for (const c of caseFile) {
    if (!rulesByRepo.has(c.repo)) {
      rulesByRepo.set(c.repo, await getReviewLearningContext(deps.db, c.repo));
    }
  }

  // Every replayed PR must have a golden entry (possibly empty): a typo'd PR
  // id would otherwise score as perfect recall against no evidence.
  for (const c of caseFile) {
    if (!(c.prId in goldenFile)) {
      throw new Error(`golden file is missing an entry for PR ${c.prId}`);
    }
  }

  const cases: ReplayCase[] = caseFile.map((c) => {
    const context = rulesByRepo.get(c.repo);
    return {
      repo: c.repo,
      prId: c.prId,
      diff: c.diff,
      golden: goldenFile[c.prId] ?? [],
      rulesText: context?.rulesText,
      memoryContext: context?.memoryContext,
    };
  });

  return renderReplay(await runReplay({ llm: deps.llm }, cases));
}
