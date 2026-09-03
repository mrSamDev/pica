# Retrieval problem — the Phase 7 gate

Phase 7 (embeddings) is conditional: semantic retrieval was added only after a
retrieval problem was demonstrated in code, never because "AI projects need
vectors." This file records that problem. See also
`test/retrieval-problem.test.ts`, which is the deterministic gate the rest of
the phase builds on.

## The demonstrated case

The same defect appears on two reviews, phrased near-identically, but the LLM
emits a different `pattern_id` each time:

- `security:jwt-expiration` — "JWT expiration isn't validated; a rejected token
  still passes."
- `security:jwt-expiry-validation` — "JWT expiry isn't validated; a rejected
  token still passes."

The `pattern_id` is LLM-authored free text (§5.4) with no shared key to anchor
on, so the same issue legitimately fragments into two canonical patterns.

## Why taxonomy matching fails

V1 retrieval groups findings by exact `category:pattern_id`
(`src/learning/retrieval/retrieval.ts`). The two phrasings above get different
keys, so they land in separate buckets. The consequence is not missing
vocabulary — every content token overlaps but one — it is **evidence
fragmentation**: dismissals ("3 of the same pattern", §5.11) never pool toward
a confidence threshold on either side, so the learning loop never fires for an
issue the team clearly keeps seeing.

## What semantic retrieval adds

Near-duplicate phrasings share character n-grams, so an n-gram hashing
embedding (`src/learning/retrieval/embed.ts`) puts them close in vector space.
`findRelatedPatterns` (`src/learning/retrieval/semantic.ts`) then relates the
fragmented buckets that exact matching split, letting evidence pool across the
near-duplicate.

## Gate order (no pgvector before the problem)

1. `test/retrieval-problem.test.ts` proved the V1 miss against the existing
   taxonomy code — no vector involved.
2. Only then was `vector(256)` added to `patterns`
   (`src/db/schema.ts`, migration `drizzle/0005_pattern_embeddings.sql`) and the
   semantic tier built.

## Exit check

`test/eval-retrieval.test.ts` compares semantic vs taxonomy recall on the
corpus above and asserts semantic wins.
