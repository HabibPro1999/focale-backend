# Focale OS backend

Event registration, sponsorship, abstracts and B2B networking platform. The active
`develop` code is a Node.js/pnpm workspace with two processes: a NestJS/Fastify
API and a background worker, using Drizzle on PostgreSQL or CockroachDB.
The root `Dockerfile` and generated `.env.example` belong to this workspace.
The legacy Bun, Fastify and Prisma application that production runs until the
cutover is kept at git tag `legacy-final` (main `0f86c91d`) for rollback and
reference.

- [Production cutover](#production-cutover): the one-time move from the legacy
  app, Render services, rollback, data repairs
- [Migrator](packages/db/src/migrator/README.md): ledger, adoption, production
  rollout, data safety per migration, writing a migration
- [@app/db](packages/db/README.md): concurrency control
- [Networking design and operations](docs/networking/README.md)
- [Continuous integration](#continuous-integration)

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
pnpm install --frozen-lockfile # install locked workspace deps
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

The legacy `src/scripts/setup-tshg-abstracts.ts` (tag `legacy-final`) was a
**one-time data-seeding artifact** for a specific event (TSHG themes +
deadlines). It is intentionally **not ported**: it ran once against that event
and has no ongoing role.

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
output-side types are the response `data` shapes. Pricing `rules` is typed
(`StoredPricingRulesSchema`, see Typed JSONB columns below). The form `schema`
stays opaque on purpose: its stored document is open (admin-authored keys
round-trip untouched) and a contract would drop them. The other stored JSON
documents (`formData`, access `conditions`, audit `changes`,
abstract `content`/`coAuthors`/`additionalFieldsData`) are opaque (`unknown`)
until they are typed. `priceBreakdown` uses the canonical `PriceBreakdownSchema`
(including optional `droppedAccessItems` and optional confirmation status). Covered routes:

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
| `GET /api/public/events/:slug/abstracts/config` | `PublicAbstractConfigResponseSchema` |
| `POST /api/public/events/:slug/abstracts/submit` | `AbstractSubmittedResponseSchema` |
| `GET` / `PATCH /api/public/abstracts/:id`, `POST …/final-file` | `PublicAbstractResponseSchema` |
| `POST /api/public/committee/invite/verify`, `…/set-password`, `…/resend` | `CommitteeInviteVerifyResponseSchema`, `CommitteeInvitePasswordSetResponseSchema`, `CommitteeInviteResendResponseSchema` |

Networking adds 74 JSON routes across organizer, participant, OTP/MFA and
recommendation controllers (`networking.*responses.ts`). Five raw download/SSE
routes skip the envelope explicitly. Their parity, privacy and coverage checks
live in `networking/networking.response-contracts.test.ts`. Other admin modules
not listed above remain outside this response-contract coverage.
`apps/api/src/modules/response-contracts.routes.test.ts` (with `abstracts/abstracts.response-contracts.routes.test.ts`)
checks that every enveloped route of the covered controllers has a contract.

### Typed JSONB columns (plan 5.2)

Five JSONB columns are typed with the document their write path stores, a
shared schema in `@app/contracts`: `event_pricing.rules`
(`StoredPricingRulesSchema`), `certificate_templates.zones`
(`StoredCertificateZonesSchema`), `forms.schema` (`StoredFormSchemaJsonSchema`,
registration or sponsor form) and `email_logs.context_snapshot`
(`StoredEmailContextSnapshotSchema`, template variables plus the internal
`_fallbackSubject`/`_fallbackPlainBody`/`_certificateTemplateIds` keys), plus
`registrations.price_breakdown` (`PriceBreakdownSchema`, the canonical pricing,
settlement and registration-response type). Public signup lines may carry
`status: "confirmed"`; dropped lines retain the line keys plus `reason`
`capacity_reached` or `deactivated`; older rows can omit `droppedAccessItems`.
`jsonbOf(schema)` (`packages/db/src/jsonb.ts`) types the column for reads and
writes. A stored value is valid when the schema accepts it and parsing changes
nothing (`checkStoredJson`: a missing defaulted key counts), so a valid value
already has the schema's output type.

The queries that hand these columns to callers check them at the read
boundary (`packages/db/src/queries/stored-json.ts`; the email send path checks
each claimed email's snapshot, so one bad row fails only that email).
`JSONB_VALIDATION` decides what an invalid document does: `warn` (default) logs
the column, row id and issue paths/codes once per process (never values) and
returns the value exactly as stored, as before typing; `enforce` throws
`StoredJsonError`. Rows returned by a write are not re-checked. The networking
query files read `forms.schema` without the check (typed only).
`price_breakdown` is checked by registration and sponsorship queries and the
settlement reads (settle, access drop, sponsorship link). Under `enforce`, an
invalid breakdown prevents settlement until fixed. Repair tools classify their
own invalid documents; whole-row reads that never use the breakdown (email and
certificate contexts, exports, networking) are typed only.

Before deployment, keep `JSONB_VALIDATION=warn` and run the read-only audit
`node apps/api/dist/scripts/stored-json-report.js` (from source:
`node --conditions=@app/source -r @swc-node/register src/scripts/stored-json-report.ts`
in `apps/api`). It pages through the five columns in READ ONLY transactions,
lists each invalid document by row id, path and code, counts them per column
and code, and changes nothing. Review incompatible rows before deployment:
response projection removes unknown pricing/breakdown fields even in `warn`.
Enable `enforce` only after the audit is clean.

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
in-handler checks, 5.4b), then networking organizer/recommendation routes
(28 more, 129 guarded routes total). `apps/api/src/modules/tenancy/tenant-scope.routes.test.ts`
lists each route's expected scope, sends a cross-tenant and a missing-resource
request to every one, and requires every other route of those controllers to
be listed as an in-handler check or as unscoped (with the reason). Networking
participant routes retain their separate session/eligibility policy. Shared
networking write queries now require an explicit executor; transaction callers
pass their transaction and external sync callers own the retry transaction.

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

- `TRUST_PROXY`: explicit proxy IP/CIDR list, or `false` for direct traffic
  (never behind Render: [Environment for the cutover](#environment-for-the-cutover)).
- `CORS_ORIGIN`: explicit origins only (no `*`, no paths).
- `ADMIN_APP_URL` (not the localhost default), `PUBLIC_FORMS_URL`,
  `PUBLIC_LINK_ALLOWED_ORIGINS`.
- The selected email provider's API key (`SENDGRID_API_KEY` or
  `RESEND_API_KEY`) and a sender (`EMAIL_FROM_EMAIL` or `SENDGRID_FROM_EMAIL`).
- `NETWORKING_TOKEN_SECRET` (32+ characters) or `NETWORKING_KEYS`, unless
  `NETWORKING_DISABLED=true`.

`FIREBASE_SERVICE_ACCOUNT` accepts raw JSON or base64 JSON;
`NETWORKING_EMAIL_SENDERS` must be a JSON object. The Firebase token lookup
fallback is off unless `FIREBASE_AUTH_LOOKUP_FALLBACK=true` and
`FIREBASE_WEB_API_KEY` are both set; there is no built-in key.

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

No auth, and **not** enveloped: each returns its raw body with the status code
probes rely on (503 when unhealthy, body unchanged). Only `/health/live` and
`/health/ready` are `@SkipThrottle`; the probes that query the database keep the
default limit (100/min per client IP and path in production, 1000 elsewhere)
and answer 429 past it.

| Path | Purpose |
|---|---|
| `GET /health/live` | Liveness: `{ "status": "ok" }`, no I/O, never fails. Use it as the platform health check (Render, image HEALTHCHECK). |
| `GET /health/ready` | Readiness: 200 `{ "status": "ready" }` when not draining, the database answers (ping cached 5 s) and the boot `MIGRATIONS_CHECK` found the schema current (or did not run). Otherwise 503 `{ "status": "not ready", "reasons": [...] }`, or 503 `{ "status": "draining" }` during shutdown. |
| `GET /health` | Legacy overall health: 200 `{ status: "healthy", timestamp, checks.database }`, 503 `unhealthy` when the DB ping fails (uncached). |
| `GET /health/worker` | Worker heartbeats (`worker_heartbeats`, written every 15 s): unhealthy when no enabled worker beat in the last 60 s, when only `RUN_WORKERS=false` workers are beating, or when a job has run past twice its timeout. Public body: `isHealthy`, `reasons` and `counts` (`live`, `disabled`, `overdueJobs`) only; per-worker and per-job detail stays in the table. |
| `GET /health/email-queue` | Email queue depth / staleness (unhealthy: stale sending, >1000 queued, or oldest queued >30 min). |
| `GET /health/abstract-book-jobs` | Book-job queue (unhealthy: stale running, >100 pending, or oldest pending >1 h). |
| `GET /health/outbox` | Outbox backlog (unhealthy: a row dead-lettered in the last 24 h, pending+failed ≥1000, oldest pending >10 min, or oldest processing >2× lease). `counts.deadLettered` is every dead letter still stored, `counts.deadLetteredLast24h` the ones that flag it; requeue them with `requeue-dead-letters` (below). |
| `GET /health/networking-vector-index` | Networking ANN index: unhealthy while an event above the exact-ranking limit ranks recommendations with the deterministic fallback (see `docs/networking/README.md`). |

## Deployment

Run **two deployables from one image**:

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

Outbox (background rows; the API pump drains the realtime ones, see below):
every 5 s a run claims batches of 20, handled one at a time, and keeps
claiming until the queue is empty or its drain window ends (the 60 s budget
minus 30 s for the batch in flight). Lease 5 min.

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
(`/api/networking/:slug/stream`, see docs/networking/README.md) only that process's
participant hub ([One API instance, one worker](#one-api-instance-one-worker)). The SSE
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
listed in `payload.ids` (`id` is the first). Intermediate statuses inside a
window are not sent, so a client takes the status in the event as the latest.

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
  the client leaves. CSV and XLSX read SQL pages of 500 rows after selecting
  export IDs in order.
  PDF still buffers the resulting rows. These exports are not counted by the
  report export limiter.
- **ExcelJS internals**: exceljs is pinned (4.4.0). The exports use two of its
  internals, the workbook's archiver (abandoned on abort) and each sheet's zip
  input (to pace rows); `xlsx-stream.test.ts` fails if an upgrade moves either.

Output parity: each streamed file reads back (ExcelJS, cell by cell: values,
types, styles, merges, filters, views, widths) like the in-memory builder it
replaced, on the same data (`*.parity.test.ts`, verbatim old builders in
`__testing__/`). For clients: a download is chunked without `Content-Length`
(show indeterminate progress, read the body to the end, and treat a broken body
as a failed export, never a partial file), and 503 `EXPORT_BUSY`
(`Retry-After: 10`) or `SRV_5003` during a deploy means retry.

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
  or run baseline SQL directly. In production the API and a job-running worker
  refuse to start on such a database whatever `MIGRATIONS_CHECK` says. The
  adoption rules, the boot check, the production rollout steps and what each
  migration does to existing data are in the
  [migrator README](packages/db/src/migrator/README.md).

Migration 0011 repairs saved net totals only when `priceBreakdown` proves the
old convention; it is safe to rerun, but on production it changes live totals
and needs a sign-off (migrator README, rollout step 4). `totalAmount` is gross
before sponsorship, while `priceBreakdown.total` is net.

## Production cutover

The one-time move of production from the legacy app (main at tag
`legacy-final`, 0f86c91d: Bun, Fastify and Prisma, background pollers inside
the web process) to this build: the API on the existing Render web service, a
new Render worker service, and the same CockroachDB database, adopted into the
migration ledger and brought forward by 29 migrations. The API wraps every
response in `{ok, data, requestId}` and legacy answers raw bodies: the admin
and form builds on `main` today cannot read the new API, while their `develop`
builds read both. So the frontends go first, and a backend rollback leaves them
in place. Nothing here is automated; "your decision" marks a production write
or a sign-off. The database steps are detailed in the
[migrator README, Production rollout](packages/db/src/migrator/README.md#production-rollout-operator-steps).

### Cutover order

**Before any merge (T-1, no production writes)**

1. Render: Auto-Deploy off on the web service. Vercel: confirm the production
   branch of admin and form (probably `main`) and control when production
   deploys. There is no `render.yaml`, so auto-deploy is dashboard state and a
   merge into `main` can itself be a production deploy.
2. A verified backup with a tested restore (CockroachDB backup and a restore
   drill). Rehearse on a restored copy, on the same CockroachDB version: the
   database steps, then boot the API and the worker of the release image
   against it (this also proves the image's `linuxmusl` sharp binary loads), and
   point local admin and form `develop` builds at it for a smoke test.
3. Render settings of the existing web service, which is redeployed in place
   (never create a new web service): Docker runtime; Docker Command override
   empty (a leftover `bun run src/index.ts` fails: the image is
   `node:24-alpine` without bun or `src/`); no legacy Pre-Deploy Command; no
   `APP`, `TZ` or `NODE_ENV` set on the service (the image sets
   `NODE_ENV=production`, which turns on the production config rules and the
   no-ledger boot guard, and `TZ=UTC`); health check path `/health/live`;
   exactly 1 instance, no autoscaling; `maxShutdownDelaySeconds` 30.
4. One Render Environment Group attached to the web service and the worker:
   every key production uses today (each still exists in the config schema)
   plus the keys in [Environment for the cutover](#environment-for-the-cutover).
   Keep `APP` and `RUN_WORKERS` out of the group: they differ per service.
5. Create the worker: a Render Background Worker on the same repository and
   `Dockerfile`, built from the branch that holds this build (`develop` until
   the backend merge, then `main`), Auto-Deploy off, `APP=worker`,
   `RUN_WORKERS=false`, `maxShutdownDelaySeconds` 30, the environment group.
   With `RUN_WORKERS=false` it idles: no jobs and no boot check. From its shell,
   `node packages/contracts/dist/cli/check-config.js` must exit 0.
6. Read-only checks, from the worker's shell or a built checkout with the
   production `DATABASE_URL`:
   - Preflight: `node packages/db/dist/ops/cutover-preflight-cli.js preflight --out <dir>`.
     `<dir>` must be new or empty and receives personal data (`affected/*.json`:
     registration and abstract ids, sponsorship codes, amounts): keep it on
     restricted storage (a Render shell's disk does not survive a restart, so
     copy it out), share it only with the people who sign off, delete it after
     the cutover is accepted. Review `report.md`: every blocker (exit 1) must be
     cleared; decide each review item: the 0011 rows (sign-off), 0004 and 0030
     duplicates, jobs in flight, sponsored `VERIFYING` registrations (reconcile
     `paid_count` by hand), the form origins for `PUBLIC_LINK_ALLOWED_ORIGINS`
     and the CockroachDB settings.
   - CockroachDB, as the `DATABASE_URL` user: `SELECT version();`,
     `SHOW CLUSTER SETTING version;`, `SHOW CLUSTER SETTING feature.vector_index.enabled;`,
     `SHOW CLUSTER SETTING sql.txn.read_committed_isolation.enabled;` (`apply`
     stops at 0017 when the vector setting cannot be read; READ COMMITTED must
     be enabled, [@app/db](packages/db/README.md#concurrency-control)), plus the
     `autocommit_before_ddl` and `schema_locked` checks of the migrator README,
     step 1.
   - The Firebase certificate fetch, the proxy peers for `TRUST_PROXY` and
     whether a CDN fronts the API host ([below](#environment-for-the-cutover)).
   - The SendGrid Event Webhook (`/webhooks/sendgrid`) includes the
     **Processed** event (Resend: `email.sent`); it moves an `UNCERTAIN`
     email to `SENT`.
   - Whatever posts check-ins to `POST /api/events/:eventId/checkin/sync` sends
     `scannedAt` with seconds: the zod 4.6 update refuses minute precision
     (`2026-10-30T10:15Z`) with 400; legacy accepted it. Browser
     `toISOString()` always has seconds.
   - Optional: `node apps/api/dist/scripts/email-template-style-preflight.js`
     reports, per email template, the text-align, font-size and line-height
     attributes it would remove or normalize and the templates that need a
     manual review (dry run by default; `--apply` rewrites them, your
     decision).

**Frontends first (the same day as the backend window)**

7. Merge form `develop` into `main` and wait for the Vercel production deploy.
   Against the live legacy API: load a public form, open an existing payment
   link, edit link and abstract link, and submit one test registration.
8. Merge admin `develop` into `main` and deploy. Log in as a super admin and
   as a client admin; open registrations. From now until the API switch,
   freeze what admin `develop` cannot do on the legacy API: saving email
   templates and certificate templates and sending abstract presenter
   certificates answer 400, and the networking pages 404. The abstract bulk
   send works on both APIs. Once the API is switched, never promote the old
   frontend builds again (form `307fcf3`, admin `fa67663`).

**Backend window (maintenance, off-peak)**

9. Pause public registrations if you can: a registration the legacy API writes
   after `apply` keeps the old net total (step 15).
10. Stop the legacy background work: `RUN_WORKERS=false` on the legacy web
    service (legacy honors it, `src/worker-runtime.ts:45` at `legacy-final`)
    and suspend any separate legacy worker. Then repeat this drain query until
    every count is 0 (the preflight's queue section reports the same):

    ```sql
    SELECT 'email_logs SENDING' AS queue, count(*) FROM email_logs WHERE status::text = 'SENDING'
    UNION ALL SELECT 'outbox_events PROCESSING', count(*) FROM outbox_events WHERE status::text = 'PROCESSING'
    UNION ALL SELECT 'abstract_book_jobs RUNNING', count(*) FROM abstract_book_jobs WHERE status::text = 'RUNNING';
    ```

    A row left claimed is recovered by the Nest worker once its lease expires:
    the outbox row or book job runs again, and a `SENDING` email is requeued
    and sent again (legacy never set `provider_attempted_at`, so it is not
    parked as `UNCERTAIN`). Check the provider's activity for such an email and
    decide it before the Nest worker starts (your decision).
11. Migrations, before any Nest code serves, from the idle worker's shell (or a
    built checkout with the production `DATABASE_URL`), as the migrator README
    describes: preflight again into a new directory (the postflight baseline);
    `adopt` (dry run: 0000 `baseline`, no `ABORT` verdict, no `error:` line);
    `adopt --apply`; the 0011 sign-off from `affected/0011.json` and the
    over-quote query; the 0004 and 0030 prechecks; `apply --dry-run`;
    `apply --yes`; `verify --schema` (no errors; a deferred 0017 or 0030 is a
    warning); `postflight --baseline <dir>/table-counts.json`. Then
    `node apps/api/dist/scripts/stored-json-report.js` (read-only, keep
    `JSONB_VALIDATION=warn`): it should end with "Every typed JSON document
    matches its schema". Review any invalid document before the API serves:
    response projection drops undeclared pricing and breakdown fields even
    under `warn`. Turn on `enforce` only once the report is clean.
12. On both services: `MIGRATIONS_CHECK=enforce` (in the group) and the
    Pre-Deploy Command
    `node packages/contracts/dist/cli/check-config.js && node packages/db/dist/migrator/cli.js apply --yes`.
13. Merge backend `develop` into `main` (develop already contains main, so
    there is nothing to resolve) and point the worker at `main`. Unset
    `RUN_WORKERS` on the worker and deploy it; its log shows `worker started`.
    Then deploy the API by hand. The worker goes first so that the API's first
    outbox rows and emails are handled at once; on every later deploy too, the
    worker must know a new job type before the API enqueues it (an older
    worker retries an unknown `networking.registration.sync` for about 1¾
    hours, then dead-letters it).
14. Smoke tests: `/health/live`, `/health/ready`, `/health/worker`,
    `/health/outbox` and `/health/email-queue` answer 200 (watch
    `uncertainCount`); a test registration, a payment link, an abstract
    submission, one email delivered, one abstract bulk send to a test template,
    and one certificate preview per active template with a date zone (dates
    change language, below). Ask staff to hard-reload every open admin tab.
15. Re-run the 0011 predicate (migrator README, step 4). A row it returns was
    written by the legacy API after `apply` in the old net convention: put it
    on the same sign-off list and repair it by hand (0011 does not run again).
16. Afterwards: [After the cutover](#after-the-cutover), the
    [data repairs](#data-repairs), and Auto-Deploy back on.

Behavior that changes for users at the switch:

- Certificate dates follow the primary language of the registration form (or
  of the abstract config), French by default, Arabic printed in French
  (`packages/integrations/src/certificates-pdf.ts:120-121`); legacy always
  printed them in English (`src/modules/certificates/certificate-pdf.service.ts:53`
  at `legacy-final`). Abstract bulk-send dates follow the abstract config's
  language the same way.
- Registrations repaired by 0011 now show the net amount they were quoted
  instead of 0 due; the over-quote rows show more (migrator README, step 4).

### Environment for the cutover

`node packages/contracts/dist/cli/check-config.js` validates a service's
environment with the production rules and prints only failing key names. An
environment that boots legacy fails three of them: `TRUST_PROXY`,
`PUBLIC_LINK_ALLOWED_ORIGINS`, and `NETWORKING_TOKEN_SECRET` /
`NETWORKING_KEYS` unless `NETWORKING_DISABLED=true`. Production also needs
`ADMIN_APP_URL` (not the localhost default), `PUBLIC_FORMS_URL`, the email
provider key and a sender (`EMAIL_FROM_EMAIL` or `SENDGRID_FROM_EMAIL`),
`FIREBASE_STORAGE_BUCKET` with Firebase storage, and a `CORS_ORIGIN` listing the
real admin and form origins. The worker parses the same configuration whatever
its `APP`, hence the shared group. Also set:

- **`MIGRATIONS_CHECK=enforce`**, `JSONB_VALIDATION=warn` (the default) until
  the stored-JSON report is clean, and `REALTIME_DISABLED` with one value for
  both services.
- **`FIREBASE_AUTH_LOOKUP_FALLBACK=true` and `FIREBASE_WEB_API_KEY`.** When the
  Admin SDK cannot fetch Google's x509 keys (Google has blocked that fetch from
  the Render egress before), admin and committee sign-in fails unless the
  fallback is on; it then verifies tokens through Identity Toolkit
  `accounts:lookup`. Legacy always fell back, with a built-in key; this build
  falls back only with both keys set, refuses to boot with the flag and no key,
  and has no built-in key. `FIREBASE_WEB_API_KEY` is the project's Web API key,
  the public identifier the admin app's Firebase config also ships. The
  fallback runs only when the fetch fails; on that path a revoked token stays
  accepted for up to 5 minutes (lookup cache). To see whether the block still
  applies, run
  `bun -e "fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com').then(r=>console.log(r.status))"`
  in the current web service's Render shell (`node -e` with the same script in
  the new worker's shell): 200 means not blocked, 403 means the keys are
  mandatory. Legacy logs nothing when its fallback succeeds, so its logs prove
  nothing.
- **`PUBLIC_LINK_ALLOWED_ORIGINS`**: comma-separated exact origins,
  `scheme://host[:port]`, no path, query or wildcard (a trailing `/` is
  dropped; a default port is left out). Public registrations and abstract
  submissions whose `linkBaseUrl` origin is not listed are refused with 422
  `VAL_2001` "linkBaseUrl origin is not allowed". `www` and the apex, or a
  custom domain and its `*.vercel.app` address, are different origins. Start
  from the form's production domains, then add every origin in the preflight
  report's link origins (the `link_base_url` of registrations and abstracts,
  with counts and last use) that is still in use, for example
  `https://forms.example.com,https://www.forms.example.com`.
- **`TRUST_PROXY`**: comma-separated IPv4 or IPv6 addresses or CIDRs of the
  proxies that connect to the API (prefix 1 to 32 or 128). `true`, `*`, a hop
  count, a hostname, an empty entry and `/0` are refused. `false` means
  clients connect directly: never set it behind Render, or every client gets
  the proxy's address, shares one rate-limit bucket per route (100/min by
  default, less on public registration and edit routes) and is recorded in
  `audit_logs.ip_address` as the proxy. Find the peers in the current web
  service's Render shell with `netstat -tn | grep ":$PORT "` (the foreign
  addresses) and list their range; add the ranges of any CDN or proxied custom
  domain in front of the API, or that hop becomes the client address. Check it
  24 hours after the cutover:
  `SELECT ip_address, count(*) FROM audit_logs WHERE performed_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC LIMIT 20;`
  one dominant address means the value is wrong.
- **`NETWORKING_TOKEN_SECRET`** (at least 32 characters,
  `openssl rand -hex 32`; never replace it once used, rotate with
  `NETWORKING_KEYS` as in [Key rotation](docs/networking/README.md#key-rotation)),
  or `NETWORKING_DISABLED=true` where no event uses networking (participant
  authentication then answers 503).
- `NETWORKING_EMAIL_RATE_PER_SECOND` (default 5, per worker process) below the
  email provider account's limit, with room for the other emails; Resend's
  default of 2 per second per team is below it.

Keys added by the remediation batches (`.env.example` describes every key):

| Key | Service | Default | What it does |
|---|---|---|---|
| `SHUTDOWN_GRACE_MS` | both | 25000 | shutdown budget per process ([Shutdown](#shutdown-shutdown_grace_ms-default-25-s)) |
| `WORKER_HEARTBEAT_FILE` | worker | `<os tmpdir>/focale-worker.heartbeat` | liveness file read by the image HEALTHCHECK |
| `NETWORKING_DISABLED` | both | `false` | `true` where no event uses networking |
| `NETWORKING_KEYS`, `NETWORKING_KEYRING_WRITE_V1` | both | unset, `false` | networking keyring and its v1 write format |
| `NETWORKING_WITHDRAWAL_ERASE_DAYS` | worker | 30 | days after a withdrawal before maintenance erases the rest |
| `NETWORKING_DELIVERY_BATCH_SIZE`, `NETWORKING_DELIVERY_CONCURRENCY`, `NETWORKING_DELIVERY_OTP_LANES` | worker | 10, 6, 2 | networking delivery lanes |
| `NETWORKING_EMAIL_RATE_PER_SECOND` | worker | 5 | networking emails per second per worker process |
| `EXPORT_MAX_CONCURRENCY`, `EXPORT_MAX_QUEUED` | api | 2, 4 | report and abstracts exports running and waiting (30 s), then 503 `EXPORT_BUSY` |
| `RENDER_SERVICE_NAME` | worker | set by Render | names the worker's `worker_heartbeats` row |

The API also needs a writable temp directory for the check-in ZIP export
(`os.tmpdir()`, about 0.2 MB per 10,000 registrations per workbook; the
image's `/tmp` is writable by `node`).

### If networking launches

Networking has never been deployed. Production gets its tables (empty) from the
cutover's `apply` either way. Before a first event uses it:

- A new Vercel project for the participant PWA, with an absolute `VITE_API_URL`
  (its build refuses without one) and security headers in its `vercel.json`;
  its origin in `CORS_ORIGIN`; `PUBLIC_NETWORKING_URL` on both services;
  `VITE_NETWORKING_URL` in the form and `VITE_NETWORKING_BASE_URL` in the admin.
- `NETWORKING_TOKEN_SECRET` (not `NETWORKING_DISABLED=true`), the email rate
  above, and optionally `NETWORKING_EMBEDDING_API_KEY` (rules-based fallback
  without it) and the `NETWORKING_VAPID_*` push keys
  ([services and configuration](docs/networking/README.md#services-and-configuration)).
- On CockroachDB, 0017 builds the vector index when `feature.vector_index.enabled`
  is on; when it was deferred, build it in a maintenance window
  ([vector index runbook](docs/networking/README.md#vector-index-health-and-runbook-cockroachdb)).
- Activate the event as in [Event activation](docs/networking/README.md#event-activation),
  then check that a registration or payment update reaches its networking
  profile, that a full-event sync runs to completion and that no sync dead
  letter remains; smoke-test incoming-interest pagination, organizer lists and
  calendar, CSV and XLSX exports, OTP and MFA sign-in, recommendations, chat,
  meetings and participant privacy.

### Rollback (backend only)

There are no down migrations: a rollback runs the legacy app on the migrated
schema. Every column legacy Prisma reads or writes is still there (the added
ones are nullable or defaulted, and no migration drops a legacy column), and
0033 does not block it: main declares `abstract_code_sequences` only as a Prisma model
(`prisma/schema.prisma:914-921` at `legacy-final`) and no legacy source file
queries it. No database restore is needed.

1. Suspend the Nest worker.
2. `SELECT status, count(*) FROM email_logs GROUP BY 1;` Decide each `UNCERTAIN`
   row as `SENT` or `FAILED` (your decision): legacy Prisma throws on that enum
   value (0028), so the admin email-log pages that hold one answer 500.
3. Remove the Pre-Deploy Command and `MIGRATIONS_CHECK` from the web service:
   the legacy image has no migrator.
4. Render rollback of the web service to the last legacy deploy; unset
   `RUN_WORKERS` there so legacy runs its pollers again. They throw
   `Unknown outbox event type` on outbox rows only this build writes (legacy
   handles `email.triggered`, `email.abstract` and `email.sponsorship`,
   `src/core/outbox/handlers.ts:24-49` at `legacy-final`).
5. Keep the frontends: their `develop` builds work on legacy, with the freeze of
   step 8 again.

### Render services and every deploy

Both services run the image built from `Dockerfile` (`node:24-alpine`,
`TZ=UTC`, `NODE_ENV=production`, user `node`, CMD `node start-runtime.mjs`)
and read the same environment. `APP=all` runs both processes in one container;
it is not the Render layout.

| | API | Worker |
|---|---|---|
| Render service type | web service | background worker |
| `APP` | `api` (the default) | `worker` |
| Instances | exactly 1 ([one API instance](#one-api-instance-one-worker)) | 1 |
| Health check path | `/health/live` | none; watch `GET /health/worker` on the API |
| `maxShutdownDelaySeconds` | 30, set explicitly | 30, set explicitly |
| Pre-Deploy Command | config check + `apply --yes` | the same |

Every deploy, worker first and then the API: the image is built; the Pre-Deploy Command validates the
service's environment and applies pending migrations under the migration lease
(the two services' pre-deploys run one after the other), recording a
deferrable migration whose `defer-unless` check is false as `deferred`; a
failure stops the deploy before any instance switches and the previous release
keeps serving. Each process then runs the boot check before it listens (API)
or starts its jobs (worker). Render switches traffic once `/health/live`
answers and sends the old instance SIGTERM. The previous release is still
serving while the Pre-Deploy Command runs, and a rollback runs old code on the
new schema (ledger rows newer than the build only warn at boot), so every
migration must work with the code before and after it
([expand and contract](packages/db/src/migrator/README.md#expand-and-contract)).

Deferred migrations block nothing: the boot check and `verify` only warn, and
`/health/ready` stays 200. **0017** (CockroachDB vector index) is deferred while
`networking_embeddings` has rows or `feature.vector_index.enabled` is off;
**0030** (one registration per event and sponsorship code) while two
registrations of an event store the same normalized code (finish it in
[Data repairs](#data-repairs)). The migrator commands are listed in the
[migrator README](packages/db/src/migrator/README.md); in the image they run
from `/app` as `node packages/db/dist/migrator/cli.js <command>`, and the
ledger records `MIGRATIONS_APPLIED_BY`, else `RENDER_SERVICE_NAME`.

Keep `/health/live` the only Render health check: the other probes fail on
database, queue or worker trouble that replacing the API does not fix. Point
monitors at them instead ([Health endpoints](#health-endpoints-api)), well
under their limit of 100 requests per minute per client IP and path (every 30
to 60 s); a wrong `TRUST_PROXY` puts every monitor in the proxy's bucket.

The worker is required: the API runs no background work. While the worker is
stopped, crash-looping or idle (`RUN_WORKERS=false`, `/health/worker` 503):

| Job | Every | Stops working |
|---|---|---|
| `outbox` | 5 s | automatic emails are never queued (registration, sponsorship and abstract triggers); capacity drops; networking projections; networking photo deletions |
| `email-queue` | 5 s | no queued email is sent |
| `lease-recovery` | 30 s | rows leased by a worker that died stay leased; only the worker recovers them |
| `retention` | 1 h, and at boot | `realtime.emit` rows, finished outbox rows and old email snapshots are never cleaned up |
| `abstract-book` | 30 s | Abstract Books are not generated |
| `networking-delivery` | 1 s, in lanes | sign-in codes, notices and digests are not delivered |
| `networking-maintenance` | 60 s | retention purges and withdrawal erasure do not run |
| `networking-embeddings` | 15 s | new and changed profiles are not embedded |

### One API instance, one worker

Run exactly one API instance and one worker instance. Realtime fan-out, rate
limits and a few caches live in the API process; keeping them there and
documenting the limit was a deliberate decision of the remediation plan. With
two API instances:

| State | Code | With two instances |
|---|---|---|
| Admin realtime bus and replay rings (500 events per tenant), SSE ids from a per-process counter | `apps/api/src/modules/realtime/bus.ts` | each instance's pump claims part of the realtime rows and emits them only to its own `/api/stream` clients; a `Last-Event-ID` from one means nothing to the other |
| Realtime pump (`realtime.emit`, `networking.notify`, every second) | `apps/api/src/modules/realtime/realtime.pump.ts` | the same split |
| Networking notification hub | `apps/api/src/core/networking-notification-hub.ts` | a participant on the other instance waits for the 60 s resync |
| Participant stream limit (3 per session) | `apps/api/src/modules/networking/networking.stream.ts` | applies per instance |
| Throttler storage (global per-IP limit, venue buckets, session quotas) | `apps/api/src/core/core.module.ts`, `networking-throttler.guard.ts` | limits up to N times higher, each counting from zero |
| Networking verified-bearer cache and invalid-bearer lockout | `apps/api/src/core/networking-identity-cache.ts` | lockouts and evictions reach one instance (rate limiting only; sessions are checked on every request; OTP failure sums are in the database) |
| Export limiter | `apps/api/src/core/exports/stream-download.ts` | N times as many exports at once |
| Admin user cache (60 s) | `apps/api/src/core/auth/user-cache.ts` | a role change or deactivation reaches the other instance only after up to 60 s |

Safe to duplicate (memory or short staleness only): the certificate image LRU
(64 MB per worker), the networking recommendation cache (30 s), the networking
sender verification (5 min), the vector index presence check (60 s) and the
Firebase lookup fallback cache (5 min). During a deploy two API instances run
for a few seconds; clients reconnecting to the new one get
`event: replay-gap` and refetch, which is accepted. A second worker would not
process a queue row twice (leases and `FOR UPDATE SKIP LOCKED`), but it doubles
the networking email rate and the certificate cache, and retention,
maintenance and lease recovery were not reviewed for running in parallel.
Scaling out needs, at least, a shared realtime bus with shared ids and replay,
shared throttler storage, cross-instance user-cache invalidation and a
cluster-wide export limit; none is planned.

### After the cutover

- `/health/worker`, `/health/outbox` and `/health/email-queue` stay 200; watch
  `uncertainCount`.
- Certificate render images for templates uploaded before 0032:
  `backfill-certificate-renders` dry run, then `--apply`, then look at real
  certificates from those templates.
- Smoke-test capacity edits against current paid counts and prerequisite
  changes: concurrent writes re-read locked rows and a losing invalid change is
  refused.
- Check the admin's tenant and module refusals: a disabled module answers 403
  `CLT_20002`, an inactive client 403 `CLT_20001` (admin `develop` translates
  both).
- The first retention run clears the context snapshot of finished emails
  queued more than 90 days ago and compacts finished outbox rows older than 30
  days; nothing visible in the product.
- `TRUST_PROXY` audit-log query after 24 hours (above).
- On CockroachDB with 0017 deferred, build the vector index in a maintenance
  window if networking needs it.

### Data repairs

Each is a dry run, then the user's sign-off, then the apply, after a verified
backup. In the image: `node apps/worker/dist/scripts/<name>.js`; from a
checkout: `pnpm --filter @app/worker <name>`.

- **Sponsorship codes (2.7).** `repair-sponsorship-code-usages` dry run
  (planned links and a decision list); the user decides each decision-list row
  and clears the losing or unknown codes with
  `--clear-code --registration <id>... --apply`; a new dry run; then
  `--apply --all` (or `--registration <id>...`) for the links. Once no event
  stores a code twice, run 0030's `defer-unless` query by hand (it must return
  true; `--apply-deferred` skips it):
  `SELECT NOT EXISTS (SELECT 1 FROM registrations WHERE NULLIF(upper(trim(sponsorship_code)), '') IS NOT NULL GROUP BY event_id, NULLIF(upper(trim(sponsorship_code)), '') HAVING count(*) > 1);`,
  then `node packages/db/dist/migrator/cli.js apply --apply-deferred=0030 --yes`.
- **PAID settlement (2.4).** `repair-paid-settlement --since <cutover time, ISO>`
  dry run writes `repair-manifest.json`; the user sets each row's action in
  `approved.json`; `--apply --manifest approved.json`; then
  `repair-paid-settlement invariants` ([PAID data repair](#paid-data-repair-repair-paid-settlement-plan-24)).
  On legacy data the invariants do **not** end empty after these repairs:
  every registration an admin linked to a sponsorship on legacy keeps a price
  breakdown without that sponsorship (`SPONSORSHIP_TOTAL_MISMATCH`; legacy's
  link never wrote it), and each over-quote row of the 0011 sign-off reports
  `SPONSORED_NOT_COVERED`. Their money columns are right. One settlement write
  per row clears them, but no script does it and it changes what a sponsor's
  usage records: decide per row (your decision) or keep them as known rows.
- Sponsored `VERIFYING` registrations (the preflight counts them): while one is
  under review its sponsorship-covered seats stay reserved, and confirmation
  adds only the uncovered seats. If the preflight reports any, reconcile their
  access items' `paid_count` by hand before relying on capacity figures.

### When needed

- Networking key rotation (`NETWORKING_KEYS`, `NETWORKING_KEYRING_WRITE_V1`,
  the `networking-keyring` script): [Key rotation](docs/networking/README.md#key-rotation).
- Networking retention leftovers (`networking-retention purge-leftovers |
  erase-withdrawn | orphan-photos`; `--apply` needs `--backup-verified`):
  [Retention operator scripts](docs/networking/README.md#retention-operator-scripts).
- Dead-lettered outbox rows: `requeue-dead-letters` ([Worker jobs and heartbeat](#worker-jobs-and-heartbeat)).

### Main's features on this build

Main's commits up to `8cdbd52` were reviewed and their behavior ported into
the Nest workspace (a semantic port, not a merge of the legacy app). Main
itself, at `0f86c91d`, was then merged into develop (`91377a6c`), which put
main's legacy application changes (including the Prisma migrations
`20260806000000_add_multilanguage_forms` and
`20260814000000_add_committee_invite_tokens`) into the tree as reference, now
kept only at `legacy-final`,
and the one feature main had added since, the abstracts bulk send of
`0f86c91d`, was ported too.

| Main commits | On this build |
|---|---|
| `9c1adde`, `f221245` | Auth verification failures logged; the Identity Toolkit fallback when the public-key fetch fails, keeping the disabled-user and revocation checks, with a 10 s timeout. **Opt-in here**: `FIREBASE_AUTH_LOOKUP_FALLBACK=true` plus `FIREBASE_WEB_API_KEY`, with no built-in key ([Environment for the cutover](#environment-for-the-cutover)). |
| `73be63e` | Author affiliation up to 500 characters, co-author names up to 200, co-author affiliation up to 500; validation failures logged without request bodies. |
| `5041fde`, `24a1a04` | `in` conditions, contradiction detection, option-id validation on pricing and access saves; unchanged legacy pricing conditions are grandfathered. |
| `e27a103`, `e5ad53d` | French, English and Arabic translations for form fields, options, steps, sponsor summaries, success text, abstract themes and language settings; editable multilingual registration-fee label (0007). |
| `1706f6d` | Check-in columns as timestamptz (0010; production's TIMESTAMPTZ(6) columns are adopted as they are). |
| `25bf7fd`, `3043a84` | Hashed committee invite tokens with a configurable lifetime (`COMMITTEE_INVITE_TOKEN_TTL_DAYS`, default 7), single-use claims, public verify, set-password and resend routes; `ADMIN_APP_URL` is the base of the `/committee/set-password` link (0008, 0009). |
| `660c87f` | Effective presentation-type filter (final decision, else requested type) and the unpaginated abstracts XLSX export. |
| `30dcc52`, `8cdbd52` | Undated access and every ADDON use `addonGroup.slots` (the options response changes from `addonGroup.items`); same-type exclusivity; optional required-selection enforcement. |
| `0f86c91d` | Template bulk send to abstract authors (audience `abstracts`, `abstractIds` or `abstractFilters`, `dedupeByEmail` default true, `skipped` in every audience's response), behind the abstracts module gate, one queued log per author with its abstract id and a context snapshot. Snapshot dates follow the abstract config's language; legacy used English. |

Develop-only behavior kept alongside: Tunisia-local access date buckets,
committee account eligibility and cross-client password-reset restrictions,
abstract deadline and theme validation, configured invite templates and email
logs.

### Open frontend follow-ups

<!-- open-frontend-followups: filled by the lead from the follow-up audit -->

## Testing and environment safety

`pnpm test` runs mocked unit tests; `pnpm test:runtime` covers launch/health and
repository rules. Unit tests use `.env.test` when present and safe defaults,
never `.env`, and force a dummy local database URL. Keep real credentials out
of repository files; examples contain local placeholders only.

DB-backed tiers are explicit and guarded. Create a disposable maintenance database with an exact `test` or `ci` token in its name, then set `TEST_DB_ADMIN_URL`. Root `test:db` runs every package's database suite sequentially, including API networking and integration notification-worker coverage; performance experiments stay outside this default tier. The helper creates a fresh migrated scratch database for every test file and removes it afterward. PostgreSQL clones a per-run migrated template; CockroachDB uses fresh per-file databases because the pinned 26.2.5 release does not support database template cloning. Stale helper-owned scratch databases older than 24 hours are removed at suite startup.

```bash
# DB integration tier
ALLOW_DB_TESTS=1 TEST_DB_ADMIN_URL='postgresql://postgres:...@127.0.0.1:5432/focale_test_admin' pnpm test:db

# Real-DB concurrency tier
ALLOW_DB_TESTS=1 TEST_DB_ADMIN_URL='postgresql://postgres:...@127.0.0.1:5432/focale_test_admin' pnpm test:concurrency

# Migration tier against a separate disposable database
ALLOW_DB_TESTS=1 TEST_DB_ADMIN_URL='postgresql://postgres:...@127.0.0.1:5432/focale_test_admin' pnpm test:migration
```

Use `.env.test.example` only for unit-safe overrides and `.env.test.db.example` for all DB tiers. The tests do not load `.env` or `.env.test.db`; set variables explicitly or source the example in your shell. Keep values local/disposable; never use production or shared development credentials.

## Continuous integration

The `CI` workflow runs on PRs into `develop`, pushes to `develop` and manual
dispatch; it never runs on `main`. Its planner reads the full PR diff (merge
base to head) or the complete push range, without GitHub's path-filter limits;
deleted files and both sides of a rename count, and missing history or an
unknown path selects every check.

| Change | Checks selected |
|---|---|
| Root Markdown, or Markdown and images under `docs/`, only | planner tests and the required gate; no install, build or database |
| Workspace unit tests or ESLint rules and config only | static checks |
| Database, concurrency or migration test files only | static checks plus that tier on both engines |
| API, worker or integration source; DB queries, settlement, policy, outbox, lease queue or operational code | static checks plus the database and concurrency tiers on both engines |
| Migrations, schema, DB connection or test infrastructure, shared and contracts packages, dependencies, launchers and container, CI, any other path | all 12 checks, the planner and the gate |
| Manual run | all checks |

Mixed changes take the union. The static job keeps typecheck, lint, build, the
generated-artifact checks, unit and runtime tests and the dependency audit
(`pnpm audit --prod --audit-level=high`); the DB tiers keep both engines, their
shards, one database per test file and the safety guards. `CI / required` is
the stable aggregate: it runs even after another job fails and accepts only
success from selected jobs, CockroachDB included. New commits cancel older runs
of the same PR; push and manual runs stay independent. Timeouts: planner and
gate 5 minutes, static and image 20, DB tiers 45. The `CI / plan` job writes a
"CI selection" summary with a run or skip decision per tier; skipped jobs
install, build and start nothing.

```bash
node --test scripts/ci-plan.test.mjs
actionlint .github/workflows/ci.yml
gh workflow run ci.yml --ref develop # full suite, explicitly requested
```

New runtime directories get full coverage until a narrower, tested rule exists.
Skipping is done per job: a workflow-level `paths-ignore` would leave required
checks pending.
