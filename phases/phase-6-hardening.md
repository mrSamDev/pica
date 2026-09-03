# Phase 6 — Hardening

**Goal**: Production-ready — security audited, load-tested, docs match reality.

**Prerequisites**: Phase 5.

**Scope — in**: security audit (§7), load test, docs match reality (delete or document, no README lies), deployment via VPS + docker-compose + Cloudflare Tunnel (§12).

**Scope — out**: embeddings (Phase 7). No `console.log` in src.

## Files / modules to create

- `docker-compose.yml` — postgres + redis + app (§12)
- Cloudflare Tunnel config for webhook ingress
- `README.md` + docs — must match reality (§0)

## TDD test list (red → green)

1. `security audit: no secrets in defaults` — config scan.
2. `security audit: no console.log in src` — lint/scan guard.
3. `security audit: /metrics gated or bound to private interface` (§7).
4. `load test: queue handles burst without loss` — BullMQ retries + DLQ.
5. `load test: diff size cap holds under load`.
6. `docs match reality` — every documented dir/file exists.
7. `comment hygiene gate` — comments in src explain _why_, never restate the code (`// increment count` style), and every non-obvious comment adds context. Scan src for comment-noise (decorative, obvious, duplicated-elsewhere) before merge, the same way the `no console.log` guard is enforced.

## Exit criteria (§13 Phase 6)

- Production-ready.

## Definition of done

- [x] Security audit checklist complete — `docs/security-audit.md` (§7 items → file → test)
- [x] Load test passes — `test/load.test.ts` (burst/DLQ + diff-size cap)
- [x] Docs verified against actual tree — `test/docs-reality.test.ts` (forward + reverse)
- [x] docker-compose boots the full stack — verified live (postgres/redis/app healthy, migrations auto-apply on boot)
- [x] Comment hygiene — src comments explain _why_ (business rules, security/timing, library workarounds), never restate code; no decorative or duplicated comments (AGENTS.md §Comments). Enforced by `test/comment-hygiene.test.ts` (TDD item 7).
