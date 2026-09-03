# Phase 4 — Rebuild + explain + CLI

**Goal**: The read model is a disposable projection — rebuildable from immutable events to the same rules — and every rule is explainable from its evidence trail via the CLI.

**Prerequisites**: Phase 3.

**Scope — in**: `rebuild-read-model` script, `explain-rule`, `rule add/retire`, `report --weekly`, `eval --replay`, `review --dry-run` CLI (§11). Manual actions emit `rule.manual_*` events so rebuild stays honest.

**Scope — out**: falsifiability + guardrails (Phase 5). No `console.log` in src.

## Files / modules to create

- `src/cli/` — review-agent CLI (§2, §11)
- `src/learning/retrieval/` — rebuild-read-model script (§5.9)
- `src/learning/events/` — replay + projection logic

## TDD test list (red → green)

1. `rebuild from event log produces same active rules` — delete read model, rebuild, assert convergence (§5.9).
2. `rebuild converges under shuffled orderings` — replay log in shuffled orders, same rules (§9).
3. `manual rule.manual_added survives rebuild` — human edits reproduced from log (§5.3).
4. `manual rule.manual_retired survives rebuild`.
5. `pattern.merged resolves evidence without rewriting log` — projection handles merge (§2).
6. `explain-rule shows evidence trail` — rule → findings → outcomes (§11).
7. `rule add emits manual event` — `rule.manual_added`.
8. `rule retire emits manual event` — `rule.manual_retired`.
9. `report --weekly lists learned/retired rules + dismissals by category`.
10. `eval --replay compares vs golden set` — precision/recall per prompt_version × rules_version (§10).

## Exit criteria (§13 Phase 4)

- Read model rebuilds to same rules.
- Rules explainable.

## Definition of done

- [ ] Rebuild test green (shuffled orderings converge)
- [ ] Manual events survive rebuild
- [ ] `explain-rule` shows full evidence trail
- [ ] CLI commands tested
- [ ] Comment hygiene — src comments explain _why_, never restate code; no decorative/duplicated comments (gate: phase-6 TDD list item 7).
