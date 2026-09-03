# Phase 3 — Learning loop (the centerpiece)

**Goal**: The learning loop closes — a pattern dismissed 3+ times stops being flagged on future reviews.

**Prerequisites**: Phase 2 (needs outcomes).

**Scope — in**: immutable idempotent events, canonical taxonomy classification, patterns table (merging + re-normalization), outcome→signal mapping, rule learner (candidate → Beta confidence → active), read model (retrieval excludes dismissed, `renderRules`).

**Scope — out**: rebuild/explain/CLI (Phase 4), falsifiability + guardrails (Phase 5). No `console.log` in src.

## Files / modules to create

- `src/learning/events/` — emit + query immutable `learning_events` (§2, §5.3)
- `src/learning/taxonomy/` — canonical issue taxonomy + `pattern_id` classification (§5.4)
- `src/learning/patterns/` — patterns table: merging + re-normalization (§2)
- `src/learning/signals/` — outcome → learning signal mapping (§5.2)
- `src/learning/learner/` — candidate rules + Beta confidence + min-evidence gate + activation threshold + severity weighting (§5.6)
- `src/learning/retrieval/` — read model: context + rendered rules (§5.8)
- `src/dashboard/` — rules/learning view + “why did this finding disappear?” drill-down

## TDD test list (red → green)

1. `event_key is deterministic and idempotent` — worker retry cannot double-count evidence (§5.3).
2. `events are immutable` — update/delete rejected.
3. `taxonomy classifies into canonical pattern_id` — LLM emits stable pattern_id, not free-text normalization (§5.4).
4. `taxonomy snapshot test against real LLM outputs` — not synthetic (§9).
5. `dismiss 3× → candidate rule forms` — the critical learning-loop test (§9).
6. `Beta confidence crosses activation threshold` — `(neg+2)/(generated+4)`, min-evidence gate `generated >= 5` (§5.6).
7. `severity weighting modifies counts` — dismissed error counts more than suggestion (§5.6).
8. `signals: dismissed→negative, resolved→positive, replied→neutral, stale→weak` (§5.2).
9. `replies are NOT positive evidence` — replied 3× does not reward (§14).
10. `retrieval excludes dismissed patterns` — negative learning signal (§5.8).
11. `renderRules injects active rules into prompt` — REPO RULES section (§5.8).
12. `future review excludes dismissed pattern` — end-to-end: dismiss → rule → review stops flagging.
13. `dashboard shows rules` — candidate/active/retired rules with evidence counts.
14. `dashboard why-disappeared` — suppressed finding shows rule, confidence, evidence, learned-from PRs, last probe.

## Exit criteria (§13 Phase 3)

- Dismissed pattern stops being flagged.
- Dashboard shows candidate/active/retired rules + why-disappeared drill-down.

## Definition of done

- [x] Learning-loop end-to-end test green (dismiss 3× → candidate → Beta → future review excludes) — `test/learning-loop.test.ts`, `test/learner.test.ts`
- [x] Taxonomy snapshot tests green against real LLM outputs — `test/taxonomy.test.ts` (fixtures in `test/fixtures/llm-outputs/`, regenerate via `tools/capture-llm-outputs.ts`)
- [x] Event immutability + idempotency tested — `test/learning-events.test.ts` (DB trigger rejects UPDATE/DELETE)
- [x] Severity weighting math tested — `test/learner.test.ts`, `test/learning-signals.test.ts`
- [x] Dashboard rules/learning view tested — `test/dashboard.test.ts`, `test/dashboard-projection.test.ts` (`/api/rules`, learning panel counts + lag)
- [x] Dashboard why-disappeared drill-down tested — `test/dashboard.test.ts`, `test/dashboard-projection.test.ts` (`/api/why?findingId=`)
