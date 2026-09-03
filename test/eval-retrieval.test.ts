import { describe, expect, it } from "vitest";

import { cosineSimilarity, embed, EMBED_DIM } from "../src/learning/retrieval/embed.ts";
import { V2_THRESHOLD } from "../src/learning/retrieval/semantic.ts";
import { compareRetrieval, type CorpusPhrase } from "../src/eval/retrieval-eval.ts";

// §13 Phase 7 exit criterion: semantic recall beats taxonomy matching. The
// corpus mirrors docs/retrieval-problem.md — same-issue phrasings the LLM gave
// different pattern_ids, plus unrelated negatives so the win is not tautological.
const corpus: CorpusPhrase[] = [
  { message: "JWT expiration isn't validated; a rejected token still passes.", patternId: "jwt-expiration" },
  { message: "JWT expiry isn't validated; a rejected token still passes.", patternId: "jwt-expiry-validation" },
  { message: "N+1 query in the order listing; each row fires a separate query.", patternId: "n-plus-1" },
  { message: "N+1 query in the order list; every row triggers its own query.", patternId: "n-plus-one-queries" },
  { message: "Hardcoded signing secret in source; move to env config.", patternId: "hardcoded-secret" },
  { message: "Hardcoded JWT signing key in source; move to env.", patternId: "hardcoded-secret-in-source" },
  // Unrelated negative: shares no vocabulary with any cluster.
  { message: "Check-then-act race on inventory count; read and decrement should be atomic.", patternId: "check-then-act" },
];

// Same-issue pairs; each sibling got a different pattern_id (the fragmentation
// that motivates semantic retrieval). Indices reference the corpus array.
const goldenPairs: Array<[number, number]> = [
  [0, 1],
  [2, 3],
  [4, 5],
];

describe("Phase 7 exit: semantic recall beats taxonomy", () => {
  it("semantic recall beats taxonomy matching on the demonstrated corpus", () => {
    const { taxonomyRecall, semanticRecall } = compareRetrieval(corpus, goldenPairs);
    // Taxonomy: every pair differs on pattern_id, so exact match retrieves none.
    expect(taxonomyRecall).toBe(0);
    // Semantic: all three pairs are near-duplicates within threshold.
    expect(semanticRecall).toBe(1);
    expect(semanticRecall).toBeGreaterThan(taxonomyRecall);
  });

  it("the win is not tautological: unrelated phrases stay below threshold", () => {
    const vectors = corpus.map((p) => embed(p.message));
    // Unrelated pairs must fall below the retrieval threshold.
    for (const [i, j] of [
      [0, 2],
      [0, 4],
      [2, 4],
      [0, 6],
      [4, 6],
    ] as const) {
      const similarity = cosineSimilarity(vectors[i] ?? [], vectors[j] ?? []);
      expect(similarity).toBeLessThan(V2_THRESHOLD);
    }
  });

  it("embed is deterministic and dimension-stable", () => {
    const message = "JWT expiration isn't validated; a rejected token still passes.";
    expect(embed(message)).toEqual(embed(message));
    expect(embed(message)).toHaveLength(EMBED_DIM);
    expect(cosineSimilarity(embed(message), embed(message))).toBeCloseTo(1);
  });
});
