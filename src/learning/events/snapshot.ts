import { createHash } from "node:crypto";
import { z } from "zod";

// §5.9: rule snapshots carried in events so the read model can rebuild from
// the log alone. Shared vocabulary between the emitter (learner, manual rule
// adders) and the consumer (events/replay.ts fold).

export interface EvidencePair {
  findingId: string;
  outcome: string;
}

// JSON-safe image of a repo_rules row plus its evidence pairs. Dates are ISO
// strings; confidence is a number (the DB column is numeric).
export const ruleSnapshotSchema = z.object({
  ruleId: z.string(),
  repo: z.string(),
  ruleType: z.string(),
  patternId: z.string().nullable(),
  glob: z.string().nullable(),
  payload: z.json(),
  payloadHash: z.string(),
  status: z.string(),
  confidence: z.number().nullable(),
  evidenceCount: z.number(),
  positiveCount: z.number(),
  negativeCount: z.number(),
  firstObservedAt: z.iso.datetime(),
  lastObservedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  createdBy: z.string(),
  evidence: z.array(z.object({ findingId: z.string(), outcome: z.string() })),
});

export type RuleSnapshot = z.infer<typeof ruleSnapshotSchema>;

export interface SnapshotRuleRow {
  id: string;
  repo: string;
  ruleType: string;
  patternId: string | null;
  glob: string | null;
  payload: unknown;
  payloadHash: string;
  status: string;
  confidence: string | number | null;
  evidenceCount: number | null;
  positiveCount: number | null;
  negativeCount: number | null;
  firstObservedAt: Date | null;
  lastObservedAt: Date | null;
  createdAt: Date | null;
  createdBy: string | null;
}

export function buildRuleSnapshot(rule: SnapshotRuleRow, evidence: EvidencePair[]): RuleSnapshot {
  return ruleSnapshotSchema.parse({
    ruleId: rule.id,
    repo: rule.repo,
    ruleType: rule.ruleType,
    patternId: rule.patternId,
    glob: rule.glob,
    payload: rule.payload,
    payloadHash: rule.payloadHash,
    status: rule.status,
    confidence: rule.confidence === null ? null : Number(rule.confidence),
    evidenceCount: rule.evidenceCount ?? 0,
    positiveCount: rule.positiveCount ?? 0,
    negativeCount: rule.negativeCount ?? 0,
    firstObservedAt: (rule.firstObservedAt ?? new Date(0)).toISOString(),
    lastObservedAt: (rule.lastObservedAt ?? new Date(0)).toISOString(),
    createdAt: (rule.createdAt ?? new Date(0)).toISOString(),
    createdBy: rule.createdBy ?? "",
    evidence: [...evidence].sort((a, b) => a.findingId.localeCompare(b.findingId)),
  });
}

// Canonical JSON serialization with sorted keys, so a hash is independent of
// key ordering in whatever built the object.
const jsonValueSchema = z.json();
type Json = z.infer<typeof jsonValueSchema>;

const primitiveSchema = z.union([z.string(), z.number(), z.boolean()]);

// Discriminate the Json union through schemas, not typeof checks: the branch
// follows the parsed domain value.
export function sortedStringify(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((v) => sortedStringify(v)).join(",")}]`;
  const primitive = primitiveSchema.safeParse(value);
  if (primitive.success) return JSON.stringify(primitive.data);
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedStringify(v)}`).join(",")}}`;
}

// Deterministic hash over a rule payload, independent of key order — used by
// manual rule adders (the learner hashes its own two fixed fields). The input
// is parsed here: jsonb payloads from the DB are external bytes.
export function canonicalPayloadHash(payload: Json): string {
  return createHash("sha256")
    .update(sortedStringify(jsonValueSchema.parse(payload)))
    .digest("hex");
}

// State hash excludes volatile timestamps (lastObservedAt, createdAt): a
// learner retry bumps lastObservedAt without changing state, and must not
// append a new event for it.
export function snapshotStateHash(snapshot: RuleSnapshot): string {
  const { lastObservedAt: _last, createdAt: _created, ...state } = snapshot;
  return sortedStringify(state);
}

// Type predicate: the event log is external input to the fold, so a snapshot
// is validated at the boundary, not trusted. A malformed snapshot is log
// corruption — the fold fails the rebuild loudly when this returns false.
export function isRuleSnapshot(payload: unknown): payload is RuleSnapshot {
  return ruleSnapshotSchema.safeParse(payload).success;
}
