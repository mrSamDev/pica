# Phase 2 — Feedback collection

**Goal**: Track real human outcomes for posted findings, attributed via the comment link, through one serialized outcome queue.

**Prerequisites**: Phase 1 (needs posted comments).

**Scope — in**: `posted_comments` link, webhook outcome events, feedback poller (1h/24h/7d batches) with advisory lock, explicit outcome state machine (§5.1), feedback protocol reply-parser (§5.12).

**Scope — out**: learning loop (Phase 3). No `console.log` in src.

## Files / modules to create

- `src/learning/feedback/` — reply-parser for the feedback protocol (§2, §5.12)
- `src/queue/` — serialized outcome queue (webhook + poller funnel through one BullMQ queue)
- `src/platform/` — comment state polling (resolved / replied / dismissed / inconclusive)
- `src/db/` — `posted_comments`, `finding_outcomes` writes
- `src/dashboard/` — outcomes view (posted/replied/resolved/dismissed)

## TDD test list (red → green)

1. `state machine accepts valid transitions` — pending→posted→resolved, etc. (§5.1).
2. `state machine rejects invalid transitions` — e.g. resolved→posted throws.
3. `terminal states reopen only via probe/manual` — no silent reopen.
4. `webhook outcome event updates outcome` — comment created/resolved/deleted.
5. `poller dedups via advisory lock` — no duplicate polling across instances.
6. `poller observes terminal outcomes` — resolved/replied/dismissed/inconclusive.
7. `outcome mutations funnel through one queue` — webhook + poller cannot race.
8. `reply-parser: dismiss/not useful/false positive → dismissal` — with reason.
9. `reply-parser: good catch/fixed/resolved → positive`.
10. `reply-parser: everything else → neutral` — non-terminal.
11. `posted_comments links comment to finding` — attribution works.
12. `dashboard shows outcomes` — posted/replied/resolved/dismissed counts appear.

## Exit criteria (§13 Phase 2)

- Outcomes tracked for real comments, attributed via comment link.
- Dashboard shows outcomes.

## Definition of done

- [ ] State machine fully tested (valid + invalid transitions)
- [ ] Poller + advisory lock tested
- [ ] Reply-parser tested for all three classes
- [ ] One serialized outcome queue proven (no race)
- [ ] Dashboard outcomes view tested
