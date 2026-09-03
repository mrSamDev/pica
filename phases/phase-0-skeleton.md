# Phase 0 — Skeleton

**Goal**: A bootable, testable project shell with config, app, DB, queue, and observability wired up — no business logic yet.

**Prerequisites**: none.

**Scope — in**: git init, package.json, tsconfig (Node 22 native type stripping, no build step), vitest, testcontainers (postgres + redis), `config.ts`, `app.ts`, drizzle schema for **all 10 tables** (§3), BullMQ connection + worker skeleton, pino setup, oxlint + **anti-slop** ruleset, oxfmt formatter config.

**Scope — out**: any review/learning logic, webhooks, LLM, CLI. No `console.log` in src (pino only).

## Files / modules to create

- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- `.oxfmtrc` — oxfmt formatter config, `{ "printWidth": 300 }`
- `oxlint.config.ts` — oxlint config registering the vendored anti-slop plugin
- `tools/oxlint/anti-slop/` — vendored anti-slop ruleset (copied from dmmulroy/anti-slop, not an npm dep)
- `src/config.ts` — zod-validated, `deepFreeze`, fail-fast, no secrets in defaults (§7)
- `src/app.ts` — Fastify bootstrap, health check, error handler, raw-body capture (§2)
- `src/db/` — drizzle schema for all 10 tables from §3 (reviews, patterns, findings, posted_comments, finding_outcomes, learning_events, repo_rules, rule_evidence, webhook_events, llm_calls)
- `src/queue/` — BullMQ connection + worker skeleton
- `src/observability/` — pino setup
- `src/dashboard/` — skeleton: `/dashboard` route + JSON API stub (read-model projection, same app)
- `test/` — vitest + testcontainers helpers

## TDD test list (red → green)

1. `config rejects missing required var` — boot fails fast with clear error.
2. `config rejects invalid value` — zod validation error.
3. `config deepFreezes` — mutation throws.
4. `config has no secrets in defaults` — no secret-looking defaults.
5. `health endpoint returns 200` — `GET /health` → 200.
6. `error handler returns structured error` — unknown route → 404 JSON.
7. `raw body captured before JSON parse` — raw-body hook works.
8. `schema migration applies cleanly` — drizzle migrate on testcontainers postgres, all 10 tables present.
9. `queue connects to testcontainers redis` — BullMQ connection succeeds.
10. `pino logs, no console.log in src` — lint/scan guard.
11. `anti-slop rules pass` — oxlint with the vendored plugin reports no violations on skeleton code.
12. `formatter respects printWidth 300` — oxfmt formats a long line without wrapping at 80.
13. `dashboard route serves 200` — `GET /dashboard` → 200.
14. `dashboard API stub returns empty state` — JSON projection endpoint responds.

## Exit criteria (§13 Phase 0)

- Boots, health check passes; `/dashboard` serves.

## Definition of done

- [ ] `pnpm test` runs the full suite (unit + integration + learning loop) green
- [ ] `pnpm dev` boots, `/health` 200
- [ ] `/dashboard` serves 200
- [ ] All 10 tables migrated
- [ ] No `console.log` in `src/`
- [ ] `pnpm lint` (oxlint + anti-slop) green — anti-slop rules pass with no violations
- [ ] `pnpm fmt` (oxfmt, printWidth 300) green
- [ ] Comment hygiene — src comments explain _why_, never restate code; no decorative/duplicated comments (gate: phase-6 TDD list item 7).

## Tooling setup

- **Package manager**: pnpm only.
- **Formatter**: oxfmt via `.oxfmtrc` with `{ "printWidth": 300 }` (long lines stay on one line).
- **Linter**: oxlint with the **anti-slop** ruleset (dmmulroy/anti-slop). It is **vendored**, not an npm dependency — copy `src/` into `tools/oxlint/anti-slop/`, register it in `oxlint.config.ts` via `jsPlugins`, and enable the generic rules as `error`. Install with:

  ```bash
  npx skills add dmmulroy/anti-slop --skill install-anti-slop
  ```

  or copy manually per the repo README. Add `tools/oxlint/anti-slop/**` to `ignorePatterns` so oxfmt/oxlint don't reformat the vendored plugin.
