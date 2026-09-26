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
pnpm contracts:generate      # regenerate packages/contracts/generated (frontend artifacts)

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

# Store the certificate render image (flattened JPEG, <= 3508 px) of templates
# uploaded before migration 0032; without one the worker embeds the original.
# Dry-run by default; --apply stores them (fresh keys, guarded row update).
pnpm --filter @app/worker backfill-certificate-renders \
  [--apply] [--event <id>] [--template <id>]... [--limit <n>]
```

`src/scripts/setup-tshg-abstracts.ts` (legacy) is a **one-time data-seeding
artifact** for a specific event (TSHG themes + deadlines). It is intentionally
**not ported** — it was run once against that event and has no ongoing role.

#### PAID data repair (`repair-paid-settlement`, plan 2.4)

Repairs registrations hit by the PAID-demotion bugs (PAID set without an amount;
edits re-deriving PAID down to PENDING/PARTIAL). Run it only after a backup and
with 2.6/2.8 deployed; the script header has the details.

```bash
# 1. Dry run (read-only): report A/B1/B2/B3/C + repair-manifest.json (every action null; never overwritten)
pnpm --filter @app/worker repair-paid-settlement --since <Nest deploy, ISO> [--event <id>] [--out <file>] [--json]
# 2. Sign-off: copy to approved.json, set each row's action (or delete the row):
#    A (PAID rows): BACKFILL_PAID | CONVERT_PARTIAL | SKIP;  B1/B2/B3 (PENDING/PARTIAL): REPROMOTE_PAID | SKIP
#    accept every proposal, then decide the null rows by hand:
#    jq '.rows |= map(.action = (.action // .proposedAction))' repair-manifest.json > approved.json
# 3. Apply exactly the approved actions (the whole manifest is refused if a row is unset or not allowed)
pnpm --filter @app/worker repair-paid-settlement --apply --manifest approved.json
# 4. Invariant checks (read-only; exit 2 when a check finds rows)
pnpm --filter @app/worker repair-paid-settlement invariants [--event <id>] [--json] [--limit <n>]
```

- Sections: A = PAID with `paid_amount < net` (any date); B1 = admin-edit demotions after `--since`
  (audited); B2 = self-edit demotions (status history rebuilt from the audit log); B3 = admin-created
  rows re-priced after `--since` (manual review); C = seats each action moves, per access item.
  Rows without a proposal (`proposedAction: null`, see `info.flags`) need a per-row decision.
- Apply runs each row in its own locking transaction through the settlement writer. It skips and
  reports rows that changed since the dry run (`STALE`), left their section, do not fit the action,
  disagree with their breakdown, or whose re-promotion finds an access item full (`CAPACITY_FULL`).
  Seats move only by the writer's delta. `CONVERT_PARTIAL` keeps the paid amount, clears `paid_at`
  and releases the uncovered seats (the row then follows the PARTIAL capacity rules).
- Each applied row is audited `DATA_REPAIR_SETTLEMENT` (`SYSTEM:repair-paid-settlement`) and enqueues
  `registration.updated`; no email. Rerunning a manifest changes nothing (`ALREADY_APPLIED`).
- The invariant checks are `checkSettlementInvariants` in `@app/db`, ready for a staging job or a
  CI step against a restored snapshot (not scheduled).

## Frontend contract artifacts

`packages/contracts/generated/` is built from the Zod schemas in
`packages/contracts/src` and the condition parity cases in `packages/shared/src`.
Don't edit it by hand: run `pnpm contracts:generate` and commit the result. CI
(`static`) runs `pnpm contracts:generate --check` and fails when the folder is
stale. The output is deterministic (sorted names, stable key order, no
timestamps), so the check only fails on a real change.

| File | Content |
|---|---|
| `json-schema/contracts.input.json` | JSON Schema draft 2020-12, one `$defs` entry per exported schema (export name); a schema used inside another is a `$ref`. Input side: what a client sends, before parsing. |
| `json-schema/contracts.output.json` | Same schemas, output side: after parsing (defaults filled, unknown keys stripped). |
| `types/contracts.input.ts`, `types/contracts.output.ts` | TypeScript types generated from those documents (`CreateRegistrationBodySchema` → `CreateRegistrationBody`). |
| `fixtures/field-visibility.json`, `fixtures/rule-conditions.json` | Condition parity cases, format `focale.condition-parity/v1` (below). |
| `manifest.json` | Each schema's source module and type name, and every spot JSON Schema can't express. |

How the admin and form repos use them (there is no shared package, so they
vendor copies):

1. Copy the files you need from a backend `develop` commit into the frontend
   repo (for example `src/contracts/generated/`) and name that commit in the
   commit message. Re-copy when a backend PR changes `generated/`; the change is
   visible in that PR's diff.
2. Types: `import type { CreateRegistrationBody } from "./contracts.input"` for
   what you send; the output file for shapes the server builds from these
   schemas. Dates are ISO 8601 strings in both.
3. Runtime validation (optional): load a document into a draft 2020-12
   validator (Ajv: `Ajv2020` plus `ajv-formats`) and refer to
   `#/$defs/<ExportName>`.
4. Parity fixtures: a test loops over `cases` and calls the local copy of the
   evaluator named in `call` with `(conditions, logic, formData)`, leaving out
   `logic` when a case has none, and expects `expected` (`"throws"` means it
   throws). A key missing from `formData` is `undefined`, and so is a condition
   without `value`. Copies to test: `field-visibility`: form
   `src/lib/conditions.ts`, admin `src/features/registrations/utils/conditions.ts`;
   `rule-conditions`: form `src/lib/pricing-conditions.ts`. A failing case means
   the copy has drifted from the server.

What JSON Schema can't express is marked with a `$comment` at the spot and
listed under `unrepresentable` in `manifest.json`:
- `date`: a `Date` is `string` with `format: date-time`.
- `transform` (output side): the value is computed in code, so its type is `unknown`.
- `preprocess` (input side): the schema describes the converted value, e.g. a
  boolean for `?active=true`.
- `opaque`: `UpdateNetworkingConfigSchema`, `NetworkingSpaceUpdateSchema` and
  `NetworkingTableUpdateSchema` accept any JSON and validate it in code; their
  input type is `unknown`.

Query and path parameters travel as strings; `z.coerce` fields show the coerced
type.

### Response contracts

A route can declare the `data` payload it returns with
`@ResponseContract(Schema)` (`apps/api/src/core/response-contract.ts`). The
envelope interceptor then projects the handler's result onto the schema before
wrapping it:

- In every environment, object keys the schema does not declare are dropped at
  every depth, so a column added to a table (or a field added to a service
  result) is never returned by default. Declared keys keep their value and
  order, so a response that already matches is byte-identical.
- Outside production, the dropped key paths are logged (`warn`, "Response
  contract stripped undeclared keys", key names only), and the projected payload
  is validated against the schema: a mismatch fails the request with a 500
  (`SRV_5001`) naming the paths, so drift shows up in dev and CI.
- In production the payload is only projected (no log, no validation).
- At compile time the handler's return type must satisfy the schema and must
  not carry a key the schema would drop: adding a field to a covered result
  fails typecheck at the decorator until the schema lists it. The decorator
  refuses open objects, transforms and other shapes it can't project, at boot.
- Routes without a contract are unchanged.

The schemas live in `packages/contracts/src/*.responses.ts` (plus the access
item schemas in `access.ts`), so they are in the generated artifacts: the
output-side types are the response `data` shapes. Stored JSON documents
(`formData`, `priceBreakdown`, form `schema`, pricing `rules`, access
`conditions`, audit `changes`) are opaque (`unknown`) until the JSONB typing
work. Covered routes:

| Routes | Schema |
|---|---|
| `POST /api/public/forms/:formId/register` | `PublicRegistrationCreateResponseSchema` |
| `GET` / `PATCH /api/public/registrations/:id` | `PublicRegistrationForEditResponseSchema` / `PublicRegistrationEditResponseSchema` |
| `PATCH /api/public/registrations/:id/payment-method`, `POST …/payment-proof` | `PaymentMethodSelectedResponseSchema`, `PaymentProofUploadResponseSchema` |
| `POST /api/public/forms/:formId/calculate-price` | `PriceBreakdownSchema` |
| `GET /api/forms/public/:slug`, `GET /api/forms/public/:slug/sponsor` | `PublicFormResponseSchema`, `PublicSponsorFormResponseSchema` |
| `GET /api/public/events/:id/payment-config` | `PublicPaymentConfigResponseSchema` |
| `POST /api/public/events/:eventId/access/grouped`, `…/access/validate` | `GroupedAccessResponseSchema`, `AccessSelectionValidationResponseSchema` |
| `GET /api/public/events/:eventId/access`, `…/access/:accessId` | `PublicEventAccessListResponseSchema`, `EventAccessItemResponseSchema` |
| `POST /api/public/events/:eventId/sponsorships`, `POST …/slug/:slug/sponsorships` | `SponsorshipBatchCreatedResponseSchema` |
| `GET /api/public/events/slug/:slug/registrants/search` | `PublicRegistrantSearchResponseSchema` |
| Admin registration create, admin edit, detail, update, confirm payment | `AdminRegistrationResponseSchema` |
| `GET /api/events/:eventId/registrations` | `AdminRegistrationListResponseSchema` |
| `GET /api/events/:eventId/registrations/columns` | `RegistrationTableColumnsResponseSchema` |
| `GET /api/events/:eventId/registrants/search` | `AdminRegistrantSearchResponseSchema` |
| `GET /api/events/registrations/:id/audit-logs`, `…/email-logs` | `RegistrationAuditLogListResponseSchema`, `RegistrationEmailLogListResponseSchema` |
| `GET /api/registrations/:id/edit-link` | `RegistrationEditLinkResponseSchema` |
| `GET /api/events/:eventId/sponsorships` | `SponsorshipListResponseSchema` |
| `GET` / `PATCH /api/sponsorships/:id` | `SponsorshipDetailResponseSchema` |
| `DELETE /api/sponsorships/:id`, `DELETE /api/registrations/:id/sponsorships/:sponsorshipId` | `SponsorshipSuccessResponseSchema` |
| `GET /api/registrations/:id/available-sponsorships`, `GET …/sponsorships` | `AvailableSponsorshipsResponseSchema`, `LinkedSponsorshipsResponseSchema` |
| `POST /api/registrations/:id/sponsorships`, `POST …/sponsorships/by-code` | `SponsorshipLinkedResponseSchema` |

Not covered yet: the networking routes, the public abstracts routes and the
other admin modules. `apps/api/src/modules/response-contracts.routes.test.ts`
checks that every enveloped route of the covered controllers has a contract.

### Tenant scoping (admin routes)

Admin routes on an event-owned resource declare their tenant check instead of
calling a resolver in the handler (`apps/api/src/modules/tenancy`, plan 5.4):

```ts
@Post(":eventId/admin/registrations")
@EventScoped({ module: ["registrations", "pricing"], write: true })
async adminCreate(@Param() { eventId }: EventIdParamDto, @Body() body: AdminCreateRegistrationDto) { … }
```

`@EventScoped`, `@RegistrationScoped`, `@SponsorshipScoped`,
`@EmailTemplateScoped`, `@AccessItemScoped`, `@CertificateTemplateScoped`,
`@FormScoped` (plus `moduleOfFormType`: the form's type adds its module) and
`@ClientScoped` (options `module`, `write`, `param`) add a guard that loads the
resource, its event and the client in one query (a client route loads the
client) and refuses, in order: the route's `@Param()` DTO (400, as the global pipe would), missing
resource (404), another client (403 `AUTH_1004`), a template with no event on
a write (400), an archived event on a write (400 `STT_12001`), then per module
an inactive client (403 `CLT_20001`) or a disabled module (403 `CLT_20002`).
The controller's `@Auth()` runs first. `@ScopedEvent()` / `@ScopedClient()`
give the handler what the guard loaded. Because guards run before pipes, the
tenant check now answers before body and query validation.

A route that names its event or client in the body or the query
(`POST /api/events`, `POST /api/forms`, `GET /api/forms?eventId=`) calls
`requireTenantScope(user, "event" | "client", id, options)` first thing in the
handler: the same read, checks, order and codes, after validation.

Converted: abstracts, email, registrations (admin + edit link), pricing,
check-in, reports and the sponsorship admin controllers (76 routes, 5.4), then
access, certificates, events, forms and clients (25 guarded routes and 3
in-handler checks, 5.4b). `apps/api/src/modules/tenancy/tenant-scope.routes.test.ts`
lists each route's expected scope, sends a cross-tenant and a missing-resource
request to every one, and requires every other route of those controllers to
be listed as an in-handler check or as unscoped (with the reason). Still
hand-written: the networking admin/recommendations `access()` helpers (and
`core/auth/assert-event-access.ts`, which only they use).

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
| `GET /health/worker` | Worker heartbeats (`worker_heartbeats`, written every 15 s): unhealthy when no enabled worker beat in the last 60 s, when only `RUN_WORKERS=false` workers are beating, or when a job has run past twice its timeout. Public body: `isHealthy`, `reasons` and `counts` (`live`, `disabled`, `overdueJobs`) only; per-worker and per-job detail stays in the table. |
| `GET /health/email-queue` | Email queue depth / staleness (unhealthy: stale sending, >1000 queued, or oldest queued >30 min). |
| `GET /health/abstract-book-jobs` | Book-job queue (unhealthy: stale running, >100 pending, or oldest pending >1 h). |
| `GET /health/outbox` | Outbox backlog (unhealthy: a row dead-lettered in the last 24 h, pending+failed ≥1000, oldest pending >10 min, or oldest processing >2× lease). `counts.deadLettered` is every dead letter still stored, `counts.deadLetteredLast24h` the ones that flag it; requeue them with `requeue-dead-letters` (below). |
| `GET /health/networking-vector-index` | Networking ANN index: unhealthy while an event above the exact-ranking limit ranks recommendations with the deterministic fallback (see `NETWORKING.md`). |

## Deployment

The old app was **one** process (HTTP + in-process workers + realtime pump).
The rebuild splits into **two deployables from one image**:

- **api** — `node apps/api/dist/main.js`. Serves HTTP and, unless
  `REALTIME_DISABLED=true`, runs the realtime outbox pump. One instance only
  (see "Realtime" below).
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

Queue tables are processed through the lease queue (`packages/db/src/lease-queue`:
the outbox, the Abstract Book jobs and the email queue). A run claims a batch (`status` → leased, `attempt_count` + 1,
`locked_by`/`locked_until`), one heartbeat renews the lease of every row not
finished, and each row's ownership is confirmed right before its handler; every
terminal write is fenced by that ownership. On shutdown, and on a timeout for
rows not started yet, the claimed rows go back to the queue without an attempt
charged; a row whose handler a timeout interrupts is charged, so it still
dead-letters eventually. The `lease-recovery` job (every 30 s) requeues rows
whose lease expired (their worker died), attempt charged, or dead-letters them
once their attempts are used up.

Abstract Book: one job per run, lease 5 min (renewed every 100 s while the
render runs; the render yields every 20 abstracts so the heartbeat keeps
running). A renewal that finds the job taken over aborts the render before
anything is uploaded or written. Requesting a book while the event's job is
`RUNNING` with an expired lease recovers that job first (requeued, or `FAILED`
once its 3 attempts are used up, which lets a new job start).

Email queue: every 5 s a run claims batches of 20 (10 sends at a time) and
keeps claiming until the queue is empty or its drain window ends (the 120 s
budget minus 45 s for the batch in flight). Lease 10 min; ownership is
re-checked right before each provider call, and a send already handed to the
provider is never interrupted. An expired lease is requeued with the retry
backoff (1, 5, then 15 min), or `FAILED` once `retry_count` reaches
`max_retries`; rows dispatched by networking are left to its own worker.

Email delivery safety: the worker stamps `email_logs.provider_attempted_at`
(and `provider`) in the lease-guarded write right before the provider call; a
claim clears it. Each call is classified:

| Outcome | Examples | Result |
|---|---|---|
| accepted | 2xx | `SENT`, never requeued. The write is retried 3 times; if it still fails the row stays leased with its marker and recovery parks it as `UNCERTAIN`. |
| rejected | an HTTP error response (4xx, SendGrid 500/503), no connection at all, an error before the request | the normal retry path (backoff, then `FAILED`) |
| ambiguous | timeout, connection reset, SendGrid 502/504, Resend 5xx, an unknown error | SendGrid: `UNCERTAIN`. Resend: retried under the same idempotency key (the log id) while retries are left, then `UNCERTAIN`. |

An expired lease whose marker is set may already have been sent: recovery
parks it as `UNCERTAIN` (SendGrid; Resend once its retries are used up)
instead of requeueing it, and release never puts a marked row back.
`UNCERTAIN` is never resent automatically and counts as sent for the
automatic-send dedupe checks. The provider's webhook moves it forward
(`processed` / Resend `email.sent` → `SENT`, then delivered, opened, bounced…);
an admin can resend it explicitly (`POST /api/events/:eventId/email-logs/:emailLogId/resend`
queues a new log with a new idempotency key and keeps the `UNCERTAIN` one).
`GET /health/email-queue` reports `uncertainCount`. SendGrid's Event Webhook
must include the **Processed** event for the reconciliation to happen.

A resent `UNCERTAIN` email can stay `UNCERTAIN` for good: when the original
did go out after all, its late `processed`/`delivered` webhook would make two
active logs for the same trigger, which the per-trigger unique index refuses
while the copy is queued, sent or delivered. The webhook then leaves the
original as it is and logs a warning (`emailLogId`, `constraint`); the copy
carries the delivery state. This is accepted: the recipient got the email
(twice), and the admin chose to resend it.

Send-now emails (the admin's one-off email to a registrant, committee
invitations and committee password links) go through `sendEmailNow()`
instead of the queue, with the same classification. Their `email_logs` row is
written before the call, already leased (2 min) with the provider-attempt
marker set and `max_retries` 0: accepted → `SENT`, rejected → `FAILED` (never
requeued), ambiguous → `UNCERTAIN` for both providers (nothing can render the
email again, so there is no same-key retry), and a process that dies mid-send
leaves a row that lease recovery parks as `UNCERTAIN`. These rows cannot be
resent from their log (`409 RES_3002`). The hardcoded committee emails use the
shared email layout (header with the event name, Focale footer).

Outbox retention: the `retention` job (hourly, and once at boot; 5 min
budget) works in 1,000-row statements. It deletes `realtime.emit` rows older
than 24 h (any status except leased: a day-old UI event is worthless), deletes
finished (`PROCESSED`/`SKIPPED`) rows without a dedupe key older than 30 d, and
compacts finished keyed rows older than 30 d to `payload = '{}'`. Keyed rows
are never deleted, so their `dedupe_key` keeps rejecting duplicates; dead
letters are kept for `requeue-dead-letters`.

Email log retention (same job): the `context_snapshot` of emails that are
finished (`SENT`, `DELIVERED`, `OPENED`, `CLICKED`, `BOUNCED`, `DROPPED`,
`FAILED`, `SKIPPED`) and were queued more than 90 days ago is cleared, in
1,000-row statements. A certificate email keeps only
`{"_certificateTemplateIds": [...]}` (the certificate send reads it to skip
certificates already sent). Queued, sending and `UNCERTAIN` rows keep their
snapshot (they may still be sent or resent from it), and networking rows are
left to networking retention. The first complete pass after the worker starts
covers the whole table (through `(status, queued_at)`); later passes only look
at rows queued 90 to 97 days ago, so an email that becomes finished more than
a week past the limit waits for the next restart.

Event email-log list (`GET /api/events/:eventId/email-logs`): the event's
emails are those of its registrations plus those of its templates. The list
reads two index-backed branches (by registration id; by template id through
`(template_id, queued_at)`, minus the event's registrations) joined with
`UNION ALL`, each cut to the requested page's end, and counts at most 10,000
rows (`meta.totalCapped` past that).

Dead letters: `pnpm --filter @app/worker requeue-dead-letters` (in the image:
`node apps/worker/dist/scripts/requeue-dead-letters.js`) lists dead-lettered
outbox rows, oldest first (`--type`, `--id`, `--since`, `--limit`, default
100). It is a dry run unless `--apply`, which puts the listed rows back as new
(`PENDING`, attempts reset, due now). `realtime.emit` rows are never requeued.

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

### Realtime (single API instance)

Run **exactly one API instance**. Realtime fan-out is process-local: the
realtime pump claims the realtime outbox types (`REALTIME_OUTBOX_TYPES`:
`realtime.emit` and the networking participant notices `networking.notify`)
every second (batches of 100, draining until a batch comes back short, at most
5 s per tick) and emits them on in-memory hubs: `/api/stream` serves only that
process's admin bus, and the participant stream
(`/api/networking/:slug/stream`, see NETWORKING.md) only that process's
participant hub. The SSE
event ids (`Last-Event-ID`) come from a per-process counter and the replay
history lives in memory: one ring of the last 500 events per tenant
(`clientId`), so one tenant's burst never evicts another tenant's history. A
second instance would claim half of the events for its own clients only, and
its ids would mean nothing to the other; a restart loses the history (clients
get `event: replay-gap` on reconnect and refetch). The in-memory rate limiter
has the same constraint. Scaling out needs a shared bus first.

Email status events (`emailLog.statusChanged`) are coalesced per 250 ms in the
process that changes the status: each email log's latest status in the window
counts once, and the window becomes one event per (event, status). A single
log keeps the old payload (`id`, `status`, `registrationId`); several logs are
listed in `payload.ids` (`id` is the first). See `FRONTEND_FOLLOWUP_3_5.md`.

### `REALTIME_DISABLED`

The realtime SSE outbox pump runs **in the api process** (not the worker). With
`REALTIME_DISABLED=true` the pump never starts, `/api/stream` answers 503, and
neither `realtime.emit` nor `networking.notify` rows are written. The
networking participant stream stays available: notices from API networking
transactions still reach it in-process, the rest at its 60 s resync. Realtime
events are produced by both processes, so set it on **both** the api and the
worker service; a process without it keeps writing realtime rows that nothing
drains until the retention job deletes them after 24 h.

### File exports (streamed, bounded)

Every file export streams (`apps/api/src/core/exports/`); the report and
abstracts downloads also share one admission path:

- **Admission**: `EXPORT_MAX_CONCURRENCY` (default 2) exports run at once per
  API process and up to `EXPORT_MAX_QUEUED` (default 4) more wait, first come
  first served, for at most 30 s. Anything beyond gets 503 `EXPORT_BUSY` with
  `Retry-After: 10`. The check runs after authorization, so only allowed users
  take a place.
- **Streaming**: the file is written straight into the response (chunked, no
  `Content-Length`). Registration exports read the rows by keyset, 500 per page
  (`submitted_at DESC, id DESC`), each page in its own short transaction under
  `DB_EXPORT_STATEMENT_TIMEOUT_MS`; XLSX uses ExcelJS's streaming writer with
  inline strings, one row committed at a time. Generation waits for the zip and
  the socket to take each page, so a slow client holds it back instead of
  growing memory. A 10,000 x 60 workbook costs the export about 82 MB above
  the idle process, flat with the row count (the in-memory builder took over
  1 GB and blocked the event loop for seconds);
  `registrations-export.perf.test.ts` (opt-in) measures it.
- **Client gone**: a disconnect aborts the export at the next page and frees the
  slot. A failure after the headers destroys the response, so the client sees
  a broken download, never a silently truncated file.
- **Shutdown**: while draining, new exports get 503 `SRV_5003`. An export
  already running may finish until 1 s before the shutdown force-closes sockets
  (`SHUTDOWN_GRACE_MS` minus 6 s), then it is aborted.

What each export reads before its first byte, then page by page:

| Export | Up front | Rows |
| --- | --- | --- |
| Registrations (GET, POST modular) | form_data keys (DISTINCT) | keyset, newest first |
| Event summary | counts only, aggregated in SQL | none |
| Access registrants | event + access items | per access item, keyset newest first |
| Sponsorships | every filtered row's sort key (lab, amount, date) | by id, 500 per chunk, in lab order (French collation, sorted in JS) |
| Check-in ZIP | event + access items | per sheet, keyset in submission order (checked-in half, then the rest) |
| Abstracts | filtered ids in list order + reviewer-column count | by id, 500 per chunk |

- **Check-in ZIP**: each workbook (global, then one per access item) is
  streamed to a file in a private `os.tmpdir()/focale-export-*` directory,
  then a stored (not re-deflated) ZIP of them is streamed into the response,
  with each entry's CRC-32 and size read from its file first. The directory is
  removed however the export ends (success, failure, client gone, shutdown);
  it needs a writable temp dir with room for one event's workbooks (roughly
  0.2 MB per 10,000 registrations per workbook). ZIP64 is not written: an
  export over 4 GB fails instead of producing a corrupt file.
- **Abstracts** go through `ExportDownloads` like the reports (503
  `EXPORT_BUSY` applies). A review assigned after the export started has no
  reviewer column (the column count is read up front).
- **Networking organizer XLSX** (`networking.exports.service.ts`) is written by
  the streaming writer into the response body as it is sent, and stops when
  the client leaves; its rows are still assembled in memory by the networking
  module, and it is not counted by the export limiter.
- **ExcelJS internals**: exceljs is pinned (4.4.0). The exports use two of its
  internals, the workbook's archiver (abandoned on abort) and each sheet's zip
  input (to pace rows); `xlsx-stream.test.ts` fails if an upgrade moves either.

Output parity: each streamed file reads back (ExcelJS, cell by cell: values,
types, styles, merges, filters, views, widths) like the in-memory builder it
replaced, on the same data (`*.parity.test.ts`, verbatim old builders in
`__testing__/`). Frontend changes: `FRONTEND_FOLLOWUP_3_7.md`.

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
