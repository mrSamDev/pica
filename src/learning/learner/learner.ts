import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import type { SeverityWeights } from "../../config.ts";
import type { Db } from "../../db/client.ts";
import { findings, findingOutcomes, learningEvents, patterns, repoRules } from "../../db/schema.ts";
import { fetchConfirmedDismissalIds, isProtectedCategory, requiresHumanConfirmation } from "./guardrails.ts";
import { persistRule } from "./persist.ts";

// §5.6 Rule learner: candidate -> confidence -> active.
// Confidence is a Beta(2,2) posterior mean, not a raw ratio:
//   confidence = (neg + 2) / (generated + 4)
// with a minimum-evidence gate. Both gate and threshold are config, injected
// here so tests can pin exact values.

export interface LearnerOptions {
  minEvidence: number;
  activationThreshold: number;
  severityWeights: SeverityWeights;
  protectedCategories: ReadonlySet<string>;
}

export function betaConfidence(negative: number, generated: number): number {
  return (negative + 2) / (generated + 4);
}

export function severityWeight(severity: string, weights: SeverityWeights): number {
  switch (severity) {
    case "error":
      return weights.error;
    case "warning":
      return weights.warning;
    case "suggestion":
      return weights.suggestion;
    default:
      return 1;
  }
}

export type RuleStage = "none" | "candidate" | "active" | "retired";

export interface EvidenceCounts {
  generated: number;
  negative: number;
  positive: number;
  latestReason?: string;
  confidence: number;
}

export function decideStage(counts: EvidenceCounts, options: LearnerOptions): RuleStage {
  if (counts.generated < options.minEvidence) {
    return "none";
  }
  return counts.confidence >= options.activationThreshold ? "active" : "candidate";
}

export interface LearnResult {
  ruleId: string | null;
  stage: RuleStage;
  // §5.5: true when rule formation was refused for a protected category.
  protectedBlocked?: boolean;
}

export interface LearnInput {
  findingId: string;
  repo: string;
}

// Re-derive a pattern's evidence from findings ⋈ outcomes and decide whether a
// suppression rule should be candidate or active. Idempotent: retries converge
// because counts are recomputed from the DB each run and rule writes upsert.
export async function runLearner(db: Db, input: LearnInput, options: LearnerOptions): Promise<LearnResult> {
  const finding = await db.select({ patternId: findings.patternId }).from(findings).where(eq(findings.id, input.findingId)).limit(1);
  const patternId = finding[0]?.patternId;
  if (!patternId) {
    return { ruleId: null, stage: "none" };
  }

  const pattern = await db.select({ canonicalMessage: patterns.canonicalMessage, category: patterns.category }).from(patterns).where(eq(patterns.id, patternId)).limit(1);

  // §5.5 protected categories: an auto-ignore rule suppresses a pattern
  // wholesale — every severity, every file. So one error-severity finding in
  // a protected category disqualifies the pattern from auto-suppression
  // entirely, regardless of outcome.
  if (isProtectedCategory(pattern[0]?.category ?? "", options.protectedCategories)) {
    const errorFinding = await db
      .select({ id: findings.id })
      .from(findings)
      .where(and(eq(findings.patternId, patternId), eq(findings.severity, "error")))
      .limit(1);
    if (errorFinding.length > 0) {
      return { ruleId: null, stage: "none", protectedBlocked: true };
    }
  }

  const evidenceRows = await db
    .select({ id: findings.id, severity: findings.severity, status: findingOutcomes.status, dismissalReason: findingOutcomes.dismissalReason, updatedAt: findingOutcomes.updatedAt })
    .from(findings)
    .innerJoin(findingOutcomes, eq(findingOutcomes.findingId, findings.id))
    .where(and(eq(findings.patternId, patternId), sql`${findingOutcomes.status} in ('resolved','dismissed')`));

  // §5.5 human routing: unconfirmed error dismissals are not evidence yet.
  const confirmedDismissalIds = await fetchConfirmedDismissalIds(
    db,
    evidenceRows.filter((row) => row.status === "dismissed" && requiresHumanConfirmation(row.severity)).map((row) => row.id),
  );

  const counts: EvidenceCounts = { generated: 0, negative: 0, positive: 0, confidence: 0 };
  let latestDismissalAt: number | null = null;
  for (const row of evidenceRows) {
    if (row.status === "dismissed" && requiresHumanConfirmation(row.severity) && !confirmedDismissalIds.has(row.id)) {
      continue;
    }
    const weight = severityWeight(row.severity, options.severityWeights);
    counts.generated += weight;
    if (row.status === "dismissed") {
      counts.negative += weight;
      const at = row.updatedAt ? row.updatedAt.getTime() : 0;
      if (at >= (latestDismissalAt ?? -1)) {
        latestDismissalAt = at;
        counts.latestReason = row.dismissalReason ?? undefined;
      }
    } else if (row.status === "resolved") {
      counts.positive += weight;
    }
  }
  counts.confidence = betaConfidence(counts.negative, counts.generated);

  const stage = decideStage(counts, options);
  if (stage === "none") {
    return { ruleId: null, stage };
  }

  const payload = { patternKey: pattern[0]?.canonicalMessage ?? "", reason: counts.latestReason };
  // Canonical hash over the fixed payload fields, concatenated in a stable
  // order so equal payloads always hash identically (snapshot.ts does the
  // same for its canonical JSON).
  const payloadHash = createHash("sha256")
    .update(`${payload.patternKey}|${payload.reason ?? ""}`)
    .digest("hex");
  const now = new Date();

  const existing = await db
    .select()
    .from(repoRules)
    .where(and(eq(repoRules.repo, input.repo), eq(repoRules.ruleType, "ignore"), eq(repoRules.patternId, patternId)))
    .limit(1);

  const ruleId = existing[0]?.id ?? null;
  const previousStatus = existing[0]?.status ?? null;

  // §5.7 resurrection: a decayed rule (no rule.manual_retired marker) falls
  // through so the loop can re-learn it; a manual retire stays terminal.
  if (previousStatus === "retired") {
    const manualRetire = await db
      .select({ id: learningEvents.id })
      .from(learningEvents)
      .where(and(eq(learningEvents.eventType, "rule.manual_retired"), eq(learningEvents.aggregateId, `rule:${existing[0]!.id}`)))
      .limit(1);
    if (manualRetire.length > 0) {
      await db.update(repoRules).set({ lastObservedAt: now }).where(eq(repoRules.id, existing[0]!.id));
      // SAFETY: a manually retired rule keeps its retired status; stage is
      // informational here.
      return { ruleId, stage: "retired" };
    }
  }

  const newStatus = previousStatus === "active" || stage === "active" ? ("active" as const) : ("candidate" as const);
  const statusChanged = previousStatus !== newStatus;

  // §5.9: every rule state change pairs with a rule.updated event carrying a
  // full snapshot, so the read model rebuilds from the log alone. A retry with
  // unchanged state (same counts, confidence, payload) writes nothing — no
  // row update, no event — keeping live rows and rebuilt snapshots in sync.
  const stateUnchanged =
    previousStatus !== null &&
    previousStatus === newStatus &&
    Number(existing[0]?.confidence) === counts.confidence &&
    (existing[0]?.evidenceCount ?? 0) === counts.generated &&
    (existing[0]?.positiveCount ?? 0) === counts.positive &&
    (existing[0]?.negativeCount ?? 0) === counts.negative &&
    existing[0]?.payloadHash === payloadHash;
  if (stateUnchanged) {
    // SAFETY: newStatus is "candidate" or "active" by construction above.
    return { ruleId, stage: newStatus as RuleStage };
  }

  // One transaction (see persist.ts): rule row + marker event + snapshot +
  // evidence links become visible together.
  return persistRule(db, {
    repo: input.repo,
    patternId,
    ruleId,
    stage,
    previousStatus,
    newStatus,
    statusChanged,
    payload,
    payloadHash,
    counts,
    evidenceRows,
    now,
  });
}
