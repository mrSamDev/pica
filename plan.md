# Self-Learning AI Code Review Agent — Full Re-Implementation Plan

**Status**: plan. Greenfield build, informed by lessons from a prior implementation
(KavalX). Not a patch of that codebase — a clean rebuild with the learning loop as
the first-class citizen.

**One clear job**: review pull requests with an LLM, and _learn_ from how humans
respond to those reviews so future reviews get better.

**Thesis**: Review PRs → observe human outcomes → learn patterns → change future
reviews. The learning is explicit, auditable, testable, and rebuildable.

**Method**: Test-driven development throughout. Every behavior is written as a
failing test first, then made to pass. The learning loop is the most-tested part
of the system, not the least.

---

## 0. Lessons from the first implementation

These are the decisions this plan makes _because_ of what went wrong before.

| Lesson                 | What went wrong                                                                                     | Decision here                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Scope sprawl           | 4-5 products in one process (review bot, RAG memory, BI suite, observability platform, LLM gateway) | One process, one job. Cut everything not on the review+learn loop                                     |
| Learning loop unclosed | Feedback collected, but rules writer missing, consolidation a no-op stub, embeddings dead           | Learning loop is the centerpiece. Every stage must be real or absent                                  |
| Dead abstractions      | Provider registry nobody called, dual barrels, replaced retrieval tiers                             | Build only what's called. No speculative extensibility                                                |
| SSRF / token exfil     | `diffHref` accepted arbitrary URL with Bearer token attached                                        | Host allowlist on every outbound fetch, pinned against redirects. Never attach auth to untrusted URLs |
| Config sprawl          | 60+ env vars, duplicate `PROVIDER`/`LLM_PROVIDER`                                                   | One provider var. Fail fast on config. No secrets in defaults                                         |
| Hidden global state    | module-level mutable `events` array                                                                 | No module-level mutable state. Inject everything                                                      |
| No-op stubs            | consolidation worker logged "no-op"                                                                 | If it's not real, don't ship it                                                                       |
| Debug leaks            | `console.log` of raw LLM output                                                                     | No `console.log` in src. pino only, redact payloads                                                   |
| Thin tests             | 29 test files vs 15k LOC                                                                            | TDD. Test the learning loop end-to-end, not just units                                                |
| README lies            | docs listed dirs that didn't exist                                                                  | Docs match reality. Delete or document                                                                |
| Unbounded learning     | learner could suppress security findings                                                            | Protected categories + severity weighting + human routing (§5.5)                                      |

---

## 1. Stack

| Layer         | Choice                                                      | Why                                                                                                  |
| ------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Language      | TypeScript, Node 22+, native type stripping (no build step) | Fast, no toolchain                                                                                   |
| HTTP          | Fastify                                                     | Proven, fast, good hooks                                                                             |
| DB            | PostgreSQL (pgvector **deferred** — see §5.9)               | Relational first, vectors only when needed                                                           |
| Queue         | BullMQ + Redis                                              | Proven, retries, dedup                                                                               |
| LLM           | **OpenRouter only for v1** (DeepSeek V4 Flash)              | One client, no health-check/switching surface. Ollama path added only if a private-repo need appears |
| Infra         | VPS + Cloudflare Tunnel                                     | No open ports, cheap                                                                                 |
| Observability | pino + prometheus                                           | Minimal. Not a platform                                                                              |

---

## 2. Architecture

The domain is centered on **learning**, not on reviews. A review produces findings;
findings produce outcomes; outcomes produce learning signals; signals produce
learned rules; rules change future reviews.

```
                    GitHub / Bitbucket
                           │
                           ▼
                       Webhook
                           │
                           ▼
                      Review Job
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
          Diff/Code               Learning Context
              │                         │
              └────────────┬────────────┘
                           ▼
                           LLM
                           │
                           ▼
                        Findings
                           │
                           ▼
                     Human Feedback
                           │
                           ▼
                  ┌─────────────────┐
                  │ Learning Events │
                  │   immutable     │
                  └────────┬────────┘
                           │
                           ▼
                    Rule Learner
                           │
                           ▼
                     Learned Rules
                           │
                           └──────────────► Future Review
```

### The fundamental unit is a finding _pattern_, not a finding

A single finding is an instance. The learning unit is the **pattern** it belongs
to. A finding is classified into a canonical taxonomy (see §5.4), not normalized
from free text. Three dismissals of three different findings in the same pattern
is evidence about the _pattern_, not about any one finding.

### Write side / event stream / read model

- **Write side** owns authoritative state: findings, outcomes, rules.
- **Event stream** is a single append-only `learning_events` table. **Immutable —
  never updated or deleted.** It is historical truth about what happened.
- **Read model** is a projection: retrieval context + rendered rules. Rebuildable
  from the event log. Not another source of truth.
- **Partial view / consistency window**: a review may run with slightly stale
  memory; it converges later. Expected, not an error.
- **Read-through fallback**: if retrieval misses, fetch the finding/outcome
  directly from the DB.

### Module structure

Each feature module follows a consistent layering — routes (URL wiring) → controller (handlers, pure functions) → schema (validation/serialization) → view (presentation). Controllers stay free of Fastify types so they are unit-testable in isolation.

```
src/
  app.ts            # Fastify bootstrap, error handler, raw-body capture
  config.ts         # zod-validated config, deepFreeze, fail fast
  webhooks/         # ingress + HMAC signature validation
  review/           # core review pipeline
    pipeline/       # stages: fetch-diff → chunk → review → post
    prompts/        # prompt building (rules + memory injected)
    parse/          # strict LLM output parsing
    postfilter/     # deterministic suppression + dedup + no-repeat-human
    feedback/       # reply-parser for the feedback protocol
  learning/         # THE learning loop
    events/         # emit + query immutable learning_events
    taxonomy/       # canonical issue taxonomy + pattern_id classification
    patterns/       # patterns table: merging + re-normalization
    signals/        # outcome → learning signal mapping
    learner/        # candidate rules + Beta confidence + decay + ε-probing
    retrieval/      # read model: context + rendered rules
  eval/             # offline eval harness (replay historical PRs)
  cli/              # review-agent CLI (explain-rule, dry-run, rule add/retire, report)
  dashboard/        # operational visibility layer: read-model projection, static UI + JSON API, SSE/polling, same app
    routes.ts       # Fastify plugin: URL → controller wiring, applies schema
    controller.ts   # handlers as pure functions (no Fastify types)
    schema.ts       # JSON schema for validation/serialization
    view.ts         # HTML template
  queue/            # BullMQ workers (review, feedback, learn)
  db/               # drizzle schema + client
  platform/         # Bitbucket / GitHub adapters
  llm/              # small LLMClient + OpenRouter impl
  observability/    # pino + prometheus
```

---

## 3. Database schema

### reviews

```sql
reviews (
  id uuid pk,
  repo text not null,
  pr_id text not null,
  commit_sha text not null,
  status text not null,          -- queued | running | done | failed
  model text,                    -- reproducibility
  prompt_version text,           -- reproducibility
  rules_version text,            -- reproducibility
  retrieval_version text,        -- reproducibility
  mode text not null,            -- observe | post | dry-run
  started_at timestamptz,
  completed_at timestamptz,
  error text
)
```

Every review records the exact model, prompt version, rules version, retrieval
version, and mode that produced it. Six months later you can answer "why did the
bot make this decision?" — and run quasi-experiments comparing dismissal rates
with/without a rule.

### patterns (first-class learning unit)

```sql
patterns (
  id uuid pk,
  repo text not null,
  category text not null,        -- from taxonomy
  canonical_message text not null,
  glob text,
  pattern_version text not null,
  status text not null,          -- active | merged | retired
  merged_into uuid,              -- when two patterns are recognized as the same
  created_at timestamptz default now()
)
```

The pattern is the fundamental unit, so it gets a table. Findings reference
`pattern_id`. This buys two things you'll need within weeks:

- **Merging**: when two patterns turn out to be the same, a `pattern.merged`
  event lets the projection resolve evidence without rewriting the immutable log.
- **Re-normalization**: when the taxonomy evolves, patterns re-normalize cleanly.

### findings

```sql
findings (
  id uuid pk,
  review_id uuid references reviews,
  repo text not null,
  pr_id text not null,
  commit_sha text not null,
  file_path text not null,
  line_start int,
  line_end int,
  category text not null,         -- from taxonomy
  pattern_id uuid references patterns,  -- canonical pattern (stable across runs)
  severity text not null,         -- error | warning | suggestion
  message text not null,          -- raw LLM message, always stored
  message_hash text not null,
  status text not null,           -- pending | posted | failed | suppressed | duplicate
  created_at timestamptz default now(),
  UNIQUE (repo, pr_id, commit_sha, file_path, line_start, line_end, message)
)
```

`pattern_id` is the load-bearing key — assigned by taxonomy classification, not
string normalization. `message` (raw) is always stored so stale pattern keys can
be re-normalized when the taxonomy evolves. `status: suppressed` records when the
post-filter dropped a finding; `duplicate` records when it matched an existing
human comment.

### posted_comments (the comment ↔ finding link)

```sql
posted_comments (
  id uuid pk,
  finding_id uuid references findings,
  platform text not null,        -- github | bitbucket
  comment_id text not null,
  posted_at timestamptz default now(),
  UNIQUE (platform, comment_id)
)
```

This is the missing link. Without it the poller cannot attribute a reply or
resolution to a finding. **Decision: one comment per finding** — clean attribution
over consolidated-review UX. Revisit only if comment spam becomes a real problem.

### finding_outcomes

```sql
finding_outcomes (
  id uuid pk,
  finding_id uuid references findings on delete cascade,
  status text not null,          -- pending | posted | replied | resolved | dismissed | stale | inconclusive
  dismissal_reason text,        -- captured if the platform exposes one
  resolved_at timestamptz,
  reason text,
  resolver_user text,
  reply_count int default 0,
  poll_count int default 0,
  last_polled_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
)
```

All outcome mutations funnel through **one serialized queue** (see §5.1) so
webhook and poller writes cannot race. `dismissal_reason` distinguishes
"this rule is useless" (pattern-level) from "doesn't apply to this file"
(scope-level).

### learning_events (immutable event stream)

```sql
learning_events (
  id uuid pk,
  event_key text UNIQUE,         -- deterministic, retry-safe
  repo text not null,
  event_type text not null,      -- finding.outcome_changed | pattern.merged | rule.candidate | rule.activated | rule.retired | rule.manual_added | rule.manual_retired
  aggregate_id text not null,    -- finding:{id} | pattern:{id} | rule:{id}
  payload jsonb not null,
  created_at timestamptz default now(),
  INDEX (repo, created_at)
)
```

- **Immutable**: never updated or deleted.
- **Idempotent**: `event_key` is deterministic (e.g. `finding:{id}:outcome:{version}`),
  so a worker retry cannot double-count evidence.
- **Human actions are events too**: `rule.manual_added` / `rule.manual_retired`
  keep the event log the single source of truth, so a rebuild reproduces rules
  even when a human edited them.

### repo_rules

```sql
repo_rules (
  id uuid pk,
  repo text not null,
  rule_type text not null,       -- ignore | emphasize | style | scope
  pattern_id uuid references patterns,
  payload jsonb not null,
  payload_hash text not null,
  glob text,
  status text not null,          -- candidate | active | retired
  confidence numeric,            -- 0..1, Beta posterior
  evidence_count int default 0,
  positive_count int default 0,
  negative_count int default 0,
  first_observed_at timestamptz,
  last_observed_at timestamptz,
  created_by text,               -- "auto:learning" | "manual"
  created_at timestamptz default now(),
  deactivated_at timestamptz,
  UNIQUE (repo, rule_type, pattern_id)
)
```

A rule carries its own evidence summary so you can always answer _why it exists_.

### rule_evidence (the audit trail)

```sql
rule_evidence (
  id uuid pk,
  rule_id uuid references repo_rules,
  finding_id uuid references findings,
  outcome text not null,
  created_at timestamptz default now()
)
```

Links every rule to the specific findings that produced it. Enables
`explain-rule` and honest debugging.

### webhook_events (audit)

```sql
webhook_events (
  id uuid pk,
  platform text not null,
  event_key text not null,
  delivery_id text,
  validated boolean not null,
  processed boolean not null,
  created_at timestamptz default now()
)
```

### llm_calls (telemetry)

```sql
llm_calls (
  id uuid pk,
  review_id uuid,
  model text,
  provider text,
  prompt_hash text,              -- hash of what was actually sent
  prompt_tokens int,
  completion_tokens int,
  latency_ms int,
  status text,
  created_at timestamptz default now()
)
```

`prompt_hash` closes the debugging loop: when a review goes weird six months
later, model + prompt version isn't enough — the hash of what was actually sent is.

---

## 4. Core review flow

```
webhook → validate HMAC → enqueue (dedup) → worker
  → fetch diff (host allowlist pinned against redirects, size cap before download)
  → chunk
  → build prompt (rules + memory context injected)
  → LLM review (emits pattern_id per finding)
  → parse strictly
  → insert findings (idempotent, pattern_id assigned)
  → POST-FILTER: drop findings matching suppressed patterns (deterministic)
  → POST-FILTER: dedup by (pr_id, pattern_id) — one comment per pattern
  → POST-FILTER: skip findings duplicating existing human comments
  → POST-FILTER: cross-commit dedup (don't re-flag on commit B unless lines changed)
  → post comments (respect mode + per-repo cap)
  → set build status
```

Key rules:

- **Signature**: HMAC-SHA256, `timingSafeEqual`, length pre-check, raw body
  captured before JSON parse.
- **SSRF**: every outbound fetch validates the host against an allowlist **and
  pins against redirects** (a trusted host 302ing to an arbitrary host is a
  bypass). Auth token is never attached to an untrusted URL.
- **Diff size**: check `content-length` / stream before buffering. Abort early.
- **Idempotency**: findings unique constraint + `onConflictDoNothing`.
- **Queue**: depth admission, delivery + commit dedup, terminal-error → DLQ.
- **Dry-run**: `review-agent review --dry-run` prints findings + learning context
  instead of posting. Prevents PR spam, makes local dev easy.
- **Enforcement is deterministic, not just prompt-soft**: the post-filter drops
  suppressed patterns and dedups by `(pr_id, pattern_id)` so five phrasings of
  the same finding don't become five comments (LLM nondeterminism produces these;
  the findings unique constraint won't catch them since messages differ).
- **Don't repeat humans**: before posting, fetch existing review comments and
  skip findings that duplicate one. The bot echoing a human reviewer is a
  trust-killer and pollutes outcome data.
- **Cross-commit dedup**: once a pattern is flagged on commit A of a PR, don't
  re-flag on commit B unless the lines actually changed.
- **Observe-only mode**: in `observe` mode the full pipeline runs, findings are
  recorded and counted, but not posted (or posted as one capped summary comment,
  max ~5 findings, severity-prioritized). Measure would-be spam before inflicting
  it on the team. Per-repo posting caps and mode config.

---

## 5. The learning loop (the differentiator)

This is the whole point. Every stage must be real.

### 5.1 Collect feedback (write side)

Two sources, **one serialized outcome queue**:

- **Webhook outcome events**: comment created / resolved / deleted.
- **Feedback poller**: periodically re-checks comment state (1h / 24h / 7d
  batches) → resolved / replied / dismissed / inconclusive. Advisory lock to
  prevent duplicate polling across instances.

All outcome mutations funnel through one BullMQ queue so webhook and poller
writes cannot race. Define an explicit outcome state machine:

```
pending → posted (finding posted)
posted  → replied (non-terminal)
posted  → resolved (terminal)
posted  → dismissed (terminal)
replied → resolved (terminal)
replied → dismissed (terminal)
posted  → stale (terminal, after 7d no signal)
```

Terminal states reopen only via probe or manual events. Write these transitions
down before two writers start racing.

### 5.2 Map outcomes to learning signals

**Replies are NOT positive evidence.** A reply is often disagreement ("this is
wrong, the caller guarantees X"). Engagement ≠ correctness.

```
dismissed → negative signal (terminal)
resolved  → positive signal (terminal)
replied   → neutral, non-terminal (leading indicator only)
stale     → weak / neutral signal
```

Only terminal outcomes (resolved / dismissed) count as evidence. Replies are
leading indicators; the poller eventually observes the terminal outcome. If reply
sentiment is wanted later, make it a cheap classifier call — never a raw count.

Dismissals carry a `dismissal_reason` when the platform exposes one, to
distinguish pattern-level ("this rule is useless") from scope-level ("doesn't
apply to this file") learnings.

### 5.3 Emit immutable events

On every `finding_outcomes` status change, append a `finding.outcome_changed`
event with a deterministic `event_key`. Events are never updated or deleted.

### 5.4 Classify findings into a canonical taxonomy

**String normalization is the load-bearing wall and it will not hold.** LLM
phrasing varies across runs, temperature, prompt versions, and model upgrades.
"JWT expiration isn't validated" vs. "exp claim is never checked" would fragment
into two patterns and never accumulate evidence.

The robust fix: **make the LLM classify into a canonical taxonomy** instead of
normalizing free text.

- Define an enumerable issue taxonomy (start small, let it grow).
- The review prompt emits a stable `pattern_id` per finding.
- Store the raw `message` _and_ the `pattern_id`, tagged with `pattern_version`.
- Keep string normalization only for the residual (unclassified findings).
- **Snapshot-test the classifier against real LLM outputs**, not synthetic ones.

### 5.5 Safety guardrails on learning

The learner must not be able to suppress dangerous findings.

- **Protected categories** (secrets, auth/crypto, injection, data loss,
  concurrency): auto-ignore rules **cannot** suppress `severity=error` findings
  in these categories at all.
- **Severity weighting**: a dismissal of a `suggestion` is weak evidence; a
  dismissal of an `error` is strong _and surprising_ — treat them differently in
  the confidence math.
- **High-severity dismissals route to humans**: a dismissed `error`-severity
  finding appears in the weekly report flagged for human confirmation before any
  rule can absorb it.

### 5.6 Rule learner: candidate → confidence → active

Do **not** turn 3 dismissals into a rule immediately. Accumulate evidence:

```
dismissed >= min_evidence
      ↓
candidate rule
      ↓
Beta confidence
      ↓
confidence >= activation_threshold
      ↓
active rule
```

**Confidence is a Beta posterior, not a raw ratio.** `5 dismissed / 7 generated`
is a raw ratio on n=7. Use `Beta(2,2)` prior:

```
confidence = (neg + 2) / (generated + 4)
```

with a **minimum-evidence gate** (e.g. `generated >= 5`) and an explicit
`activation_threshold` in config. Both are config, not magic numbers.

**Severity weighting** modifies the counts: a dismissed `error` counts more than
a dismissed `suggestion` (and is routed to humans first, §5.5).

### 5.7 Rule decay + exploration (falsifiability)

**Self-suppression makes rules unfalsifiable.** Once a rule suppresses pattern P,
P stops generating findings, so no new evidence about P ever arrives. Every
learned rule becomes self-confirming until decay retires it, the bot re-flags,
and users see flapping.

Two mechanisms:

- **Decay**: no supporting evidence for 90 days → lower confidence → retire.
  Define "supporting evidence" per rule type. For a suppressive rule, absence of
  findings is absence of evidence — which is exactly the exploration problem.
- **ε-probing**: occasionally flag a suppressed pattern anyway. Better design
  than relying on decay alone: probe when the pattern appears in a **new glob
  context** the rule hasn't seen, flagged with a visible marker, **max 1 probe
  per pattern per 30 days**. This removes the flapping cycle.

Use the recorded `rules_version` per review to run quasi-experiments comparing
dismissal rates with/without a rule. That's the falsification mechanism, nearly
free.

### 5.8 Apply to read model

- Retrieval **excludes dismissed** patterns (negative learning signal).
- `renderRules` injects active rules into the prompt's `REPO RULES` section.
- The **post-filter** (§4) enforces suppression deterministically, not just by
  prompt instruction.
- Result: the bot stops flagging what humans keep dismissing, and emphasizes
  what they keep confirming.

### 5.9 Rebuildable read model

A `rebuild-read-model` script replays `learning_events` to rebuild retrieval
context + rules. Because events are immutable, idempotent, and include human
actions (`rule.manual_*`) and pattern merges (`pattern.merged`), rebuilding from
the log produces the **same** active rules. The read model is a disposable
projection, not a source of truth.

**Rebuild test**: replay the same event log in shuffled orderings and assert
convergence to the same rules. That is the real property you want.

### 5.10 pgvector is deferred, not assumed

Do **not** install pgvector until you can demonstrate a retrieval problem.

```
V1: exact / pattern retrieval (taxonomy + rules)
        ↓ problem discovered
V2: semantic retrieval with embeddings
```

Start with Postgres + taxonomy matching. Deliberately create a case where two
phrasings should be understood as related, _then_ introduce embeddings. This is
better than adding RAG because "AI projects need vectors."

### 5.11 Evidence velocity (will the loop ever fire?)

"3 dismissals of the same pattern" on a small team's repo might take months.
Mitigations:

- **Hierarchical pooling**: repo-wide evidence as a prior, glob-level refinement
  (shrinkage rather than strict per-glob accumulation).
- **Seed the demo** with replayed historical data so the centerpiece demos in
  tests and fires in real life.

### 5.12 Feedback protocol on the bot's comments

A tiny, deterministic protocol on every comment solves reply classification
without an LLM call:

```
⚠️ src/auth.ts:42 — JWT expiration isn't validated.

_Not useful? Reply `dismiss: <reason>` and I'll learn to stop flagging this._
```

Reply parser: `dismiss` / `not useful` / `false positive` → dismissal (with
reason); `good catch` / `fixed` / `resolved` → positive. Everything else stays
neutral until a terminal outcome. Cheap, auditable, testable — and it teaches
humans how to teach the agent, which is half the battle.

---

## 6. LLM abstraction (small, not a platform)

Avoid a generalized provider registry — that was a dead abstraction before.

```
LLMClient
  └── review(prompt) → ReviewResult
```

Then:

```
OpenRouterLLM
```

That's enough for v1. No plugin system, no registry, no factory factory, no
automatic fallback. Add Ollama only when a private-repo need appears.

**Note for private-repo adopters**: diff content is sent to a third-party LLM
(OpenRouter). This is the one place a self-hosted Ollama path genuinely matters.

---

## 7. Security

- Webhook HMAC-SHA256 + `timingSafeEqual` + raw body capture.
- SSRF: host allowlist on all outbound fetches, **pinned against redirects**. No
  auth on untrusted URLs.
- Config: zod-validated, `deepFreeze`, fail fast on boot. No secrets in defaults.
- No `console.log` in src. pino only, redact payloads.
- `/metrics` gated or bound to a private interface.

---

## 8. Observability (minimal, but with a north-star metric)

- pino structured logs.
- prometheus metrics:
  - `findings_posted_total`
  - `findings_suppressed_total{rule}`
  - `outcome_total{outcome}`
  - `pattern_dismissal_rate` (rolling 30d)
  - `learning_lag` — time from dismissal event to rule activation. **This is the
    proof your loop actually closes.**
- **Operational visibility layer** (see §2 `dashboard/`): a minimal read-model
  projection served by the same Fastify app. It answers one question —
  **“What is the agent doing, and why?”** — and is the way you see failures
  while building the learning loop, not just through logs. Live via SSE or
  simple polling. Still **no external platform** (no grafana, no separate
  dashboard service, no runtime event bus).

  The first version shows four panels:
  - **System health** — reviews running/completed/failed; queue depth per worker.
  - **Review behavior** — findings per PR, posted / suppressed / duplicate counts.
  - **Learning** — active/candidate/retired rules, `learning_lag`, dismissal-rate
    trend (e.g. `42% → 35% → 27%`).
  - **Recent activity** — the event progression from the immutable log
    (`PR #182 reviewed → finding dismissed → learning event emitted → candidate
rule updated → rule activated`). Because the architecture is event-driven,
    showing the event stream visually makes the system understandable without
    reading source.

  Plus one drill-down screen: **“Why did this finding disappear?”** — for a
  suppressed finding, show status, the suppressing rule, confidence, evidence
  counts, the PRs it was learned from, and last probe. This is the dashboard
  face of `explain-rule` (§11) and the `repo_rules` / `rule_evidence` audit trail.

  **Aesthetic**: an engineering control room, not a SaaS analytics product. Raw
  numbers, timestamps, statuses, drill-downs — no “AI Intelligence” / “Agent
  Health Score” marketing. That reinforces the project's character: observable,
  explainable, testable learning, not “AI magic.”

- **North-star metric**: dismissal rate per review over time, findings per PR
  over time, suppression rate. Without a trend metric you can't prove learning
  works — or notice it regressing.
- No grafana dashboards, no runtime event bus, no trace ALS. The operational
  visibility layer (§2) is the visibility layer; add external tooling only when a
  real need appears.

---

## 9. Testing (TDD throughout)

**Every behavior is written as a failing test first, then made to pass.** The
learning loop is the most-tested part of the system, not the least.

- **Unit**: pure functions — taxonomy classification, Beta confidence, rule
  decay, ε-probing, output parsing, post-filter, reply-parser.
- **Snapshot tests**: the taxonomy classifier against **real LLM outputs**, not
  synthetic ones.
- **Integration** (testcontainers: postgres + redis): webhook → review → comment
  end-to-end.
- **Learning loop test** (the critical one): dismiss a pattern 3× → assert a
  candidate rule forms → assert Beta confidence crosses threshold → assert a
  future review excludes it.
- **Rebuild test**: delete the read model, rebuild from `learning_events`, assert
  the same active rules. Replay the log in shuffled orderings and assert
  convergence.
- **Falsifiability test**: with ε-probing enabled, a suppressed pattern still
  generates occasional findings so evidence keeps flowing.
- **Guardrail test**: a dismissed `error`-severity finding in a protected category
  never produces an auto-ignore rule.
- **Eval harness** (see §10): replay historical PRs, compare agent findings vs
  human reviewer comments, assert precision/recall per `prompt_version` ×
  `rules_version`.
- Test behavior, not implementation.

---

## 10. Offline eval harness (build in Phase 1, not Phase 6)

The single highest-leverage tool. Take 20–50 historical PRs that humans actually
reviewed, run the agent over them in replay mode, and compare agent findings
against human reviewer comments (fuzzy match on file/line/category).

This gives you:

- **Precision/recall per `prompt_version` × `rules_version`** — prompt iteration
  without spamming real PRs.
- The measurement that Phase 7's exit criterion ("semantic recall beats pattern
  matching") literally cannot be evaluated without.
- A **regression suite**: every prompt or learner change gets replayed against
  the golden set before deploy.

Dry-run mode already gets you halfway — extend it from "print findings" to "print
findings vs. historical ground truth."

---

## 11. CLI (the demo)

The CLI makes the architecture legible without a UI.

```bash
review-agent review --dry-run
```

```
PR #142

AI REVIEW
────────────────────────────
⚠️  src/auth.ts:42
     JWT expiration isn't validated.

⚠️  src/user.ts:81
     Consider extracting this helper.

⚠️  src/api.ts:103
     Function is more complex than necessary.

Learning context:
  4 active rules
  12 relevant historical findings
```

```bash
review-agent explain-rule repo/api
```

```
RULE: ignore
PATTERN: complexity
SCOPE: src/controllers/**

Confidence: 87%

Evidence
────────────────────────
12 similar findings
  9 dismissed
  2 resolved
  1 replied

First seen: 2026-08-12
Last seen: 2026-09-01

Learned from:
  PR #182
  PR #187
  PR #191
  PR #194
```

```bash
review-agent rule add repo --ignore "generated/**" --reason "build output"
review-agent rule retire repo/api
review-agent eval --replay prs.json --golden golden.json
review-agent report --weekly
```

Humans can seed rules ("don't flag `generated/`") long before the learner earns
trust. Manual actions emit `rule.manual_*` events so the rebuild stays honest.

The system doesn't just learn — it can **explain what it learned and why**.

### Weekly learning report

A scheduled report builds team trust continuously. One issue or Slack message per
week:

- rules learned / retired
- dismissals by category
- dismissal-rate trend
- decayed rules needing review
- probes run
- high-severity dismissals awaiting human confirmation

Governance: replying "retire rule X" emits a manual event. An agent that silently
changes its own behavior across reviews feels creepy; an agent that publishes
what it learned each week feels like a colleague.

---

## 12. Deployment

- VPS + `docker-compose.yml`: postgres + redis + app.
- Cloudflare Tunnel for webhook ingress — no open ports.
- Single process, single DB. One failure domain, easy to reason about.

---

## 13. Roadmap (TDD phases)

Build in this order. **Do not build infrastructure until the learning loop
proves itself.** Each phase is test-first. Each phase has a dedicated TDD
checklist in `phases/` — see the linked file for the ordered red→green test
list, files to create, and definition of done.

| Phase | Scope | Exit criteria (all test-driven) | Phase file |
|---|---|---|
| 0 | Skeleton: config, app, db, queue, infra + **dashboard skeleton** | Boots, health check passes; `/dashboard` serves | [`phases/phase-0-skeleton.md`](phases/phase-0-skeleton.md) |
| 1 | Review loop: webhook → diff → LLM → comments + **eval harness** + **live review/findings view** | Review posts comments on a real PR; eval harness replays historical PRs; dashboard shows live reviews | [`phases/phase-1-review-loop.md`](phases/phase-1-review-loop.md) |
| 1.5 | **Observe-only rollout**: full pipeline, findings recorded, not posted (or capped summary) | Would-be spam measured before posting to the team | [`phases/phase-1.5-observe-only.md`](phases/phase-1.5-observe-only.md) |
| 2 | Feedback collection: webhook + poller → outcomes, `posted_comments` link, feedback protocol + **outcomes view** | Outcomes tracked for real comments, attributed via comment link; dashboard shows outcomes | [`phases/phase-2-feedback.md`](phases/phase-2-feedback.md) |
| 3 | Learning loop: immutable events + taxonomy + patterns + learner + read model + **rules/learning view** | Dismissed pattern stops being flagged; dashboard shows candidate/active/retired rules | [`phases/phase-3-learning-loop.md`](phases/phase-3-learning-loop.md) |
| 4 | Rebuild + explain: rebuild from events, `explain-rule`, `rule add/retire`, weekly report | Read model rebuilds to same rules; rules explainable | [`phases/phase-4-rebuild-explain.md`](phases/phase-4-rebuild-explain.md) |
| 5 | Falsifiability + guardrails: ε-probing, decay, protected categories, north-star metric + **metrics view** | Suppressed patterns still generate evidence; learning measurable; security findings never auto-suppressed; dashboard shows `learning_lag` + trends | [`phases/phase-5-falsifiability-guardrails.md`](phases/phase-5-falsifiability-guardrails.md) |
| 6 | Hardening: security audit, load test, docs | Production-ready | [`phases/phase-6-hardening.md`](phases/phase-6-hardening.md) |
| 7 | Embeddings (only if a retrieval problem is demonstrated) | Semantic recall beats taxonomy matching | [`phases/phase-7-embeddings.md`](phases/phase-7-embeddings.md) |

---

## 14. Definition of done

- A pattern dismissed 3+ times stops being flagged on future reviews.
- A pattern replied-to 3+ times does **not** get rewarded (replies are neutral).
- **Every learned rule is explainable from the historical evidence that produced it.**
- **Deleting the read model and rebuilding it from immutable learning events
  produces the same active rules** (including human-edited ones).
- **Rules are falsifiable**: ε-probing keeps evidence flowing; decay retires stale
  rules; the north-star metric shows learning over time.
- **Learning is safe**: protected categories and `error`-severity findings are
  never auto-suppressed; high-severity dismissals route to humans.
- **Learning is measurable**: the eval harness gives precision/recall per
  `prompt_version` × `rules_version`; `learning_lag` proves the loop closes.
- No no-op stubs, no dead abstractions, no `console.log` in src.
- One process, one job, one clear learning loop.
- **Every behavior is covered by a test written before the code.**

---

## 15. Positioning decision (post external review)

External review found the system work ahead of the product: strong engineering,
weak story. Decisions, in priority order:

- **GitHub-first, observe-first.** Positioning and onboarding lead with GitHub
  webhook reviews and "install, review, respond normally". The Bitbucket
  adapter stays (tested, working) but is de-emphasized in all product copy;
  removal is a separate decision after the loop shows real-world proof.
- **Dashboard leads with judgment, not telemetry.** `/dashboard` now opens with
  a verdict panel (`improving | uncertain | attention`) computed from the data
  the panels already showed: dismissal-rate trend, outcome counts, failure
  state. Thin evidence renders as `uncertain` — never a claim from a small
  sample (floor: ~10 decisive outcomes, ≥3 trend points).
- **Landing leads with the story.** One walkthrough (finding → dismissed 3× →
  candidate rule → suppression → why it was safe), clearly labeled
  illustrative. Philosophy sits below the fold.
- **UI framework: Vue 3, no build step.** `vue.esm-browser.prod.js` vendored at
  `src/dashboard/vendor/` (ships via the existing `COPY src` Dockerfile line;
  excluded from comment-hygiene, security-audit, oxlint, oxfmt — vendored
  upstream code, not hand-written).
