# Phase 5 — Falsifiability + guardrails

**Goal**: Learning is safe and falsifiable — suppressed patterns still generate evidence, stale rules decay, and security findings are never auto-suppressed.

**Prerequisites**: Phase 3 (needs active rules).

**Scope — in**: ε-probing (new glob context, max 1 probe/pattern/30d, visible marker), decay (90d no supporting evidence → retire), protected categories, high-severity dismissal routing to humans, north-star metric (`learning_lag`).

**Scope — out**: hardening (Phase 6), embeddings (Phase 7). No `console.log` in src.

## Files / modules to create

- `src/learning/learner/` — ε-probing + decay logic (§5.7)
- `src/learning/retrieval/` — probe injection into read model
- `src/observability/` — prometheus metrics (§8)
- `src/report/` — weekly report + high-severity dismissal routing (§5.5, §11)
- `src/dashboard/` — metrics view (dismissal-rate trend, `learning_lag`, probes)

## TDD test list (red → green)

1. `guardrail: dismissed error in protected category never produces auto-ignore rule` (§9, §5.5).
2. `protected categories block auto-suppression of severity=error` — secrets/auth/crypto/injection/data-loss/concurrency.
3. `severity weighting: dismissed error is strong + surprising` — routed to humans first (§5.5).
4. `high-severity dismissal appears in weekly report flagged for human confirmation`.
5. `falsifiability: suppressed pattern still generates probes` — ε-probing keeps evidence flowing (§9, §5.7).
6. `probe only in new glob context` — not seen by the rule.
7. `probe has visible marker` — users can tell it's a probe.
8. `max 1 probe per pattern per 30 days` — no probe spam.
9. `decay: no supporting evidence for 90d → confidence lowered → retired` (§5.7).
10. `north-star metric emitted` — `learning_lag` (dismissal → rule activation) (§8).
11. `dismissal rate per review over time` — trend metric present.
12. `dashboard shows metrics` — `learning_lag`, dismissal-rate trend, probes.
13. `dashboard control-room aesthetic` — raw numbers/statuses, no marketing copy.

## Exit criteria (§13 Phase 5)

- Suppressed patterns still generate evidence.
- Learning measurable.
- Security findings never auto-suppressed.
- Dashboard shows `learning_lag` + trends.

## Definition of done

- [x] Guardrail test green (protected error never auto-suppressed)
- [x] Falsifiability test green (probes keep evidence flowing)
- [x] Decay test green
- [x] `learning_lag` + trend metrics emitted
- [x] Dashboard metrics view tested
- [ ] Comment hygiene — src comments explain _why_, never restate code; no decorative/duplicated comments (gate: phase-6 TDD list item 7).
