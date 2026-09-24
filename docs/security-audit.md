# Security audit (Phase 6)

Scope: the hardening phase. Every item lists the controlling implementation and the
test that enforces it. Completed when all boxes are checked and the referenced
tests pass.

## Checklist

- [x] **Webhook HMAC-SHA256 + timing-safe + raw body capture**
      `src/webhooks/signature.ts` verifies the signature over the exact bytes
      received; `src/webhooks/routes.ts` captures `request.rawBody` before JSON
      parse (raw-body parser in `src/app.ts`). Length mismatch still runs a
      constant-time comparison. Test: `test/webhooks.test.ts`, `test/app.test.ts`.
- [x] **SSRF: host allowlist on all outbound fetches, pinned against redirects**
      `src/platform/ssrf.ts` re-checks the allowlist on every redirect hop, never
      follows a redirect to a non-allowlisted host, attaches auth only to
      allowlisted hosts, and enforces a byte budget before/while buffering.
      Config surface: `ALLOWED_HOSTS` in `src/config.ts`. Test: `test/ssrf.test.ts`.
- [x] **Config: zod-validated, `deepFreeze`, fail fast; no secrets in defaults**
      `src/config.ts`. Connection strings and secrets (`DATABASE_URL`,
      `REDIS_URL`, `WEBHOOK_SECRET`, `LLM_API_KEY`, `PLATFORM_TOKEN`) are
      required with **no defaults**; invalid or missing values throw on boot.
      Production requires `DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD`. Compose
      embeds no secret values, only `${VAR:?}` interpolation.
      Tests: `test/config.test.ts`, `test/security-audit.test.ts`.
- [x] **No `console.log` in `src/` — pino only**
      `oxlint.config.ts` sets `no-console: error`; `test/security-audit.test.ts`
      also scans the tree (comment-stripped) so `pnpm test` enforces it without
      lint. `src/observability/logger.ts` is the only logging path.
- [x] **`/metrics` gated — Basic auth, required in production**
      `src/observability/auth.ts` (`basicAuthHook`) guards `/metrics` in
      `src/observability/routes.ts`; `/dashboard` likewise. Production throws at
      boot without credentials. `/health` stays unauthenticated for the compose
      healthcheck. Tests: `test/security-audit.test.ts`, `test/config.test.ts`.
- [x] **Error handler does not leak internals in production**
      `src/app.ts` `setErrorHandler` returns `Internal Server Error` for `5xx`
      when `NODE_ENV=production`; validation failures return a bounded shape.
      Test: `test/app.test.ts`.
- [x] **Boot applies DB migrations; container runs non-root**
      `src/db/migrations.ts` runs pending migrations before the app listens
      (idempotent via drizzle journal). `Dockerfile` runs as `USER node`.
      Test: `test/migrations.test.ts`; verified by `docker compose up` boot.
- [x] **Load holds under burst; oversized diffs rejected**
      `test/load.test.ts`: a burst of jobs recovers transients and retains
      terminal failures in the DLQ with zero loss; `safeFetch` rejects oversized
      diff responses under concurrency without buffering them.

## Verification

```bash
pnpm test && pnpm lint && pnpm typecheck
```

Audit date: Phase 6.
