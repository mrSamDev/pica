# Phase 7 — Embeddings (conditional)

**Goal**: Add semantic retrieval **only if** a retrieval problem is demonstrated — never because "AI projects need vectors."

**Prerequisites**: Phase 5. **Gate**: a demonstrated retrieval problem where taxonomy matching fails.

**Scope — in**: pgvector, semantic retrieval with embeddings, semantic-vs-taxonomy eval.

**Scope — out**: everything else. No `console.log` in src.

## Files / modules to create

- `src/learning/retrieval/` — semantic retrieval tier (V2, §5.10)
- `src/db/` — pgvector extension + vector column
- `src/eval/` — semantic vs taxonomy comparison

## TDD test list (red → green)

1. `retrieval problem demonstrated first` — a case where two phrasings should be related but taxonomy matching misses it (§5.10).
2. `semantic retrieval finds related phrasings` — embeddings match the demonstrated case.
3. `semantic recall beats taxonomy matching` — eval harness comparison (§13 Phase 7).
4. `pgvector deferred until problem exists` — no vector code before the gate.

## Exit criteria (§13 Phase 7)

- Semantic recall beats taxonomy matching.

## Definition of done

- [ ] Retrieval problem documented (the case that motivated it)
- [ ] Semantic-vs-taxonomy eval shows semantic wins
- [ ] No pgvector installed before the gate
