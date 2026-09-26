# Render runbook

How the NestJS build (`apps/` + `packages/`) runs on Render: the two services,
what happens on every deploy, shutdown timing, health paths, why the worker
must run, and the environment keys batch 3 added. Details that already live in
[README-rebuild.md](../README-rebuild.md) and the
[migrator README](../packages/db/src/migrator/README.md) are linked, not
repeated. One-off steps for the deploy that ships batch 3 are in
[production-rollout-checklist.md](production-rollout-checklist.md).

## Services

Both services run the same image, built from `Dockerfile` (node:24-alpine,
`TZ=UTC`, user `node`, CMD `node start-runtime.mjs`), and read the same
environment ([Environment](../README-rebuild.md#environment); `.env.example` is
generated from `packages/contracts/src/app-config.ts` and lists every key).

| | API | Worker |
|---|---|---|
| Render service type | web service | background worker |
| `APP` | `api` (the default) | `worker` |
| Instances | exactly 1 ([single-instance.md](single-instance.md)) | 1 |
| Health check path | `/health/live` | none; watch `GET /health/worker` on the API |
| `maxShutdownDelaySeconds` | 30, set explicitly | 30, set explicitly |
| Pre-Deploy Command | config check + `apply` (below) | same |

`APP=all` runs both processes in one container (`start-runtime.mjs`
supervises them); it is not the Render layout.

## Every deploy

1. **Build** the image.
2. **Pre-Deploy Command**, on both services, once the production migration
   ledger exists:

   ```bash
   node packages/contracts/dist/cli/check-config.js && node packages/db/dist/migrator/cli.js apply --yes
   ```

   The config check validates the service's environment with the production
   rules and prints only failing key names
   ([Pre-deploy config check](../README-rebuild.md#pre-deploy-config-check-operator-read-only)).
   `apply` takes the migration lease (the two services' pre-deploys run one
   after the other), applies the pending migrations in numeric order, and
   records a `deferrable` migration whose `defer-unless` check is false as
   `deferred` instead of failing. A failure stops the deploy before any
   instance switches; the previous release keeps serving.
   Before the ledger exists, do the one-time adoption first
   ([Production rollout](../packages/db/src/migrator/README.md#production-rollout-operator-steps)):
   `adopt` dry run, `adopt --apply`, the 0011 check, `apply`, `verify --schema`,
   then `MIGRATIONS_CHECK=enforce` and this Pre-Deploy Command.
3. **Start.** Each process runs the boot schema check
   ([`MIGRATIONS_CHECK`](../packages/db/src/migrator/README.md#boot-check-migrations_check))
   before it listens (API) or starts its jobs (worker). Render switches traffic
   to the new API instance once `/health/live` answers, then sends the old one
   SIGTERM (see Shutdown).

The previous release is still serving while the Pre-Deploy Command runs, and a
rollback runs old code on the new schema (ledger rows newer than the build only
warn at boot). There are no down migrations: every migration must work with the
code before and after it ([expand/contract](migration-authoring.md#expand-and-contract)).

## Migrations

All commands run in the image (`/app`) or a built checkout, with `DATABASE_URL`
set. The ledger records `MIGRATIONS_APPLIED_BY`, else `RENDER_SERVICE_NAME`.

| Command | Effect |
|---|---|
| `node packages/db/dist/migrator/cli.js plan` | Lints the files and prints both engine plans; no database. CI runs it in the image. |
| `… status` | Each migration's ledger state: applied, baseline, deferred or pending. |
| `… apply --dry-run` | What `apply` would do; writes nothing. |
| `… apply --yes` | Applies pending migrations under the lease. |
| `… apply --apply-deferred=NNNN --yes` | Retries one migration recorded as deferred. |
| `… verify --schema` | Ledger checksums plus catalog and `verify` probes; deferred migrations are warnings. |
| `… adopt [--apply]` | One-time classification of a database that has no ledger. |

Deferred migrations do not block anything: the boot check and `verify` only
warn, and `/health/ready` stays 200. The two that can be deferred:

- **0017** (CockroachDB vector index): deferred while `networking_embeddings`
  has rows or `feature.vector_index.enabled` is off. Build it in a maintenance
  window with
  [the vector index runbook](../NETWORKING.md#vector-index-health-and-runbook-cockroachdb).
- **0030** (one registration per event and sponsorship code): deferred while
  two registrations of an event store the same normalized code. Resolve the
  decision list of `repair-sponsorship-code-usages`, then run
  `apply --apply-deferred=0030 --yes`
  ([checklist](production-rollout-checklist.md#data-repairs)).

## Shutdown

Render sends SIGTERM, waits `maxShutdownDelaySeconds`, then SIGKILLs.
`start-runtime.mjs` forwards SIGTERM to its child; the child hard-exits at
`SHUTDOWN_GRACE_MS` (default 25,000, allowed 10,000 to 290,000), and
`start-runtime.mjs` SIGKILLs a child still running 3 s after that. So:

- **Rule:** `SHUTDOWN_GRACE_MS` + 3 s < `maxShutdownDelaySeconds`. The defaults
  give 28 s against 30 s. Set `maxShutdownDelaySeconds` = 30 explicitly on both
  services; raise it together with `SHUTDOWN_GRACE_MS`, never the grace alone.
- **API**, with grace G: `/health/ready` turns 503 `draining` and new SSE
  connections get 503 at once; open streams get `event: shutdown` and a
  jittered reconnect; running exports may continue until G − 6 s; sockets still
  open at G − 5 s are destroyed; the pool closes; exit at G.
- **Worker:** stops scheduling, lets running jobs work until G − 5 s, aborts
  them and gives them 3 s to settle, closes the pool, exits at G. Rows a job
  claimed but had not started go back to their queue without an attempt
  charged; anything still leased is recovered by `lease-recovery` once its
  lease expires.

Full sequence: [Shutdown](../README-rebuild.md#shutdown-shutdown_grace_ms-default-25-s).

## Health paths

All on the API, unauthenticated, not throttled and not enveloped: 200 when
healthy, 503 with the same body shape when not. Full table:
[Health endpoints](../README-rebuild.md#health-endpoints-api).

| Path | Use it for | Unhealthy when |
|---|---|---|
| `/health/live` | Render health check (and the image HEALTHCHECK for `APP=api`) | never; no I/O |
| `/health/ready` | monitoring | draining, database ping fails (cached 5 s), or the boot check found the schema not current |
| `/health/worker` | alerting | no enabled worker beat in 60 s, only `RUN_WORKERS=false` workers beating, or a job running past twice its timeout |
| `/health/outbox` | alerting | a dead letter in the last 24 h, 1,000+ pending or failed, oldest pending > 10 min, or a row processing > 2× its lease |
| `/health/email-queue` | alerting | stale sending, > 1,000 queued, or oldest queued > 30 min; also reports `uncertainCount` |
| `/health/abstract-book-jobs` | information | stale running job, > 100 pending, or oldest pending > 1 h |
| `/health/networking-vector-index` | information | an event above the exact-ranking limit uses the fallback because the index is missing |

Keep `/health/live` as the only Render health check. The other paths fail on
database, queue or worker trouble that restarting or replacing the API does not
fix.

## The worker is required

The API does not process background work. If the worker service is stopped,
crash-looping, or runs with `RUN_WORKERS=false` (it then idles and beats as
`disabled`, and `/health/worker` turns 503):

| Job | Every | Stops working |
|---|---|---|
| `outbox` | 5 s | automatic emails are never queued (registration, sponsorship and abstract triggers); networking photo deletions (`storage.delete`); capacity drops (`access.capacityReached`, 2.8b #132) |
| `email-queue` | 5 s | no queued email is sent |
| `lease-recovery` | 30 s | rows leased by a worker that died stay leased; since 3.4a (#114) only the worker recovers them |
| `retention` | 1 h, and at boot | `realtime.emit` rows, finished outbox rows and old email snapshots are never cleaned up (3.5 #120, 3.6b #129) |
| `abstract-book` | 30 s | Abstract Books are not generated |
| `networking-delivery` | 1 s, in lanes | sign-in codes (OTP), notices and digests are not delivered: participants cannot sign in |
| `networking-maintenance` | 60 s | retention purges and withdrawal erasure (4.4) do not run |
| `networking-embeddings` | 15 s | new and changed profiles are not embedded, so vector recommendations miss them |

Timeouts, leases and retention rules:
[Worker jobs and heartbeat](../README-rebuild.md#worker-jobs-and-heartbeat).
The heartbeat (every 15 s) writes `WORKER_HEARTBEAT_FILE` and the
`worker_heartbeats` row named after `RENDER_SERVICE_NAME`.

## Environment keys added in batch 3

`.env.example` describes every key. PR numbers are the backend PRs.

| Key | Service | Default | What it does | PR |
|---|---|---|---|---|
| `SHUTDOWN_GRACE_MS` | both | 25000 | shutdown budget per process (see Shutdown) | #102 (3.2) |
| `WORKER_HEARTBEAT_FILE` | worker | `<os tmpdir>/focale-worker.heartbeat` | liveness file read by the image HEALTHCHECK | #102 (3.2) |
| `NETWORKING_DISABLED` | both | `false` | `true` where no event uses networking: no token secret needed, participant auth answers 503 | #96 (3.1) |
| `NETWORKING_KEYS` | both | unset | networking keyring (`kid:key,...`, first is current); rotation in [NETWORKING.md](../NETWORKING.md#key-rotation) | #111 (4.5) |
| `NETWORKING_KEYRING_WRITE_V1` | both | `false` | write new MACs and seals with the first `NETWORKING_KEYS` key | #111 (4.5) |
| `NETWORKING_WITHDRAWAL_ERASE_DAYS` | worker | 30 | days after a withdrawal before maintenance erases the rest of the participant's data | #121 (4.4) |
| `NETWORKING_DELIVERY_BATCH_SIZE` | worker | 10 | rows each general delivery lane claims | #130 (4.2) |
| `NETWORKING_DELIVERY_CONCURRENCY` | worker | 6 | general delivery lanes | #130 (4.2) |
| `NETWORKING_DELIVERY_OTP_LANES` | worker | 2 | lanes that only send sign-in codes | #130 (4.2) |
| `NETWORKING_EMAIL_RATE_PER_SECOND` | worker | 5 | networking emails per second **per worker process**; keep it under the provider account limit | #130 (4.2) |
| `EXPORT_MAX_CONCURRENCY` | api | 2 | report and abstracts exports running at once in the API process (the networking XLSX is not counted) | #133 (3.7a) |
| `EXPORT_MAX_QUEUED` | api | 4 | exports waiting for a slot (30 s max); beyond that 503 `EXPORT_BUSY` | #133 (3.7a) |

Existing keys whose rules changed in batch 3:

- `TRUST_PROXY` is required in production on **both** services (the worker
  parses the same config), since #96 (3.1).
- `REALTIME_DISABLED` must have the same value on both services: realtime rows
  are produced by both, and a process without the flag keeps writing rows
  nothing drains ([REALTIME_DISABLED](../README-rebuild.md#realtime_disabled),
  #120, 3.5).
- `RENDER_SERVICE_NAME` (set by Render) names the worker's
  `worker_heartbeats` row, since #109 (3.3).
- `MIGRATIONS_CHECK` stays `warn` until the production ledger is adopted, then
  `enforce`.

The API also needs a writable temp directory: the check-in ZIP export writes
its workbooks under `os.tmpdir()` (about 0.2 MB per 10,000 registrations per
workbook; the image's `/tmp` is writable by `node`),
[File exports](../README-rebuild.md#file-exports-streamed-bounded).
