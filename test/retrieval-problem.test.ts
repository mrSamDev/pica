import { describe, expect, it } from "vitest";

import { classify } from "../src/learning/taxonomy/taxonomy.ts";

// Phase 7 — the gate (§5.10, §13). Embeddings exist only because a retrieval
// problem is demonstrated here first. This file exercises ONLY the V1 taxonomy
// path (`classify`), never the semantic tier, so the problem is provable
// without a single vector. That property is the "no pgvector before the gate"
// contract: the gate is a failing V1, not an installed extension.

// The demonstrated case: the same defect surfaced on two reviews, phrased near-
// identically, but the LLM emitted different pattern_ids each time (no shared
// key to anchor on — the taxonomy id is free-text, per §5.4). Exact taxonomy
// matching groups by pattern_id, so the near-duplicate pair lands in two
// buckets and their dismissal evidence never pools toward §5.11's "3
// dismissals" threshold. Evidence fragmentation, not missing vocabulary, is
// the motivating retrieval problem.

const pair = [
  { category: "security", patternId: "jwt-expiration", message: "JWT expiration isn't validated; a rejected token still passes." },
  { category: "security", patternId: "jwt-expiry-validation", message: "JWT expiry isn't validated; a rejected token still passes." },
] as const;

describe("retrieval gate: V1 taxonomy misses a near-duplicate pair", () => {
  it("the pair is the same underlying defect expressed two ways", () => {
    // Near-identical wording — only "expiration" vs "expiry" differs. The
    // messages share every content token but one, so any surface-overlap
    // similarity (n-gram based) sees them as the same issue.
    const words = (m: string) =>
      new Set(
        m
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .split(" ")
          .filter(Boolean),
      );
    const [a, b] = pair;
    const shared = [...words(a.message)].filter((w) => words(b.message).has(w));
    const unique = new Set([...words(a.message), ...words(b.message)].filter((w) => !shared.includes(w)));
    expect(shared.length).toBeGreaterThan(unique.size);
  });

  it("V1 classify assigns them different canonical keys (exact match misses)", () => {
    const [a, b] = pair;
    const ca = classify(a.category, a.patternId);
    const cb = classify(b.category, b.patternId);

    // Each finding gets its own pattern_id...
    expect(ca.patternId).toBe("jwt-expiration");
    expect(cb.patternId).toBe("jwt-expiry-validation");
    // ...so exact-match retrieval buckets them apart: the memory context keys
    // off category:pattern_id and never unites them.
    const keyA = `${ca.category}:${ca.patternId}`;
    const keyB = `${cb.category}:${cb.patternId}`;
    expect(keyA).not.toBe(keyB);
    // Consequence: §5.11 evidence threshold is never reached on either side.
  });
});
