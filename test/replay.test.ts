import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { buildRuleSnapshot, type RuleSnapshot } from "../src/learning/events/snapshot.ts";
import { projectEvents, type EventInput } from "../src/learning/events/replay.ts";

const repo = "owner/repo";

function snapshotEvent(snapshot: RuleSnapshot): EventInput {
  return { eventType: "rule.updated", aggregateId: `pattern:${snapshot.patternId}`, repo, payload: snapshot };
}

function baseSnapshot(overrides: Partial<RuleSnapshot> = {}): RuleSnapshot {
  const now = new Date("2026-09-01T00:00:00Z").toISOString();
  return {
    ruleId: randomUUID(),
    repo,
    ruleType: "ignore",
    patternId: randomUUID(),
    glob: null,
    payload: { patternKey: "security:noisy", reason: "noisy" },
    payloadHash: "h1",
    status: "candidate",
    confidence: 0.5,
    evidenceCount: 3,
    positiveCount: 0,
    negativeCount: 3,
    firstObservedAt: now,
    lastObservedAt: now,
    createdAt: now,
    createdBy: "auto:learning",
    evidence: [{ findingId: randomUUID(), outcome: "dismissed" }],
    ...overrides,
  };
}

function shuffled<T>(items: T[], seed: number): T[] {
  // Deterministic shuffle so a failing test reproduces.
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("event log fold (§5.9: order-independent projection)", () => {
  it("converges under shuffled orderings: latest snapshot wins for a rule", () => {
    const older = baseSnapshot({ status: "candidate", confidence: 0.5, lastObservedAt: "2026-09-01T00:00:00Z" });
    const newer = baseSnapshot({ ruleId: older.ruleId, status: "active", confidence: 0.8, lastObservedAt: "2026-09-02T00:00:00Z" });
    const events = [snapshotEvent(older), snapshotEvent(newer)];

    const results = [1, 2, 3, 4, 5].map((seed) => projectEvents(shuffled(events, seed)).rules);
    for (const result of results) {
      expect(result).toHaveLength(1);
      expect(result[0]?.status).toBe("active");
      expect(result[0]?.confidence).toBe(0.8);
    }
  });

  it("rule.manual_retired always wins, regardless of order", () => {
    const snapshot = baseSnapshot({ status: "active" });
    const retire: EventInput = { eventType: "rule.manual_retired", aggregateId: `rule:${snapshot.ruleId}`, repo, payload: { ruleId: snapshot.ruleId, retiredBy: "sam", retiredAt: "2026-09-03T00:00:00Z" } };
    const events = [snapshotEvent(snapshot), retire];

    const results = [projectEvents(events), projectEvents([retire, snapshotEvent(snapshot)])];
    for (const result of results) {
      expect(result.rules).toHaveLength(1);
      expect(result.rules[0]?.status).toBe("retired");
      expect(result.rules[0]?.deactivatedAt?.toISOString()).toBe("2026-09-03T00:00:00.000Z");
    }
  });

  it("rule.manual_added snapshots participate like learner snapshots", () => {
    const snapshot = baseSnapshot({ ruleId: randomUUID(), ruleType: "ignore", patternId: null, glob: "generated/**", status: "active", confidence: null, createdBy: "manual:cli", evidence: [] });
    const events: EventInput[] = [{ eventType: "rule.manual_added", aggregateId: `rule:${snapshot.ruleId}`, repo, payload: snapshot }];

    const result = projectEvents(shuffled(events, 7));
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.ruleId).toBe(snapshot.ruleId);
    expect(result.rules[0]?.glob).toBe("generated/**");
    expect(result.evidenceByRule.get(snapshot.ruleId)).toEqual([]);
  });

  it("pattern.merged re-points the loser's rule to the survivor (no native rule)", () => {
    const loser = baseSnapshot({ patternId: "11111111-1111-1111-1111-111111111111" });
    const merge: EventInput = { eventType: "pattern.merged", aggregateId: `pattern:11111111-1111-1111-1111-111111111111`, repo, payload: { mergedInto: "22222222-2222-2222-2222-222222222222" } };

    const result = projectEvents(shuffled([snapshotEvent(loser), merge], 3));
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.patternId).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("pattern.merged drops the loser's rule when the survivor has a same-type rule", () => {
    const loser = baseSnapshot({ patternId: "11111111-1111-1111-1111-111111111111", ruleId: randomUUID() });
    const survivor = baseSnapshot({ patternId: "22222222-2222-2222-2222-222222222222", ruleId: randomUUID() });
    const merge: EventInput = { eventType: "pattern.merged", aggregateId: `pattern:11111111-1111-1111-1111-111111111111`, repo, payload: { mergedInto: "22222222-2222-2222-2222-222222222222" } };

    const result = projectEvents(shuffled([snapshotEvent(loser), snapshotEvent(survivor), merge], 5));
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.ruleId).toBe(survivor.ruleId);
    expect(result.evidenceByRule.has(loser.ruleId)).toBe(false);
  });

  it("merge chains resolve transitively to the final survivor", () => {
    const ruleOnA = baseSnapshot({ patternId: "11111111-1111-1111-1111-111111111111" });
    const aIntoB: EventInput = { eventType: "pattern.merged", aggregateId: `pattern:11111111-1111-1111-1111-111111111111`, repo, payload: { mergedInto: "22222222-2222-2222-2222-222222222222" } };
    const bIntoC: EventInput = { eventType: "pattern.merged", aggregateId: `pattern:22222222-2222-2222-2222-222222222222`, repo, payload: { mergedInto: "33333333-3333-3333-3333-333333333333" } };

    const result = projectEvents(shuffled([snapshotEvent(ruleOnA), aIntoB, bIntoC], 11));
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.patternId).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("conflicting merge edges for the same loser are corruption: fail fast", () => {
    const aIntoB: EventInput = { eventType: "pattern.merged", aggregateId: `pattern:11111111-1111-1111-1111-111111111111`, repo, payload: { mergedInto: "22222222-2222-2222-2222-222222222222" } };
    const aIntoC: EventInput = { eventType: "pattern.merged", aggregateId: `pattern:11111111-1111-1111-1111-111111111111`, repo, payload: { mergedInto: "33333333-3333-3333-3333-333333333333" } };

    expect(() => projectEvents([aIntoB, aIntoC])).toThrow(/conflicting merges/);
    // Same edge twice is fine (idempotent replay of the same event).
    expect(() => projectEvents([aIntoB, aIntoB])).not.toThrow();
  });

  it("merge cycles are corruption: fail fast", () => {
    const aIntoB: EventInput = { eventType: "pattern.merged", aggregateId: `pattern:11111111-1111-1111-1111-111111111111`, repo, payload: { mergedInto: "22222222-2222-2222-2222-222222222222" } };
    const bIntoA: EventInput = { eventType: "pattern.merged", aggregateId: `pattern:22222222-2222-2222-2222-222222222222`, repo, payload: { mergedInto: "11111111-1111-1111-1111-111111111111" } };

    expect(() => projectEvents([aIntoB, bIntoA])).toThrow(/merge cycle/);
  });

  it("an orphan retire marker (rule dropped by a merge) is ignored", () => {
    const retire: EventInput = { eventType: "rule.manual_retired", aggregateId: `rule:${randomUUID()}`, repo, payload: { ruleId: randomUUID(), retiredBy: "sam", retiredAt: "2026-09-03T00:00:00Z" } };
    const result = projectEvents([retire]);
    expect(result.rules).toHaveLength(0);
  });

  it("non-rule events are ignored; rule.candidate/rule.activated markers carry no state", () => {
    const marker: EventInput = { eventType: "rule.activated", aggregateId: "pattern:abc", repo, payload: { ruleId: "r1" } };
    const outcome: EventInput = { eventType: "finding.outcome_changed", aggregateId: "finding:abc", repo, payload: { status: "dismissed" } };
    const review: EventInput = { eventType: "review.completed", aggregateId: "review:abc", repo, payload: {} };

    expect(projectEvents([marker, outcome, review]).rules).toHaveLength(0);
  });

  it("a malformed snapshot event fails fast", () => {
    const bad: EventInput = { eventType: "rule.updated", aggregateId: "pattern:abc", repo, payload: { ruleId: 42 } };
    expect(() => projectEvents([bad])).toThrow(/snapshot/);
  });

  it("evidence pairs round-trip from snapshots", () => {
    const findingId = randomUUID();
    const snapshot = baseSnapshot({ evidence: [{ findingId, outcome: "dismissed" }] });
    const result = projectEvents([snapshotEvent(snapshot)]);
    expect(result.evidenceByRule.get(snapshot.ruleId)).toEqual([{ findingId, outcome: "dismissed" }]);
  });

  it("buildRuleSnapshot output survives a fold (round-trip property)", () => {
    const row = {
      id: randomUUID(),
      repo,
      ruleType: "ignore",
      patternId: randomUUID(),
      glob: null,
      payload: { patternKey: "k", reason: "r" },
      payloadHash: "h",
      status: "active",
      confidence: "0.85",
      evidenceCount: 4,
      positiveCount: 1,
      negativeCount: 3,
      firstObservedAt: new Date("2026-08-01T00:00:00Z"),
      lastObservedAt: new Date("2026-09-01T00:00:00Z"),
      createdAt: new Date("2026-08-01T00:00:00Z"),
      createdBy: "auto:learning",
    };
    const snapshot = buildRuleSnapshot(row, [{ findingId: "f1", outcome: "dismissed" }]);
    const result = projectEvents([snapshotEvent(snapshot)]);
    const rule = result.rules[0];
    expect(rule?.confidence).toBe(0.85);
    expect(rule?.firstObservedAt?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(rule?.negativeCount).toBe(3);
  });
});
