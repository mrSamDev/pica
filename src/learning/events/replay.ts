// §5.9 rebuildable read model: a pure, order-independent fold over the
// immutable learning_events log. The fold is commutative by construction:
//
//   - snapshots per ruleId resolve by max (lastObservedAt, payloadHash)
//   - rule.manual_retired is an always-wins overlay (no resurrection this phase)
//   - pattern.merged edges resolve to the final survivor before projection,
//     so merge events apply no matter where they appear in the log
//
// Shuffling the input events must converge to the same rules — that property
// is what makes a rebuild from the log trustworthy.

import { z } from "zod";

import { isRuleSnapshot, type EvidencePair, type RuleSnapshot } from "./snapshot.ts";

export interface EventInput {
  eventType: string;
  aggregateId: string;
  repo: string;
  payload: unknown;
}

// A repo_rules row rebuilt from the log. Dates parsed back from ISO strings;
// confidence numeric. `patternId` is already merge-resolved.
export interface ReplayedRule {
  ruleId: string;
  repo: string;
  ruleType: string;
  patternId: string | null;
  glob: string | null;
  payload: unknown;
  payloadHash: string;
  status: string;
  confidence: number | null;
  evidenceCount: number;
  positiveCount: number;
  negativeCount: number;
  firstObservedAt: Date;
  lastObservedAt: Date;
  createdAt: Date;
  createdBy: string;
  deactivatedAt: Date | null;
}

export interface FoldResult {
  rules: ReplayedRule[];
  evidenceByRule: Map<string, EvidencePair[]>;
}

interface RetireMarker {
  ruleId: string;
  retiredAt: string;
}

interface DecayMarker {
  ruleId: string;
  decayedAt: string;
}

const SNAPSHOT_EVENT_TYPES = new Set(["rule.updated", "rule.manual_added"]);

// Payload contracts for the marker events the fold consumes. Parsed at the
// boundary — the log is external input to a rebuild.
const mergePayloadSchema = z.object({ mergedInto: z.string() });
const retireMarkerSchema = z.object({ ruleId: z.string(), retiredBy: z.string().optional(), reason: z.string().nullable().optional(), retiredAt: z.iso.datetime() });
const decayMarkerSchema = z.object({ ruleId: z.string(), decayedAt: z.iso.datetime(), priorConfidence: z.number().nullable().optional() });

function resolveMerges(mergeEvents: EventInput[]): Map<string, string> {
  const direct = new Map<string, string>();
  for (const event of mergeEvents) {
    // SAFETY: mergePatterns emits aggregateId `pattern:{uuid}` with payload
    // { mergedInto }; a foreign shape is log corruption, not a rebuild input.
    const from = event.aggregateId.replace(/^pattern:/, "");
    const into = mergePayloadSchema.parse(event.payload).mergedInto;
    const previous = direct.get(from);
    if (previous !== undefined && previous !== into) {
      // The event key `pattern:{from}:merged` makes duplicate merges for one
      // pattern impossible in a healthy log; conflicting edges are corruption.
      throw new Error(`conflicting merges for pattern ${from}: ${previous} and ${into}`);
    }
    direct.set(from, into);
  }

  const resolved = new Map<string, string>();
  for (const from of direct.keys()) {
    let current = from;
    const visited = new Set<string>([from]);
    while (direct.has(current)) {
      current = direct.get(current)!;
      if (visited.has(current)) {
        throw new Error(`merge cycle detected at pattern ${current}`);
      }
      visited.add(current);
    }
    resolved.set(from, current);
  }
  return resolved;
}

function winsSnapshot(current: RuleSnapshot, candidate: RuleSnapshot): boolean {
  // Lexicographic max on (lastObservedAt, payloadHash): order-independent.
  if (candidate.lastObservedAt !== current.lastObservedAt) {
    return candidate.lastObservedAt > current.lastObservedAt;
  }
  return candidate.payloadHash > current.payloadHash;
}

function toRule(snapshot: RuleSnapshot, mergeMap: Map<string, string>, retire: RetireMarker | undefined, decay: DecayMarker | undefined): ReplayedRule {
  const mappedPatternId = snapshot.patternId === null ? null : (mergeMap.get(snapshot.patternId) ?? snapshot.patternId);
  // A manual retire is always terminal (an operator explicitly decided). A
  // decayed rule stays retired only while no newer snapshot supersedes it — a
  // rule that was re-learned carries a newer lastObservedAt than its decay
  // marker, so it comes back active in the rebuild exactly as it did live.
  const decayed = decay !== undefined && decay.decayedAt >= snapshot.lastObservedAt;
  const isRetired = retire !== undefined || decayed;
  return {
    ruleId: snapshot.ruleId,
    repo: snapshot.repo,
    ruleType: snapshot.ruleType,
    patternId: mappedPatternId,
    glob: snapshot.glob,
    payload: snapshot.payload,
    payloadHash: snapshot.payloadHash,
    status: isRetired ? "retired" : snapshot.status,
    confidence: snapshot.confidence,
    evidenceCount: snapshot.evidenceCount,
    positiveCount: snapshot.positiveCount,
    negativeCount: snapshot.negativeCount,
    firstObservedAt: new Date(snapshot.firstObservedAt),
    lastObservedAt: new Date(snapshot.lastObservedAt),
    createdAt: new Date(snapshot.createdAt),
    createdBy: snapshot.createdBy,
    deactivatedAt: isRetired ? new Date((retire?.retiredAt ?? decay?.decayedAt)!) : null,
  };
}

// Two rules may land on one (repo, ruleType, patternId) after merge mapping.
// Live behavior (mergePatterns) keeps the survivor's native rule and drops the
// loser's; when no native rule exists it keeps exactly one re-pointed rule.
// The fold mirrors that: prefer native, else the max (createdAt, ruleId).
// Deterministic under any event ordering.
function dropMergeCollisions(rules: ReplayedRule[], nativePatternIds: Map<string, string>): ReplayedRule[] {
  const byKey = new Map<string, ReplayedRule[]>();
  for (const rule of rules) {
    if (rule.patternId === null) continue; // manual rules: live unique index ignores NULL patternIds
    const key = `${rule.repo}|${rule.ruleType}|${rule.patternId}`;
    byKey.set(key, [...(byKey.get(key) ?? []), rule]);
  }

  const dropped = new Set<string>();
  for (const group of byKey.values()) {
    if (group.length <= 1) continue;
    const natives = group.filter((r) => nativePatternIds.get(r.ruleId) === r.patternId);
    const pool = natives.length > 0 ? natives : group;
    const keeper = pool.reduce((best, r) => ((r.createdAt > best.createdAt ? true : r.createdAt === best.createdAt && r.ruleId > best.ruleId) ? r : best), pool[0]!);
    for (const rule of group) {
      if (rule.ruleId !== keeper.ruleId) dropped.add(rule.ruleId);
    }
  }
  return rules.filter((r) => !dropped.has(r.ruleId));
}

export function projectEvents(events: EventInput[]): FoldResult {
  const mergeEvents = events.filter((e) => e.eventType === "pattern.merged");
  const mergeMap = resolveMerges(mergeEvents);

  const snapshots = new Map<string, RuleSnapshot>();
  const retires = new Map<string, RetireMarker>();
  const decays = new Map<string, DecayMarker>();
  const nativePatternIds = new Map<string, string>();

  for (const event of events) {
    if (SNAPSHOT_EVENT_TYPES.has(event.eventType)) {
      if (!isRuleSnapshot(event.payload)) {
        throw new Error(`invalid rule snapshot payload in ${event.eventType} event for ${event.aggregateId}`);
      }
      const snapshot = event.payload;
      const current = snapshots.get(snapshot.ruleId);
      if (current === undefined || winsSnapshot(current, snapshot)) {
        snapshots.set(snapshot.ruleId, snapshot);
        nativePatternIds.set(snapshot.ruleId, snapshot.patternId ?? "");
      }
    } else if (event.eventType === "rule.manual_retired") {
      const marker = retireMarkerSchema.parse(event.payload);
      retires.set(marker.ruleId, { ruleId: marker.ruleId, retiredAt: marker.retiredAt });
    } else if (event.eventType === "rule.decayed") {
      // A rule can be decayed, re-learned, and decayed again; resolve to the
      // latest decay deterministically so a shuffled replay converges.
      const marker = decayMarkerSchema.parse(event.payload);
      const previous = decays.get(marker.ruleId);
      if (previous === undefined || marker.decayedAt > previous.decayedAt) {
        decays.set(marker.ruleId, { ruleId: marker.ruleId, decayedAt: marker.decayedAt });
      }
    }
  }

  const mapped = [...snapshots.values()].map((s) => toRule(s, mergeMap, retires.get(s.ruleId), decays.get(s.ruleId)));
  const rules = dropMergeCollisions(mapped, nativePatternIds).sort((a, b) => a.ruleId.localeCompare(b.ruleId));

  const evidenceByRule = new Map<string, EvidencePair[]>();
  for (const rule of rules) {
    evidenceByRule.set(rule.ruleId, snapshots.get(rule.ruleId)?.evidence ?? []);
  }
  return { rules, evidenceByRule };
}
