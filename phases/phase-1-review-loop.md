# Phase 1 — Review loop + eval harness

**Goal**: A working review pipeline (webhook → diff → LLM → comments) plus the offline eval harness that measures it.

**Prerequisites**: Phase 0.

**Scope — in**: webhook HMAC validation, platform diff fetch with SSRF protection, review pipeline stages, prompt building, strict LLM output parsing, post-filter, `LLMClient` + `OpenRouterLLM` (mocked in tests), eval harness.

**Scope — out**: feedback collection, learning loop, observe-only mode (Phase 1.5), CLI. No `console.log` in src.

## Files / modules to create

- `src/webhooks/` — ingress + HMAC-SHA256 validation (§4)
- `src/platform/` — GitHub/Bitbucket adapters, diff fetch (§2)
- `src/review/pipeline/` — fetch-diff → chunk → review → post (§4)
- `src/review/prompts/` — prompt building (rules + memory injected) (§2)
- `src/review/parse/` — strict LLM output parsing (§2)
- `src/review/postfilter/` — suppression + dedup + no-repeat-human + cross-commit dedup (§4)
- `src/llm/` — `LLMClient` + `OpenRouterLLM` (§6)
- `src/eval/` — replay historical PRs vs golden set (§10)
- `src/dashboard/` — live review + findings view + system health + recent activity (read-model projection, SSE/polling)

## TDD test list (red → green)

1. `HMAC valid signature accepted` — `timingSafeEqual`, length pre-check.
2. `HMAC invalid signature rejected` — 401.
3. `HMAC timing-safe` — no early return on length mismatch.
4. `raw body captured before JSON parse` — signature computed over raw bytes.
5. `SSRF blocks disallowed host` — outbound fetch to non-allowlisted host aborts.
6. `SSRF pins against redirect` — trusted host 302 → arbitrary host is blocked.
7. `auth token never attached to untrusted URL` — no Bearer on non-allowlisted host.
8. `diff size cap aborts early` — content-length / stream check before buffering.
9. `parser rejects malformed LLM output` — strict parse throws on bad shape.
10. `parser accepts valid output` — findings extracted with pattern_id.
11. `postfilter dedups by (pr_id, pattern_id)` — five phrasings → one comment.
12. `postfilter skips suppressed patterns` — deterministic drop.
13. `postfilter no-repeat-human` — skips findings duplicating existing comments.
14. `postfilter cross-commit dedup` — no re-flag on commit B unless lines changed.
15. `findings insert idempotent` — unique constraint + `onConflictDoNothing`.
16. `eval computes precision/recall` — agent findings vs golden human comments, fuzzy match on file/line/category.
17. `dashboard shows live reviews` — in-flight review appears in projection.
18. `dashboard shows findings` — posted/suppressed findings appear.
19. `dashboard shows system health` — reviews running/completed/failed + queue depth.
20. `dashboard shows recent activity` — event progression from the immutable log.
21. `dashboard live update` — SSE/polling returns current state after a review completes.

## Exit criteria (§13 Phase 1)

- Review posts comments on a real PR.
- Eval harness replays historical PRs.
- Dashboard shows live reviews + findings + system health + recent activity.

## Definition of done

- [x] Webhook → diff → LLM → comment end-to-end integration test (testcontainers) green — `test/e2e.test.ts`
- [x] Eval harness runs against golden set, reports precision/recall — `src/eval/metrics.ts` + `src/eval/replay.ts`, `test/eval.test.ts`
- [x] Dashboard shows live reviews + findings + system health + recent activity — `test/dashboard.test.ts` (17–21)
- [x] All SSRF + HMAC security tests green — `test/ssrf.test.ts` (5–8), `test/webhooks.test.ts` (1–4)
- [x] No `console.log` in `src/` — enforced by oxlint `no-console`
- [ ] Comment hygiene — src comments explain _why_, never restate code; no decorative/duplicated comments (gate: phase-6 TDD list item 7).

### Manual (needs real platform + LLM tokens)

- [ ] Review posts comments on a real PR — the automated E2E covers the full flow with a fake platform adapter; the live check requires real `PLATFORM_TOKEN` + `LLM_API_KEY` and a real webhook delivery.
