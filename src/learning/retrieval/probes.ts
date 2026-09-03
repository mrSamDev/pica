import { posix } from "node:path";

import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../../db/client.ts";
import { findings, repoRules } from "../../db/schema.ts";
import type { Finding } from "../../review/types.ts";

// §5.7 ε-probing, read-model side. Self-suppression makes rules unfalsifiable:
// once a rule stops a pattern being flagged, no new evidence about the pattern
// ever arrives. Probing re-flags a suppressed pattern in a glob context the
// rule hasn't seen (a new directory), so evidence keeps flowing — bounded by a
// rate limit of one probe per pattern per window.

// The rate limit is enforced by atomically claiming the suppressing rule's
// last_probed_at column. A single guarded UPDATE that claims the slot when it
// is unset or older than the window is safe under concurrent reviews — exactly
// one worker can win the claim, so the "one probe per pattern per window"
// invariant holds even when reviews race.
export interface ProbeOptions {
  probeIntervalDays: number;
}

// Glob context for a finding is its directory prefix. Sufficient discrimination
// without inventing a glob syntax; a rule "hasn't seen" a context when no prior
// finding for the pattern lives under that directory.
export function probeContextOf(filePath: string): string {
  return posix.dirname(filePath);
}

// Decide which suppressed findings to promote into probes. At most one probe
// per pattern per run, only in a new glob context, and the rate-limit claim is
// atomic (§5.7). Claiming the slot on a candidate that later fails to post is
// conservative-safe: it never over-probes, it just skips a retry.
export async function selectProbeCandidates(db: Db, options: ProbeOptions, now: Date, suppressed: Finding[]): Promise<Finding[]> {
  const since = new Date(now.getTime() - options.probeIntervalDays * 24 * 60 * 60 * 1000);
  const candidates: Finding[] = [];
  const claimedPatterns = new Set<string>();
  for (const finding of suppressed) {
    if (claimedPatterns.has(finding.patternUuid)) continue;
    if (await seenInContext(db, finding)) continue;
    if (!(await claimProbeSlot(db, finding.patternUuid, since, now))) continue;
    claimedPatterns.add(finding.patternUuid);
    candidates.push(finding);
  }
  return candidates;
}

async function seenInContext(db: Db, finding: Finding): Promise<boolean> {
  const prefix = `${escapeLike(probeContextOf(finding.filePath))}/%`;
  const rows = await db
    .select({ id: findings.id })
    .from(findings)
    .where(and(eq(findings.patternId, finding.patternUuid), sql`${findings.filePath} like ${prefix}`))
    .limit(1);
  return rows.length > 0;
}

// Atomic rate-limit claim. True when this caller won the slot (either the rule
// has never been probed, or its last probe is older than the window).
async function claimProbeSlot(db: Db, patternId: string, since: Date, now: Date): Promise<boolean> {
  const claimed = await db
    .update(repoRules)
    .set({ lastProbedAt: now })
    .where(and(eq(repoRules.patternId, patternId), sql`${repoRules.lastProbedAt} is null or ${repoRules.lastProbedAt} < ${since}`));
  return Boolean(claimed.rowCount && claimed.rowCount > 0);
}

// Postgres LIKE treats backslash as the default escape character; escape the
// user-supplied path so `_` and `%` in a real directory name can't broaden the
// match into a probe leak.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
