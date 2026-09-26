# B2B Networking

The networking module shares Focale’s NestJS API, Drizzle database, registration records, storage and email providers. Organizers configure it in the existing **admin develop** app. Participants use the separate `../networking` PWA. Registration forms offer a profile preview and networking participation choice.

Implementation status and requirement verification are tracked in [NETWORKING_IMPLEMENTATION.md](NETWORKING_IMPLEMENTATION.md). An implementation checklist is not proof of production readiness; verification and provider/performance boundaries are summarized in [NETWORKING_QA.md](NETWORKING_QA.md).

## Services and configuration

Run the API and worker as separate processes, using the same database and networking secrets. Add both the admin/form origins and the participant PWA origin to `CORS_ORIGIN`.

| Environment variable | Purpose |
| --- | --- |
| `PUBLIC_NETWORKING_URL` | Public PWA base URL used in registration and notification links. Local development: `http://localhost:8082`. |
| `NETWORKING_TOKEN_SECRET` | At least 32 characters of cryptographically random secret material: the keyring's `legacy` key. Used for participant authentication and sealed secrets. Rotate it with `NETWORKING_KEYS` (see [key rotation](#key-rotation)), never by replacing it. |
| `NETWORKING_KEYS` | Keyring: `kid:key` entries separated by commas, the first one current; `kid:key:recovery` keeps a retired key for existing recovery codes only. In production this or `NETWORKING_TOKEN_SECRET` is required unless `NETWORKING_DISABLED=true`. |
| `NETWORKING_KEYRING_WRITE_V1` | `true` writes new session hashes, OTP hashes, badges, sealed codes/secrets and recovery codes as `v1:<kid>:…` with the first `NETWORKING_KEYS` key. `false` (default) keeps the legacy format while `NETWORKING_TOKEN_SECRET` is set. |
| `NETWORKING_EMBEDDING_API_KEY` | Credential for the embedding provider; falls back to `OPENAI_API_KEY`. Server-side only. |
| `NETWORKING_EMBEDDING_MODEL` | Defaults to `text-embedding-3-small`. The configured model must accept1536-dimensional output. |
| `NETWORKING_EMBEDDING_BASE_URL` | Defaults to `https://api.openai.com/v1`; an HTTPS OpenAI-compatible endpoint is supported. |
| `NETWORKING_VAPID_PUBLIC_KEY` | Browser push application-server public key. |
| `NETWORKING_VAPID_PRIVATE_KEY` | Browser push private key; keep server-side. |
| `NETWORKING_VAPID_SUBJECT` | Contact URI for the push sender, such as a `mailto:` URI. |
| `NETWORKING_EMAIL_SENDERS` | Optional server-owned client-to-verified-sender JSON map; see [delivery setup](packages/integrations/src/networking/README.md). |
| `NETWORKING_DELIVERY_BATCH_SIZE` / `NETWORKING_DELIVERY_CONCURRENCY` / `NETWORKING_DELIVERY_OTP_LANES` | Worker delivery lanes: rows per claim (default 10), general lanes (default 6), dedicated sign-in code lanes (default 2). See [delivery lanes](packages/integrations/src/networking/README.md). |
| `NETWORKING_EMAIL_RATE_PER_SECOND` | Networking emails per second per worker process (default 5; token bucket, sign-in codes first, 429 backoff). Keep it under the email provider account's limit, leaving room for the platform's other emails. |
| `TRUST_PROXY` | Comma-separated IP/CIDR addresses of trusted reverse-proxy peers whose forwarded headers may be used. **Required in production** (startup fails without it); set the literal `false` only when clients connect directly without a proxy. Unset outside production = socket address. Replace old numeric hop-count values with actual proxy peer addresses from deployment network configuration; numeric hops, `true`, wildcard trust, hostnames, and `/0` networks are rejected. |
| `RESEND_DOMAIN_READ_API_KEY` / `SENDGRID_DOMAIN_READ_API_KEY` | Optional server-side domain-read credentials for custom sender verification. |
| Existing `EMAIL_PROVIDER` and provider credentials | Networking uses the same configured email delivery provider as the platform. |

The PWA uses `VITE_API_URL` (including `/api`) and optionally `VITE_EVENT_SLUG`. The registration form uses `VITE_NETWORKING_URL` as a fallback when the public networking response has no application URL. Secrets must never appear in `VITE_*` variables.

A missing embedding credential leaves the participant directory usable with an explicitly labeled rules-based fallback. It does not generate synthetic vectors or pretend semantic recommendations succeeded. OTP delivery requires a configured email provider. Push requires HTTPS/secure-context installation support and participant permission; provide the in-app notification experience on unsupported devices.

## Database migration

Existing databases must already have the platform baseline through 0011 applied. The unified runner refuses to run against an existing database without its ledger; adopt the existing history first with `node packages/db/dist/migrator/cli.js adopt` (dry run) and then `adopt --apply` (see `packages/db/src/migrator/README.md`).

PostgreSQL requires the pgvector extension package installed on the server and the `vector` extension installed in the database before migration 0013. The runner checks for it and never installs extensions. CockroachDB uses native `VECTOR`; the runner detects CockroachDB and does not check for a PostgreSQL extension. Verify the deployed CockroachDB version has native vector support before migration.

From the backend root:

```sh
# Build the package so the compatibility shim can delegate to the compiled CLI.
pnpm --filter @app/db build

# Print the networking migration plan without connecting or changing a database.
pnpm --filter @app/db exec node scripts/migrate-networking.mjs

# Apply on a fresh database, or after an existing database has been adopted.
pnpm --filter @app/db exec node scripts/migrate-networking.mjs --apply
```

The shim delegates to the unified runner, which records migration checksums and skips previously applied files; changed applied migrations cause an error. Future changes belong in a new numbered migration. Existing databases without the unified ledger require adoption (`adopt`, then `adopt --apply`) before `apply` will proceed; `adopt` maps the old `networking_migrations` rows, including the CockroachDB 0018 steps, onto the unified ledger.

Vector lookup uses exact cosine distance within eligible event profiles up to 5,000 embedded profiles per event. Above that it retrieves bounded candidates through the approximate (ANN) index and reranks them exactly. Only CockroachDB has an ANN migration (0017, see below); PostgreSQL has none, so large events there always use the fallback.

## Event activation

1. Enable `networking`, `registrations` and `emails` for the client.
2. Open the event’s Networking settings in admin. Select manual or automatic networking approval and the payment states eligible for access.
3. Map the registration’s professional fields (company, role, sector, interests, offers and needs). Review the projected values; option IDs must resolve to meaningful labels.
4. Configure the event timezone, daily opening hours, slot duration and closures. Create spaces with capacity measured in tables or exhibitors. Tables seat two; each exhibitor can have several representatives with independent availability. See [spaces and migration](NETWORKING_SPACES.md). Enable meetings only with a valid schedule.
5. Configure branding, language choices, participant/table labels, support details and notification templates.
6. Synchronize existing registrations and approve pending participants where required. Registration changes subsequently update the networking projection.
7. For sensitive events, enable the authenticator second factor. Participants complete enrollment after email verification, and retain their single-use recovery codes.

Network access remains separate from payment state. Suspension, exclusion, withdrawal and changed registration eligibility must revoke effective access and release future meetings according to the domain policy. Hidden/paused profiles are excluded from discovery. Messaging and meeting requests require a mutual connection, and blocking applies in both directions without disclosing the block reason.

## Key rotation

Every networking MAC and sealed value names its key. v1 values are `v1:<kid>:…`, keyed by a per-purpose HKDF subkey (session, OTP, badge, seal, recovery). Unversioned values are the legacy format of `NETWORKING_TOKEN_SECRET` (kid `legacy`) and stay readable. Session lookup tries every key's hash and rehashes the session to the current key on use. Authenticator secrets are resealed on use and by the reseal script. Recovery codes are stored only as keyed hashes, so they cannot be resealed: a key must stay available for the `recovery` purpose while any unused code references it. A successful MFA check returns `recoveryCodesOutdated: true` while the participant's remaining codes use an older key, and `POST /api/networking/:slug/auth/mfa/recovery-codes` (a valid authenticator or recovery code) replaces all ten with current-key codes (MFA action `REGENERATE_RECOVERY`).

The worker image carries the runbook script (dry run and read-only unless stated):

```bash
node apps/worker/dist/scripts/networking-keyring.js status                       # keys, write format, what uses each key
node apps/worker/dist/scripts/networking-keyring.js reseal [--apply]             # re-seal authenticator secrets with the current key
node apps/worker/dist/scripts/networking-keyring.js retire --kid=legacy [--keep-recovery]  # exit 1 while anything still needs the key
```

Rollout (operator steps, API and worker together, with the same values):

1. Deploy this build with the legacy key only (`NETWORKING_TOKEN_SECRET`, no `NETWORKING_KEYS`). Behavior and formats are unchanged; this build can already read v1 values.
2. Add `NETWORKING_KEYS=k1:<openssl rand -hex 32>` and `NETWORKING_KEYRING_WRITE_V1=true`. New values use k1; legacy values keep working. Rolling back to a build without the keyring would invalidate k1 values, so do this only after step 1 is stable.
3. Run `reseal` (dry run), then `reseal --apply`. Check `status`.
4. After 30 days (the session lifetime), `retire --kid=legacy --keep-recovery` must pass. Then set `NETWORKING_KEYS=k1:<k1>,legacy:<the old NETWORKING_TOKEN_SECRET>:recovery` and unset `NETWORKING_TOKEN_SECRET`: legacy then verifies recovery codes and nothing else.
5. Once `retire --kid=legacy` passes (participants used or regenerated their legacy recovery codes), remove the legacy entry. The same steps rotate k1 to k2 later: put k2 first and keep k1 until `retire --kid=k1` passes.

Never remove a key from `NETWORKING_KEYS` (or unset `NETWORKING_TOKEN_SECRET`) without `retire` passing first: the service does not check at startup, and a missing key logs out its sessions, voids its seals and breaks the recovery codes that reference it.

## Recommendations and recovery

Each profile has separate professional-profile, offer and need vectors. Complementary matching compares one participant’s needs with another’s offers in both directions, plus shared background. Only professional networking fields are embedded; email, phone, payment proof and administrative notes are excluded.

The worker reconciles changed profiles, batches provider calls, records the source hash/model and uses expiring leases with bounded retries. Unchanged professional content does not need another embedding call merely because activity timestamps changed. Eligibility is checked again when jobs are claimed.

Administrator endpoints:

- `GET /api/events/:eventId/networking/recommendations/status`: configured provider status, model/dimensions and job counts.
- `POST /api/events/:eventId/networking/recommendations/reindex`: retry/rebuild eligible event profiles, preserving live worker leases.

After fixing provider credentials or a delivery failure, inspect job state and explicitly reindex exhausted embedding jobs as needed. Validate recommendation relevance using reviewed real professional pairs; synthetic distance tests prove filtering and ranking mechanics, not real-world matchmaking accuracy.

### Vector index health and runbook (CockroachDB)

Without the ANN index, every recommendation request for an event above 5,000 embedded profiles would scan and sort that event's embeddings. Such events therefore fall back to the deterministic profile rules (`strategy: "PROFILE_RULES"`, the same response as without embeddings) until the index exists. Each API process re-checks the index once a minute.

`GET /health/networking-vector-index` (raw body, like the queue probes) returns `{ isHealthy, index: "present" | "missing", recommendations: "vector" | "deterministic-fallback", eventsAboveThreshold, threshold }`. It is 503 while the fallback is active, that is an event is above the limit and the index is missing. It is informational: keep `/health/live` as the service health check.

Migration 0017 creates `networking_embeddings_cosine_idx`. `apply` records it as deferred while `networking_embeddings` has rows, because building it blocks writes to that table until the backfill finishes. To build it in a maintenance window:

1. Read-only check (safe any time): `node packages/db/dist/ops/networking-vector-index-cli.js status` with `DATABASE_URL` set. It prints the index state, 0017's ledger status, `feature.vector_index.enabled`, embedding row count, events above the limit, and whether a build can proceed.
2. As a database administrator, if needed: `SET CLUSTER SETTING feature.vector_index.enabled = true`.
3. Stop the worker (the embedding worker writes embeddings) and announce the window; participant writes elsewhere are unaffected.
4. `node packages/db/dist/ops/networking-vector-index-cli.js build --yes`. It refuses unless the engine is CockroachDB, the index is missing, 0017 is recorded as deferred and nothing earlier is pending. It then applies 0017 through the migrator (`apply --apply-deferred=0017 --through=0017`, same lease and ledger) and confirms the index is present.
5. Restart the worker. `status` and `/health/networking-vector-index` now report the index present; API processes switch to vector ranking within a minute.

## Local verification without live services

The local QA setup uses a `demo-` Firebase Auth emulator project and disposable PostgreSQL databases. The API launcher in the local QA directory removes real email, storage service-account and embedding credentials from its process environment.

```sh
# Build the CLI used by the compatibility shim.
pnpm --filter @app/db build

# Bootstrap only an EMPTY local database with a dedicated networking_test name.
DATABASE_URL=postgresql://localhost/focale_networking_test_example \
  pnpm --filter @app/db exec node scripts/migrate-networking.mjs --apply --bootstrap-test

# Unit and contract checks.
pnpm typecheck
pnpm test

# Native vector/database checks in an isolated test database.
ALLOW_DB_TESTS=1 TEST_DATABASE_URL=postgresql://localhost/focale_networking_test_example \
  pnpm --filter @app/db exec vitest run --config vitest.db.config.ts tests/db/networking/embeddings.db.test.ts
```

The demo seeder `packages/db/scripts/seed-networking-demo.ts` requires a local Auth emulator on9099 and an isolated local test database. It writes only synthetic participants. The optional HTTP smoke script uses that fixture and the actual API to exercise two participant sessions, matching, chat, availability, table booking, rescheduling, ICS, cancellation and revocation. It reads test OTPs from the isolated delivery queue and never sends external email.

Run frontend checks in each application directory. Admin must remain on `develop`:

```sh
# admin
npm test
npm run lint
npm run build

# form
npm test
npm run build

# networking
npm run typecheck
npm test
npm run build
```

Real browser verification must additionally cover mobile/desktop layouts, FR/EN/AR with RTL, keyboard alternatives to swipe, two participant sessions, required MFA, installation/offline shell, explicit email actions, QR permissions and supported-device push. Server tests cannot establish that those browser behaviors work.

## Source documentation

- [OpenAI embeddings API](https://developers.openai.com/api/reference/resources/embeddings/methods/create)
- [pgvector](https://github.com/pgvector/pgvector)
- [Web Push server library](https://github.com/web-push-libs/web-push)
- [Firebase Auth emulator](https://firebase.google.com/docs/emulator-suite/connect_auth)

## Registration development proxy

The form retains its production CSP. For a local HTTP backend use `VITE_API_URL=/api` and `VITE_DEV_API_URL=http://127.0.0.1:3080` in the form dev server. Vite proxies requests under the same origin. This avoids weakening the production connection policy for local QA.

## Participant error codes

Participant errors use `{ code, message, details? }` inside the existing error envelope.
Clients localize codes rather than displaying the English message.

- `NETWORKING_MFA_REQUIRED` (403) — verify the second factor for this session; nothing else.
- `NETWORKING_MFA_ENFORCED` (403) — 2FA cannot be disabled while the event requires it (must not re-arm the 2FA prompt).
- `NETWORKING_CONSENT_REQUIRED` (403) — consent-pending session (see below).
- `NETWORKING_SESSION_EXPIRED` (401) — participant session missing, expired or revoked.
- `NETWORKING_NOT_FOUND` (404) — event, participant, meeting, connection or message not found or not visible.
- `NETWORKING_ACTION_NOT_ALLOWED` (403/409) — e.g. only the other participant can respond; authenticator already enrolled; report requested before the event ended.
- `NETWORKING_AUTH_UNAVAILABLE`
- `NETWORKING_BADGE_INVALID`
- `NETWORKING_BADGE_WRONG_PARTICIPANT`
- `NETWORKING_MEETING_CHECKIN_UNCONFIRMED`
- `NETWORKING_MEETING_CHECKIN_UNAVAILABLE`
- `NETWORKING_NOT_ELIGIBLE`
- `NETWORKING_CLOSED`
- `NETWORKING_FEATURE_DISABLED` (403) — also a module disabled for the client, search/discovery/recommendations disabled.
- `NETWORKING_CONNECTION_REQUIRED`
- `NETWORKING_SLOT_INVALID` — including a nonexistent local time in a DST gap.
- `NETWORKING_SLOT_CONFLICT` (409) — including a concurrent booking of the same resource.
- `NETWORKING_MEETING_LOCKED`
- `NETWORKING_MEETING_CHECKED_IN` (409) — a checked-in meeting cannot be rescheduled or moved by accepting a counter-proposal.
- `NETWORKING_RATE_LIMITED` (429)
- `NETWORKING_CONFIG_STALE`
- `NETWORKING_VALIDATION` — HTTP 400 only.
- `NETWORKING_BUSY` (503, with `Retry-After` in seconds) — a write ran out of database serialization retries under contention; nothing was saved and the same request can be retried after the delay. Participant and organizer networking routes.

A wrong or expired OTP on `auth/verify` stays HTTP 401 (`AUTH_1001`); no session is issued. Organizer routes (`/api/events/:eventId/networking/*`) keep the generic codes: request validation failures return `VAL_2001` with `details`.

### Consent

`registration.networkingOptIn` decides when it is a boolean (`false` excludes the registrant). When it is null, the participant's explicit PWA choice wins, then the mapped consent field (yes / no / unanswered; option labels and translations are read, never option IDs), else the registrant is undecided. Withdrawal or an explicit "no" always wins. Undecided registrants who are otherwise eligible can request a code and sign in; their session is consent-pending: every participant endpoint except `GET me`, `PATCH me` (only `consent` is applied), `DELETE me`, `POST auth/logout`, `GET config` and `auth/mfa/*` returns 403 `NETWORKING_CONSENT_REQUIRED` until `PATCH me {"consent": true}`, which records the choice and makes the profile visible. A consent mapping must point at a checkbox, radio or select field of the event's form.

### Eligibility policy

Who may use networking, and who may see whom, is decided in one place (`packages/db/src/policy/`):

- `networking-access.ts` holds the rules as pure functions: the **gate** (config enabled, event not archived, client active with the networking, registrations and emails modules), the **window** (opening, closing, retention), **participant access** (`CONSENTED`, `CONSENT_PENDING` or none: an ACTIVE profile, never withdrawn or erased, whose own registration in the same event did not opt out and has an eligible payment status) and **counterpart visibility** by mode: `peer` (the relationship is given, e.g. a connection list: eligible, not the same person, no block either way), `discover` (also visible with a complete profile, discovery on), `profile` (discoverable or connected) and `blocklist` (like `profile`, ignoring the block itself).
- `networking-eligibility.ts` holds the same rules as SQL fragments (`eligibleProfile`, `embeddableProfile`, `discoverableCounterpart`, `peerCounterpart`, `distinctIdentity`, `sameIdentity`, `mutuallyUnblocked`, `notInteracted`, `admittedProfile`, `networkingEventGate`, `listedProfile`) that discovery, search, facets, recommendations, vector ranking, connection lists, unread counts, badges, check-in, the embedding jobs, the maintenance producers and the post-event report compose.
- Services load the facts in one statement (`networking-access-snapshot.ts`: the participant with its registration, form and second factor; a viewer and a target with any block and connection; the delivery context) and ask the pure functions.

Where each surface stands:

| Surface | Rule |
|---|---|
| Sign-in, the participant's own routes, activation notices | participant access (`CONSENT_PENDING` only for sign-in codes and recording consent) |
| Discovery, search, facets, recommendations, swipes | counterpart `discover` (recommendations: also not swiped or connected) |
| A profile opened directly / the block list | counterpart `profile` / `blocklist` |
| Connections, unread counts, the contacts CSV | counterpart `peer` over the viewer's connections |
| Badge and check-in scan | eligible with a confirmed meeting |
| Embedding jobs (enqueue, claim, reindex) and the embedding status | gate + eligible and visible (`embeddableProfile`); the status counts only these profiles |
| Maintenance producers | gate + eligible recipient; meeting reminders also need the counterpart in `peer` mode (both ways) |
| Deliveries (checked again when sent) | gate, window (closed: only digests and contacts notices; after retention: nothing), the recipient's access, the counterpart in `peer` mode for meeting and connection notices (a cancellation still reaches the other side unless blocked) |
| Rendered notices and calendar files | the counterpart is named only in `peer` mode |
| Organizer list, exports, analytics, post-event report | listed (erased tombstones left out); "active" = ACTIVE, consented, not withdrawn or erased; a stand counts a station per active representative |
| Personal analytics | the participant's own listed profiles (same trimmed, case-folded address) |

Withdrawn and erased profiles are ineligible everywhere. The declarative matrix `packages/db/src/testing/networking-eligibility-matrix.ts` lists the cases (status, consent, withdrawal, erasure, opt-out, payment, another event's registration, hidden, incomplete, blocks both ways, the same person) with the answer each surface must give; unit tests hold the pure policy, the delivery policy, rendering and analytics to it, and a DB test runs every surface above against it on both engines.

## Write concurrency

Every networking write is one SERIALIZABLE transaction on one pool connection, retried on serialization failures (40001/40P01) with a bounded, jittered backoff; when the retries run out the API answers 503 `NETWORKING_BUSY` with `Retry-After`. No write locks the event row. Invariants are the unique indexes: interest, connection, block and message pairs, reservation resource+slot, push endpoint and profile registration. Swipes, connections, messages, blocks and push subscriptions are `ON CONFLICT` writes, so a duplicate request is idempotent instead of failing.

Only allocations (a meeting request's hold, accepting a proposal, rescheduling a pending request and organizer assignment) take a lock: their first statement upserts one `networking_allocation_locks (event_id, bucket_start)` row per UTC hour the meeting overlaps, so allocations for overlapping times serialize while others proceed. Resources are then claimed with multi-row `INSERT … ON CONFLICT DO NOTHING`, trying tables least used first; a conflict answers 409 `NETWORKING_SLOT_CONFLICT`. Blocking and withdrawal cancel only the affected participant's active meetings with one `UPDATE … RETURNING`.

## Participant notification stream

`GET /api/networking/:slug/stream` (SSE) is the PWA's live notification feed (`apps/api/src/modules/networking/networking.stream.ts`; client contract in `FRONTEND_FOLLOWUP_4_3.md`).

- **Signals.** Every participant notification is written by `createNetworkingNotification`, which also signals the participant's streams. The signal carries IDs only (`eventId`, `profileId`, `notificationId`). Inside an API networking transaction it is published to the in-process `NetworkingNotificationHub` right after commit (never for a rolled-back attempt). Anywhere else (the worker, registration and payment paths, `withSerializableTxn`) it is a `networking.notify` outbox row in the same transaction, which the API's realtime pump relays to the hub within about a second. The hub is separate from the admin realtime bus and keyed by (event, participant), so a notice never wakes another participant's or another event's stream.
- **Catch-up.** A woken stream runs a keyset query over its own participant's rows created since its watermark minus 10 s (`networkingNotificationsPage`: `(profile_id, created_at)` index, paged by id), and sends what it has not sent yet. Signals during a catch-up coalesce into one more pass. A 60 s resync runs the same query without a signal.
- **Resume.** Each stream's SSE id is its watermark. On reconnect, `Last-Event-ID` replays everything created since (at least once: rows within the 10 s overlap can repeat; the PWA de-duplicates by id). An id that is not ours or older than 24 h gets `event: replay-gap`.
- **Limits.** The session, eligibility and event window are re-checked every 5 minutes (a refusal ends the stream with `event: session-ended` and the error code); a stream lasts at most 30 minutes (`event: reconnect`); a session keeps at most 3 open streams, the oldest being replaced (`event: replaced`). Streams are registered with the shutdown coordinator and drained on deploy (`event: shutdown`).
- **`REALTIME_DISABLED`.** The stream stays available. No `networking.notify` rows are written and the pump does not run, so only notices from API networking transactions arrive at once; the rest arrive at the 60 s resync.
- **Retention.** `networking.notify` rows are realtime-scoped (`REALTIME_OUTBOX_TYPES`): the worker never claims them, the retention job deletes them after 24 h like `realtime.emit`, and dead-letter requeue skips them.
- **One API instance.** The hub, like the admin bus, is process-local.

## Meeting lifecycle

`packages/db/src/queries/networking-meetings.ts` owns the meeting status groups (`open`, `accepted`, `awaiting`, `booked`, `holding`, `released`), the status-only transitions and their reservation effects, and the meeting notices. Reservations are 5-minute quanta, unique per event, resource and quantum:

| Status | Reservations held |
|---|---|
| `PENDING` | its table or exhibitor representative (when allocated) and `hold:profile:<requester>`; the participants are not booked yet |
| `PENDING_ALLOCATION`, `CONFIRMED` | both participants (`profile:<id>`) and, once allocated, the table or representative |
| `COMPLETED`, `NO_SHOW` | everything it held: the slot was used |
| `CANCELLED`, `DECLINED`, `EXPIRED` | nothing |

- **One pending request per requester per slot.** The `hold:profile:<requester>` quanta make a second pending request from the same requester for an overlapping slot (a new request, or rescheduling a pending one) answer 409 `NETWORKING_SLOT_CONFLICT`. Requests that existed before this rule have no hold key and are not capped until they are rescheduled, accepted or expire.
- **Releases happen with the transition.** Cancelling (participant, organizer, block, withdrawal, moderation, lost eligibility), declining a pending request and expiry delete the reservations of exactly the meetings they moved, in the same transaction. Read paths expire overdue requests in one statement (`UPDATE … RETURNING` in a CTE feeding the reservation delete) and never scan the event's history; the maintenance job alone sweeps reservations still attached to a released meeting.
- **Attendance keeps the table.** Recording `COMPLETED` or `NO_SHOW` keeps the meeting's reservations, like check-in.
- **Cancellation notices** (`MEETING_CANCEL`, `MEETING_CANCELLED`) carry `data.reason`: `PARTICIPANT`, `ORGANIZER` or `UNAVAILABLE`. `UNAVAILABLE` notices are confidential: they cover blocks, withdrawals, revoked consent or eligibility and moderation alike, and name neither the other participant nor the place.

## Retention and withdrawal

An event's networking data is kept until `endDate + retentionDays` (config, default 90 days). After that the maintenance job purges it (`packages/db/src/queries/networking-retention.ts`):

- **Batched and resumable.** `purgeNetworkingEvent` first disables the event's config and stamps `networking_configs.purge_started_at`, then deletes the event's rows table by table, 500 rows per statement, children before the tables they reference. Each maintenance run spends at most 45 s on purges; an unfinished purge resumes on the next run, in-progress purges first. `purged_at` is stamped once every table has drained. An event is selected again only if profiles reappear.
- **What goes.** Every networking table (profiles, sessions, challenges, interests, connections, messages, blocks, reports, spaces, tables, availability, meetings, reservations, notifications, deliveries, push subscriptions, embeddings, embedding jobs, second factors, allocation locks), `networking_audit` except the aggregate `POST_EVENT_REPORT` rows, and the networking `email_logs` rows (`context_snapshot.dispatchOwner = 'networking'`, found through `email_logs_networking_event_idx`). The config row stays (it holds the purge state and no participant data), and registrations are untouched. A purge-completeness test derives the networking tables from the Drizzle schema, so a new table fails CI until the purge covers it.
- **Photos.** Each purged profile's photo is queued as a `storage.delete` outbox row in the transaction that deletes the profile. The worker's handler deletes the object with the outbox retries and backoff, treats an already-missing object (404) as done, and deletes only a key under the profile's own upload prefix (`networking/<event>/profiles/<profile>/`); a form-supplied or foreign URL is skipped. Replaced photos are still deleted best-effort after their update commits; the `orphan-photos` script below sweeps any that remain.
- **No re-enable.** `PATCH /api/events/:eventId/networking/config` answers 409 `NETWORKING_RETENTION_ENDED` when it would enable networking once the purge has started, or would re-enable a disabled event whose retention (with the requested `retentionDays`) has ended; otherwise registration sync would copy personal data back in. Edits that leave networking disabled are still accepted.

Withdrawal (`DELETE /api/networking/:slug/me`) is final and happens in two stages (`packages/db/src/queries/networking-erasure.ts`):

- **At once, in one transaction.** The profile content is scrubbed (every professional field, the photo, the participant's overrides) and consent, visibility, meetings, availability, featuring and emails are switched off; sessions are revoked, active meetings cancelled, and push subscriptions, availability, embeddings (and the embedding job) and every delivery not yet sent are deleted. The photo's `storage.delete` is queued in the same transaction. Name, email and status stay for the erasure window, so the organizer can still handle reports and the erasure can find the rows keyed by the address.
- **After `NETWORKING_WITHDRAWAL_ERASE_DAYS`** (worker env, default 30). The maintenance job erases the rest, 500 rows per statement within a 15 s budget per run, resuming on the next run: the participant's audit entries (and organizer entries about their meetings and reports), notifications (including other participants' notices naming their connection or meeting), deliveries, networking email logs (by profile or address), meetings with their reservations, reports by or about them, whole conversations, interests, blocks, availability, push subscriptions, sessions, codes, embeddings, second factor, and the stand representative link. The profile row is then scrubbed to a **tombstone** and `erased_at` is stamped last: only its id, event, registration and timestamps remain. A schema-derived test classifies every `networking_profiles` column as kept or scrubbed, and another checks that every foreign key to `networking_profiles` is cleared, so a new column or table fails CI until it is covered.
- **Never re-created.** Registration sync skips a withdrawn profile (it no longer re-projects form answers into it), and the tombstone's registration link keeps sync from creating a new one. Organizer edits of a withdrawn profile answer 409 `NETWORKING_PROFILE_WITHDRAWN`; erased tombstones are left out of the admin participant list and exports.

### Retention operator scripts

Maintenance does all of the above on its own. The worker image also carries a supervised runbook for leftovers (`apps/worker/src/scripts/networking-retention.ts`). Every command is a **dry run by default** and prints what it would do; `--apply` is refused unless `--backup-verified=<reference>` names the backup you took **and verified (restored or checked)** first. Applied runs log the rows deleted per batch.

```bash
node apps/worker/dist/scripts/networking-retention.js purge-leftovers [--event <id>] [--batch-size 500]
node apps/worker/dist/scripts/networking-retention.js erase-withdrawn [--event <id>] [--limit 100] [--batch-size 500]
node apps/worker/dist/scripts/networking-retention.js orphan-photos [--event <id>] [--min-age-hours 24] [--batch-size 1000]
# (from a checkout: pnpm --filter @app/worker networking-retention <command> ...)
```

- `purge-leftovers`: events past retention that still hold networking data (never purged, interrupted, or refilled), purged without the maintenance time budget; without `--event`, also the networking `email_logs` of events that no longer exist (deleting an event does not cascade to them).
- `erase-withdrawn`: withdrawn profiles past `NETWORKING_WITHDRAWAL_ERASE_DAYS` (read from the environment), erased to tombstones one by one, oldest first, `--limit` per run.
- `orphan-photos`: lists the bucket under `networking/` (or `networking/<event>/profiles/`) page by page with `StorageProvider.list` (R2 and Firebase) and reports profile photos (`networking/<event>/profiles/<profile>/<file>`) that no profile references (a replaced photo whose best-effort delete failed, a missing profile, older code). Branding, reports and objects younger than `--min-age-hours` (an upload not yet saved) are never touched; `--apply` deletes only keys under the owning profile's prefix and counts an already missing object as gone. The backup here is a copy of the bucket (or object versioning).

Operator steps: (1) run the dry run and review its output; (2) take a database backup (for `orphan-photos`, a bucket copy) and verify it; (3) re-run with `--apply --backup-verified=<backup id or time>` and keep the log; (4) run the dry run again: it should report nothing left. Run these against production only as a planned operation, never from a development machine with production credentials.

The organizer audit log (`GET /api/events/:eventId/networking/audit`) is paginated in SQL and lists only organizer and system actions (`NETWORKING_ADMIN_AUDIT_ACTIONS`: configuration, profile, meeting, report, space and table changes, and post-event reports). Participant activity (swipes, MFA changes, profile views) is personal data and is never listed.

## Rate limits

Participant routes (`/api/networking/:slug/…`) share a venue bucket of **24,000 requests/minute per client IP and event slug**, sized for 500–2,000 attendees behind one public IP and checked alongside identity quotas. `config` and `registration` reads skip the per-IP default limit and are bounded only by the venue bucket. Organizer routes (`/api/events/:eventId/networking/…`) are outside the venue bucket; they share a backstop of **600 requests/minute per client IP**, and organizer bearer requests (e.g. badge scanning) also get per-token quotas. Other modules retain the legacy per-IP limits (100/minute in production by default).

Sign-in endpoints (`auth/request`, `auth/verify`, `auth/mfa/verify`) also share **300/minute per client IP and event slug** per endpoint.

Participant bearers are keyed by verified identity. After the participant service verifies a bearer's session (every authenticated request, and at issuance by `auth/verify`), it records sha256(token) → session id in an in-memory LRU for at most 5 minutes (never past the session's expiry). Logout, withdrawal, consent withdrawal, organizer suspension/exclusion/status changes and MFA disable evict eagerly; a rejected bearer is evicted on its next use.
- A **verified** bearer uses the per-session identity quotas below.
- Any other bearer (after a restart, after 5 idle minutes, or a revoked or random token) is **unverified**: it shares **12,000 requests/minute per client IP and event slug** (half the venue bucket, so a cold cache at venue scale does not 429) and keeps a per-token quota under a separate namespace.
- **Invalid-bearer lockout:** when the service rejects **200 distinct bearers** (missing, unknown, revoked or expired sessions; not eligibility/consent/MFA refusals) from one client IP for one event slug within 10 minutes, unverified bearer requests from that IP and slug get 429 with `Retry-After` for **10 minutes**. Verified sessions, the sign-in endpoints and `config`/`registration` are unaffected.

Identity quotas are separate per handler:
- OTP request: **5 per 10 minutes**, keyed by event slug and trimmed, lowercase email (even when a bearer header is supplied).
- OTP verify: **10/minute per event slug and challenge ID**. The verify contract contains no email; the database-enforced five-attempt challenge cap remains in place, and failed attempts are also summed per event and email across challenges: **10 per 15 minutes and 30 per 24 hours**. Over either, `auth/verify` returns 429 `NETWORKING_RATE_LIMITED` before the code is compared. Invalid/missing challenge IDs fall back to IP.
- MFA: **10/minute per bearer session** per endpoint.
- Chat sends: **30/minute per bearer session**.
- Other authenticated networking requests, including mutations: the configured default limit per bearer session (100/minute in production), unless an endpoint has a tighter override (reports: 5/minute).

Trackers hash session tokens and OTP identities; raw tokens/emails are not stored in throttle keys. Other anonymous requests fall back to IP. The client IP uses `X-Forwarded-For` only when the immediate socket peer matches an explicitly configured `TRUST_PROXY` IP/CIDR; requests from other peers ignore forwarded headers. Throttled participant responses use HTTP 429 and `NETWORKING_RATE_LIMITED` inside the normal error envelope. **All quotas, verified identities and lockouts are in memory and therefore per API process.** The deployment runs one API instance; with N replicas the effective ceilings would be up to N times higher and a lockout or verified identity on one replica would be invisible to the others. The OTP failed-attempt sums are persistent (database).

## Participant lists

`GET connections` and `GET meetings` always paginate (`limit` 1–200, default 50; opaque `cursor`). The first page returns `{ items, nextCursor, total }`; later pages omit `total`. Cursors are scoped to the event, participant and list, and survive organizer configuration edits. `GET connections/:id`, `GET connections/with/:profileId` (`{ connection }`, possibly null) and `GET meetings/:id` return single items in the list shapes. Calendar, CSV and personal-data exports are never truncated.
