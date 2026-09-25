# Focale OS — NestJS rebuild (branch: `nest-rebuild`)

pnpm workspace running the platform as **two processes** (API + worker) on
NestJS + Fastify + Drizzle. This replaces the single Bun/Fastify app in `src/`
(kept intact for reference; the old `.env*`, `Dockerfile`, and `prisma/` belong
to it, not to this rebuild).

## Workspace layout

```
apps/
  api/      @app/api      HTTP server (NestJS + Fastify).      → apps/api/dist/main.js
  worker/   @app/worker   Background job pollers (NestJS ctx). → apps/worker/dist/main.js
packages/
  contracts/   @app/contracts   Zod schemas, env config parser, shared enums/types.
  shared/      @app/shared      Logger, ids, regex-safety, cross-cutting utils.
  db/          @app/db          Drizzle schema, queries, outbox, migrations.
  integrations/@app/integrations Email providers, storage (firebase/r2), certificate PDF.
```

Package resolution uses the `@app/source` export condition in dev/test (TS
source, run through `@swc-node/register`) and the built `dist/` in production.

## Commands

Run from the repo root (`pnpm` 10.x, Node >= 24):

```bash
pnpm install                 # install workspace deps
pnpm build                   # pnpm -r build  (tsc → dist/ per package)
pnpm typecheck               # pnpm -r typecheck
pnpm test                    # pnpm -r test (workspace-concurrency=1)

pnpm dev                     # API in watch mode (@app/api)
pnpm dev:worker              # worker in watch mode (@app/worker)
```

Per-package: `pnpm --filter @app/api <script>` (`dev`, `start`, `build`,
`typecheck`, `test`).

### Ops scripts

```bash
# Re-enqueue abstract emails that were SKIPPED. Dry-run by default; --apply enqueues.
pnpm --filter @app/worker requeue-skipped-abstract-emails \
  [--apply] [--event-id <id>] [--abstract-id <id>] [--trigger <trigger>] [--limit <n>]
```

`src/scripts/setup-tshg-abstracts.ts` (legacy) is a **one-time data-seeding
artifact** for a specific event (TSHG themes + deadlines). It is intentionally
**not ported** — it was run once against that event and has no ongoing role.

## Environment

One schema, `packages/contracts/src/app-config.ts`, covers every key both
processes read; `.env.example` is **generated** from its `.meta()` docs
(`pnpm env:example`; CI runs `pnpm env:example --check` and fails on drift).
Each app parses the environment once at boot (`core/config.ts` `loadConfig`,
fail fast with every failing key listed, never values) and hands typed slices
to `@app/db` (`configureDb`) and `@app/integrations` (`configureIntegrations`).
Blank values count as unset.

Both processes read the **same** env. Key vars: `DATABASE_URL`, `PORT`,
`CORS_ORIGIN`, `TRUST_PROXY`, `FIREBASE_*` / `STORAGE_PROVIDER` (+ `R2_*`),
`EMAIL_PROVIDER` (+ `SENDGRID_*` / `RESEND_*`), `ADMIN_APP_URL`,
`PUBLIC_FORMS_URL`, `PUBLIC_LINK_ALLOWED_ORIGINS`, `NETWORKING_*`,
`REALTIME_DISABLED`, `SSE_HEARTBEAT_MS`, `RUN_WORKERS`.

Production (`NODE_ENV=production`) additionally requires:

- `TRUST_PROXY`: explicit proxy IP/CIDR list, or `false` for direct traffic.
- `CORS_ORIGIN`: explicit origins only (no `*`, no paths).
- `ADMIN_APP_URL` (not the localhost default), `PUBLIC_FORMS_URL`,
  `PUBLIC_LINK_ALLOWED_ORIGINS`.
- The selected email provider's API key (`SENDGRID_API_KEY` or
  `RESEND_API_KEY`) and a sender (`EMAIL_FROM_EMAIL` or `SENDGRID_FROM_EMAIL`).
- `NETWORKING_TOKEN_SECRET` (32+ characters) unless `NETWORKING_DISABLED=true`.

`FIREBASE_SERVICE_ACCOUNT` accepts raw JSON or base64 JSON;
`NETWORKING_EMAIL_SENDERS` must be a JSON object.

### Pre-deploy config check (operator, read-only)

Run this against each service's environment (API and worker) before the first
deploy of a build that tightens config rules (3.1 does):

```bash
node packages/contracts/dist/cli/check-config.js
```

It validates the process environment with the production rules (`NODE_ENV`
forced to production) and prints only the names of failing keys and the rule
each one breaks, never values. It connects to nothing and writes nothing; exit
code 0 means the new build will accept that environment. It needs the new
build's files, so run it where that build is installed with the service's
environment: a Render one-off job or shell on the new image, or as the first
step of the service's Pre-Deploy Command (a failure then stops the deploy
before any instance switches). From a repo checkout, `pnpm build &&
pnpm config:check` checks the current shell's environment. A new build that
fails the rules would otherwise refuse to boot, listing the same keys.

## Health endpoints (API)

All `@SkipThrottle`, no auth, and **not** enveloped: each returns its raw body
with the status code probes rely on (503 when unhealthy, body unchanged).

| Path | Purpose |
|---|---|
| `GET /health/live` | Liveness: `{ "status": "ok" }`, no I/O, never fails. Use it as the platform health check (Render, image HEALTHCHECK). |
| `GET /health/ready` | Readiness: 200 `{ "status": "ready" }` when not draining, the database answers (ping cached 5 s) and the boot `MIGRATIONS_CHECK` found the schema current (or did not run). Otherwise 503 `{ "status": "not ready", "reasons": [...] }`, or 503 `{ "status": "draining" }` during shutdown. |
| `GET /health` | Legacy overall health: 200 `{ status: "healthy", timestamp, checks.database }`, 503 `unhealthy` when the DB ping fails (uncached). |
| `GET /health/worker` | Worker heartbeats (`worker_heartbeats`, written every 15 s): unhealthy when no enabled worker beat in the last 60 s, when only `RUN_WORKERS=false` workers are beating, or when a job has run past twice its timeout. Lists recent workers with their per-job state. |
| `GET /health/email-queue` | Email queue depth / staleness (unhealthy: stale sending, >1000 queued, or oldest queued >30 min). |
| `GET /health/abstract-book-jobs` | Book-job queue (unhealthy: stale running, >100 pending, or oldest pending >1 h). |
| `GET /health/outbox` | Outbox backlog (unhealthy: any dead-lettered, pending+failed ≥1000, oldest pending >10 min, or oldest processing >2× lease). |

## Deployment

The old app was **one** process (HTTP + in-process workers + realtime pump).
The rebuild splits into **two deployables from one image**:

- **api** — `node apps/api/dist/main.js`. Serves HTTP and, unless
  `REALTIME_DISABLED=true`, runs the realtime outbox pump.
- **worker** — `node apps/worker/dist/main.js`. Runs the background job
  pollers (outbox / email queue / abstract-book / networking).

The image CMD is `node start-runtime.mjs`, which supervises the process(es)
chosen by `APP` (`api` default, `worker`, or `all` for both in one container).
Build from `Dockerfile` (node:24-alpine, multi-stage, non-root, `TZ=UTC`):

```bash
docker build -t focale-api .                          # APP=api
docker build --build-arg APP=worker -t focale-worker .
# or one image, choose at run time:
docker run -e APP=worker focale-api
```

The image `HEALTHCHECK` runs `node healthcheck.mjs`: for `APP=api`/`all` it
calls `GET /health/live` (liveness, no DB); for `APP=worker` it requires the
worker heartbeat file (`WORKER_HEARTBEAT_FILE`, touched every 15 s) to be
younger than 60 s.

### Shutdown (`SHUTDOWN_GRACE_MS`, default 25 s)

`start-runtime.mjs` forwards SIGTERM/SIGINT to its children, logs every child
exit, and SIGKILLs any child still running `SHUTDOWN_GRACE_MS` + 3 s later.

- **API:** readiness (`/health/ready`) turns 503 `draining` and new SSE
  connections get 503 `SRV_5003` + `Retry-After`. Before Fastify closes, the
  realtime pump stops and every open stream (`/api/stream`, the networking
  participant stream) gets `event: shutdown` with a jittered 1-5 s reconnect
  (`retry:` and `data.reconnectInMs`) and is closed. Fastify then closes;
  sockets still open at grace − 5 s are destroyed; the pool closes; the
  process hard-exits at grace.
- **Worker:** stops scheduling and gives running jobs until grace − 5 s, then
  aborts them through their `AbortSignal` and gives them 3 s to settle; closes
  the Nest context and the pool; hard-exits at grace.

Keep grace + 3 s below the platform's own SIGKILL delay. On Render set
**`maxShutdownDelaySeconds` = 30** explicitly on the API and worker services
(the default grace of 25 s escalates at 28 s).

### Worker jobs and heartbeat

Every job declares a `timeoutMs` (outbox 60 s, email queue 120 s, Abstract
Book 30 min, networking delivery 30 s, networking maintenance and embeddings
5 min). Each run receives `{ signal, deadline, log }`; the signal aborts at the
timeout or at the shutdown deadline, and a job's next run never starts before
the previous one settles. Email provider requests are bounded at 15 s.

One heartbeat timer (15 s) writes both the liveness file
(`WORKER_HEARTBEAT_FILE`, read by the image HEALTHCHECK) and the process's
`worker_heartbeats` row (service name from `RENDER_SERVICE_NAME`), which
`GET /health/worker` reads.

### `RUN_WORKERS` semantics

Workers run **unless** `RUN_WORKERS` is the literal string `"false"`. With
`"false"`, the worker process does not exit (which would stop or restart its
container): it idles, keeps beating (file and `worker_heartbeats` row)
marked `disabled`, and shuts down cleanly on SIGTERM. With `APP=all` and
`RUN_WORKERS=false`, `start-runtime.mjs` starts only the API.

### `REALTIME_DISABLED` caveat

The realtime SSE outbox pump runs **in the api process** (not the worker). With
`REALTIME_DISABLED=true` the pump never starts, so `realtime.emit` outbox rows
are enqueued but never drained — **they pile up unboundedly**. Only disable
realtime in environments where nothing produces those rows, or run at least one
api instance with realtime enabled to drain them.

## Database migrations

Every SQL migration under `packages/db/migrations/` runs through the unified
ledger runner. The Drizzle `generate` and `migrate` commands are removed so the
old journal cannot apply `0000_init.sql` a second time.

- **Fresh local/CI database:** build `@app/db`, then run
  `node packages/db/dist/migrator/cli.js apply --yes`. PostgreSQL must already
  have the `vector` extension installed before migration 0013; the runner checks
  that prerequisite and does not install it.
- **Existing database:** `apply` refuses a non-empty schema with no migration
  ledger. Run `node packages/db/dist/migrator/cli.js adopt` (a dry run), review
  the report, then `adopt --apply` before `apply`; do not use a Drizzle journal
  or run baseline SQL directly. The adoption rules, the `MIGRATIONS_CHECK` boot
  check and the production rollout steps are in
  `packages/db/src/migrator/README.md`.

Migration 0011 repairs saved net totals only when `priceBreakdown` proves the
old convention; it is safe to rerun. `totalAmount` is gross before sponsorship,
while `priceBreakdown.total` is net.
