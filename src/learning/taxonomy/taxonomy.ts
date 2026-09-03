// §5.4 Classify findings into a canonical taxonomy. The LLM emits a stable
// `pattern_id` per finding; this module normalizes that into a canonical pair
// and tags it with a version. Free-text string normalization is NOT the load
// bearing wall — the structured pattern_id is — so unrecognized categories pass
// through as the documented residual rather than being coerced into a bucket.

export const PATTERN_VERSION = "v1";

// Canonical issue categories. Grows as the taxonomy evolves; re-normalizing a
// finding's stored raw message when this changes is a patterns concern.
export const CATEGORIES = ["security", "correctness", "performance", "concurrency", "style", "data", "resilience"] as const;

export type Category = (typeof CATEGORIES)[number];

export interface ClassifiedPattern {
  category: string;
  patternId: string;
}

// The taxonomy lives at the category level; the pattern key is fine-grained
// and LLM-authored (e.g. "security:jwt-expiration"). We normalize only enough
// to keep the key stable across runs — case, spacing — never rewrite meaning.
export function classify(category: string, patternId: string): ClassifiedPattern {
  const normalizedCategory = category.trim().toLowerCase();
  const normalizedId = normalizePatternId(patternId);
  return { category: normalizedCategory, patternId: normalizedId };
}

function normalizePatternId(patternId: string): string {
  const id = patternId.trim().toLowerCase().replace(/\s+/g, "-");
  if (id.length === 0) {
    throw new Error("patternId must not be empty");
  }
  return id;
}
