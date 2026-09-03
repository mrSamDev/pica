import type { ExistingComment, Finding, PriorFinding } from "../types.ts";
import { isProtectedCategory } from "../../learning/learner/guardrails.ts";

export type DropReason = "suppressed" | "duplicate" | "repeat-human" | "cross-commit";

export interface PostFilterInput {
  prId: string;
  findings: Finding[];
  suppressedPatternIds: ReadonlySet<string>;
  protectedCategories: ReadonlySet<string>;
  existingComments: ExistingComment[];
  priorFindings: PriorFinding[];
}

export interface DroppedFinding {
  finding: Finding;
  reason: DropReason;
}

export interface PostFilterResult {
  findings: Finding[];
  dropped: DroppedFinding[];
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

function matchesExistingComment(finding: Finding, comment: ExistingComment): boolean {
  return finding.filePath === comment.filePath && rangesOverlap(finding.lineStart, finding.lineEnd, comment.lineStart, comment.lineEnd) && (finding.category === comment.category || finding.message === comment.message);
}

function matchesPriorFinding(finding: Finding, prior: PriorFinding): boolean {
  return finding.filePath === prior.filePath && finding.patternUuid === prior.patternUuid && rangesOverlap(finding.lineStart, finding.lineEnd, prior.lineStart, prior.lineEnd);
}

/**
 * Deterministic post-filter. Order matters: suppression first, then dedup by
 * (pr_id, pattern_id), then no-repeat-human, then cross-commit dedup.
 * §5.5 defense in depth: severity=error findings in protected categories are
 * exempt from suppression even if a rule matches — the learner guard is the
 * primary wall; this one covers rules formed before the guard existed.
 */
export function applyPostFilter(input: PostFilterInput): PostFilterResult {
  const dropped: DroppedFinding[] = [];
  const kept: Finding[] = [];
  const seenPatterns = new Set<string>();

  for (const finding of input.findings) {
    if (input.suppressedPatternIds.has(finding.patternUuid)) {
      const exempt = finding.severity === "error" && isProtectedCategory(finding.category, input.protectedCategories);
      if (!exempt) {
        dropped.push({ finding, reason: "suppressed" });
        continue;
      }
    }

    const dedupKey = `${input.prId}:${finding.patternUuid}`;
    if (seenPatterns.has(dedupKey)) {
      dropped.push({ finding, reason: "duplicate" });
      continue;
    }

    if (input.existingComments.some((comment) => matchesExistingComment(finding, comment))) {
      dropped.push({ finding, reason: "repeat-human" });
      continue;
    }

    if (input.priorFindings.some((prior) => matchesPriorFinding(finding, prior))) {
      dropped.push({ finding, reason: "cross-commit" });
      continue;
    }

    seenPatterns.add(dedupKey);
    kept.push(finding);
  }

  return { findings: kept, dropped };
}
