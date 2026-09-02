# Phase 1.5 — Observe-only rollout

**Goal**: Run the full pipeline in observe mode so would-be spam is measured before it's inflicted on the team.

**Prerequisites**: Phase 1.

**Scope — in**: mode config (`observe | post | dry-run`), findings recorded + counted but not posted, capped summary comment (max ~5, severity-prioritized), per-repo posting caps and mode config.

**Scope — out**: feedback collection, learning loop. No `console.log` in src.

## Files / modules to create

- `src/review/pipeline/` — mode gating in the post stage (§4)
- `src/config.ts` — per-repo mode + posting cap config

## TDD test list (red → green)

1. `observe mode records findings but does not post` — findings inserted, zero comments posted.
2. `observe mode emits capped summary` — max ~5 findings, severity-prioritized.
3. `post mode posts comments` — normal behavior.
4. `dry-run mode prints findings, posts nothing` — CLI path.
5. `per-repo posting cap enforced` — cap respected in post mode.
6. `summary respects severity priority` — errors before suggestions.

## Exit criteria (§13 Phase 1.5)

- Would-be spam measured before posting to the team.

## Definition of done

- [ ] Observe mode integration test green (findings recorded, no comments)
- [ ] Summary cap + severity priority tested
- [ ] Per-repo mode/cap config tested
