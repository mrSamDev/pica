# Deployment — VPS + docker-compose + Cloudflare Tunnel

Single process, single DB, one failure domain. The only ingress is a Cloudflare
Tunnel — **no container ports are published**, so there is nothing to expose on
a public interface for a scanner to find.

## 1. Prerequisites

- A VPS with Docker Engine and the `docker compose` plugin.
- A domain on Cloudflare (any plan).
- The secrets the stack needs (webhook secret, LLM key, platform token).

## 2. `.env`

Copy `.env.example` to `.env` on the VPS and fill it in. `docker-compose.yml`
uses `${VAR:?}` interpolation, so a missing value aborts `docker compose up`
with the exact variable named — you cannot boot a half-configured stack. App
config validation (`src/config.ts`) is the second fail-fast guard.

```bash
cp .env.example .env
$EDITOR .env
```

## 3. Boot

```bash
docker compose up -d
```

This brings up postgres, redis, and the app. The app applies pending
migrations at boot (`src/db/migrations.ts`) — no separate migration step.
Verify:

```bash
docker compose ps                      # all three should be healthy
docker compose exec app wget -qO- http://127.0.0.1:3000/health
```

`/health` is intentionally unauthenticated so orchestration can probe it; every
other operational endpoint requires the dashboard Basic auth creds.

## 4. Cloudflare Tunnel (webhook ingress)

The app binds `3000` inside the compose network. Give Cloudflare a route to it:

1. In the Cloudflare dashboard, create a **Named Tunnel** for this origin.
2. Under its **Configurations → Public Hostnames**, add:
   - `your-domain.example` → **Service**: `http://app:3000`
3. Copy the tunnel's token into `.env` as `TUNNEL_TOKEN`.
4. Start the tunnel:

```bash
docker compose --profile tunnel up -d
```

`cloudflared` talks out to Cloudflare; nothing listens on a public local port.
The base `docker compose up -d` (step 3 of the previous section) does **not**
need `TUNNEL_TOKEN` — it is only required by the tunnel profile. Set it before
running the tunnel; `cloudflared` exits fast if it is missing.

## 5. Configure the platform webhook

Point the VCS at your tunnel hostname. For GitHub, add a webhook:

- URL: `https://your-domain.example/webhooks/github`
- Content type: `application/json`
- Secret: the value of `WEBHOOK_SECRET` in `.env`
- Events: pull requests (reviews), issue/PR comment activity for outcomes

Bitbucket is served at `/webhooks/bitbucket` with the same secret. The signature
is HMAC-SHA256 over the raw body (`src/webhooks/signature.ts`).

## 6. Dashboard and metrics

- Dashboard: `https://your-domain.example/dashboard`
- Metrics: `https://your-domain.example/metrics`

Both prompt for the `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` set in `.env`
and are denied without them.

## 7. Operations

```bash
docker compose logs -f app            # watch reviews/errors (structured pino)
docker compose ps                     # health
docker compose pull && docker compose up -d --build   # upgrade
docker compose down -v                # full teardown (wipes volumes — careful)
```

Retained failed BullMQ jobs act as the DLQ; the dashboard surfaces the failed
count. Rule decay and feedback polling run on timers inside the same app
process.

## 8. Firewall

No port needs to be open inbound; outbound `443` to Cloudflare is all the
tunnel requires. Keep the host firewall closed unless you deliberately open a
management path.
