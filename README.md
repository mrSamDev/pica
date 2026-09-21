# pica — a self-learning code review agent

Reviews GitHub pull requests with an LLM and **learns from how humans respond**:
a finding humans keep dismissing stops being flagged; one they keep confirming
gets emphasized. Learning is explicit, auditable, testable, and rebuildable from
an immutable event log.

```
webhook → review job → LLM → findings → post comments → human feedback
                                                          ↓
                                        learning events → rule learner
                                                          ↓
                                             active rules → future reviews
```

## Why this exists

The whole point is the learning loop, not the reviews. A review produces
findings; findings produce outcomes; outcomes produce learning signals; signals
produce rules; rules change future reviews. Every stage is real or absent — no
no-op stubs.

## Architecture

One process, one job. Layered per feature: routes → controller (pure functions,
no Fastify types) → view.

| Module               | Responsibility                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/webhooks/`      | Ingress: HMAC-SHA256 validation, raw-body capture, outcome events                                                                                                           |
| `src/review/`        | Core pipeline: fetch-diff → chunk → LLM → parse → post-filter → post (prompts, parsing, postfilter, summary)                                                                |
| `src/learning/`      | The learning loop: immutable events, taxonomy, patterns, signals, learner (Beta confidence + decay + ε-probing), retrieval read model, feedback reply-parser, rules, report |
| `src/queue/`         | BullMQ workers (review, feedback/outcome) + Redis connection; retries and DLQ                                                                                               |
| `src/platform/`      | GitHub / Bitbucket adapters, SSRF-pinned `safeFetch`, feedback poller                                                                                                       |
| `src/llm/`           | Small `LLMClient` + provider clients: openrouter (default), ollama, openai-compatible, anthropic (`LLM_PROVIDER`)                                                           |
| `src/db/`            | Drizzle schema + client + boot-time migrations                                                                                                                              |
| `src/types/`         | Ambient type declarations (e.g. raw body on FastifyRequest)                                                                                                                 |
| `src/dashboard/`     | Operational visibility: read-model projection, static UI + JSON API                                                                                                         |
| `src/landing/`       | Public landing page (static HTML, no auth)                                                                                                                                  |
| `src/observability/` | pino logger, prometheus metrics, Basic-auth gate                                                                                                                            |
| `src/eval/`          | Offline replay harness (precision/recall per prompt × rules version)                                                                                                        |
| `src/cli/`           | `review-agent` CLI: explain-rule, rules, report, rebuild read model                                                                                                         |

Entry points: `src/app.ts` (Fastify bootstrap + plugins), `src/config.ts`
(zod-validated, fail-fast), `src/server.ts` (wiring, workers, boot migrations).

## Quick start (local)

```bash
pnpm install
pnpm db:migrate      # applies ./drizzle migrations to your DATABASE_URL
pnpm dev             # --watch, loads .env if present
```

Required env vars (no defaults — fail fast on boot): `DATABASE_URL`,
`REDIS_URL`, `WEBHOOK_SECRET`, `LLM_API_KEY` (except when `LLM_PROVIDER=ollama`).
Platform auth needs exactly one
path: `PLATFORM_TOKEN` (a fine-grained PAT), or a GitHub App via
`GITHUB_APP_ID` + `GITHUB_INSTALLATION_ID` + `GITHUB_APP_PRIVATE_KEY`. Set
`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` for the dashboard + `/metrics`.

## Run (Docker)

```bash
cp .env.example .env   # fill in secrets; see docs/deployment.md
docker compose up -d
```

`docker-compose.yml` runs postgres + redis + app with **no published ports**.
Migrations apply at app boot (`src/db/migrations.ts`). Webhook ingress is a
Cloudflare Tunnel (`--profile tunnel`). Health: `http://localhost:3000/health`.

## Configuration

All options are zod-validated in `src/config.ts` — bad or missing values abort
boot with a clear message. Secrets never have defaults. Per-repo review mode,
posting caps, learner thresholds (min evidence, activation threshold, decay),
severity weighting, and protected categories are all config, not magic numbers.

## Testing

```bash
pnpm test            # vitest; docker-gated suites auto-skip without Docker
pnpm lint            # oxlint (no-console, anti-slop rules)
pnpm typecheck       # tsc --noEmit
pnpm fmt:check       # oxfmt
```

TDD throughout — every behavior has a test written before its code. The
learning loop (dismiss 3× → rule forms → future review excludes it), rebuild
convergence, falsifiability, and guardrail tests are first-class. Load tests
enqueue a burst and verify no review job is lost; `safeFetch` is tested against
oversized diff responses. A comment-hygiene gate
(`test/comment-hygiene.test.ts`) scans `src/` for duplicated, decorative, or
code-echo comments, the same way the `no console.log` guard is enforced. See
`phases/` for the per-phase red → green lists.

## CLI

```bash
pnpm cli -- --help
pnpm cli review --dry-run
pnpm cli explain-rule <repo>
pnpm cli rule add <repo> --ignore "generated/**"
pnpm cli rule retire <repo>/<rule>
pnpm cli report --weekly
pnpm cli rebuild-read-model      # rebuild rules from the immutable event log
```

## Dashboard & metrics

The same Fastify app serves a minimal control room (`/dashboard`) and Prometheus
metrics (`/metrics`) — raw numbers, not marketing. Panels: system health, review
behavior, learning (rules + `learning_lag` + dismissal-rate trend), recent
activity from the event log. Basic-auth gated in production.

## Deployment

VPS + docker-compose + Cloudflare Tunnel — no open ports. Full runbook:
[docs/deployment.md](docs/deployment.md).

## Security

HMAC webhooks, SSRF-pinned outbound fetches, config fail-fast with no secret
defaults, no `console.log` in `src/`, gated `/metrics`. Audited checklist with
file and test references: [docs/security-audit.md](docs/security-audit.md).

## License

Private project.
