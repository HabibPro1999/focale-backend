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

See **`.env.example.new`** for the full annotated list. The schema lives in
`packages/contracts/src/app-config.ts` and is parsed eagerly at boot in each
app's `core/config.ts` — invalid/missing values fail fast.

Both processes read the **same** env. Key vars: `DATABASE_URL`, `PORT`,
`CORS_ORIGIN`, `FIREBASE_*` / `STORAGE_PROVIDER` (+ `R2_*`), `EMAIL_PROVIDER`
(+ `SENDGRID_*` / `RESEND_*`), `ADMIN_APP_URL`, `REALTIME_DISABLED`,
`SSE_HEARTBEAT_MS`, `RUN_WORKERS`.

## Health endpoints (API)

All `@SkipThrottle`, no auth, enveloped (`{ ok, data, requestId }`). Ops
endpoints return **503** (with the body unchanged) when `data.isHealthy` is
false:

| Path | Purpose |
|---|---|
| `GET /health` | liveness + uptime |
| `GET /ready` | DB ping |
| `GET /health/email-queue` | email queue depth / staleness (unhealthy: stale sending, >1000 queued, or oldest queued >30min) |
| `GET /health/abstract-book-jobs` | book-job queue (unhealthy: stale running, >100 pending, or oldest pending >1h) |
| `GET /health/outbox` | outbox backlog (unhealthy: any dead-lettered, pending+failed ≥1000, oldest pending >10min, or oldest processing >2× lease) |

## Deployment

The old app was **one** process (HTTP + in-process workers + realtime pump).
The rebuild splits into **two deployables from one image**:

- **api** — `node apps/api/dist/main.js`. Serves HTTP and, unless
  `REALTIME_DISABLED=true`, runs the realtime outbox pump.
- **worker** — `node apps/worker/dist/main.js`. Runs the background job
  pollers (outbox / email queue / abstract-book).

Build both from `Dockerfile.new` (node:24-alpine, multi-stage, non-root):

```bash
docker build -f Dockerfile.new -t focale-api .                       # default CMD → api
docker build -f Dockerfile.new --build-arg APP=worker -t focale-worker .
# or one image, choose at run time:
docker run focale node apps/worker/dist/main.js
```

The image `HEALTHCHECK` hits `/health` (api parity with the legacy image).
Worker containers have no HTTP surface — disable the healthcheck there
(`--health-cmd=none` / platform setting).

### `RUN_WORKERS` semantics

Legacy behavior preserved: workers run **unless** `RUN_WORKERS` is the literal
string `"false"`. In the split topology, set `RUN_WORKERS=false` on the **api**
process (it should not also poll jobs) and leave it unset/true on the **worker**
process. The api worker `bootstrap()` early-returns when `runWorkers` is false.

### `REALTIME_DISABLED` caveat

The realtime SSE outbox pump runs **in the api process** (not the worker). With
`REALTIME_DISABLED=true` the pump never starts, so `realtime.emit` outbox rows
are enqueued but never drained — **they pile up unboundedly**. Only disable
realtime in environments where nothing produces those rows, or run at least one
api instance with realtime enabled to drain them.

## Migrations / baseline (existing DBs)

Drizzle migrations `packages/db/migrations/0000_init.sql` and
`0001_raw_indexes.sql` are a **baseline snapshot matching the live schema**
(the schema Prisma already created). They are **not** meant to be applied to the
live database — running them there would attempt to recreate existing objects.

- **Existing / live DB:** do **not** run `drizzle-kit migrate`. Mark the
  baseline as already-applied (record `0000`/`0001` in the drizzle journal)
  before any *future* migration.
- **Fresh env (local/CI/new deploy):** `pnpm --filter @app/db exec drizzle-kit migrate`
  applies the baseline from scratch.
