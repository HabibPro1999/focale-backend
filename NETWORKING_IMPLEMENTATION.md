# B2B Networking implementation and verification ledger

Source: `/Users/mohamed/Downloads/Documentation Focale OS - Module B2B Networking.pdf` (34 pages), plus user decisions: dedicated `networking/` PWA; vector-backed profile/offer/need recommendations; implement full backend, admin, form and PWA.

Status: requested implementation completed and locally verified. The evidence and deployment boundaries are recorded in [NETWORKING_QA.md](NETWORKING_QA.md). Earlier progress notes below are historical; they are not the final status.

## Architecture decisions

- Active NestJS/Fastify API + Drizzle SQL backend; existing admin and form remain separate apps; new Vite/React/TypeScript `networking/` PWA.
- Canonical registration data stays relational. Event-scoped networking profiles are projections with explicit mappings and participant-owned overrides.
- New client module `networking`; disabled per event by default. Explicit per-event activation and all participant APIs enforce event enablement, client entitlement, profile eligibility and blocks.
- Manual networking approval by default; optional automatic approval for configured payment statuses. This is separate from payment state. Admin can approve/suspend/exclude. Changes in registration eligibility revoke effective access.
- Participant email OTP establishes opaque expiring/revocable sessions separate from administrator Firebase authentication. Never return OTP in normal API responses or logs.
- Matching is mutual and unique per unordered participant pair, scoped to event. Discovery uses profile, offer and need embeddings and complementary retrieval with hard eligibility filtering; deterministic ranking is available while embedding jobs complete, never presented as semantic search.
- Pending meeting requests do not reserve resources and expire. Acceptance reserves both participants and one table atomically. Fixed event slots and unique resource reservations prevent double bookings. Manual allocation uses an explicit pending-allocation state. Rescheduling preserves the old confirmed booking until replacement succeeds.
- Event timezone controls slot generation and display; timestamps on wire are ISO instants. Configured slot durations: 15/30/45/60 minutes.
- Profile pause hides discovery but preserves existing connections; blocks are symmetric in effect, confidential, prevent messaging/requests and cancel future shared meetings. Reported messages are readable only through event-authorized moderation.
- Durable persisted messages/notifications and participant-scoped updates; reconnect retrieves state. Email and push delivery are asynchronous, retryable, deduplicated and preference-aware. Reminder jobs check current meeting revision/status.
- French/English/Arabic UI with RTL, accessible buttons alongside swipe, offline app shell, installation UX, push permission flow. Browser push requires feature detection; offline writes must not appear confirmed.
- External integrations are configured through environment variables; no deployment or live database migrations or actual participant notifications without explicit action-time authorization. Local isolated fixtures are used for verification.

## Wire contract coordination

All API routes are under `/api`; success uses existing `{ok:true,data}` envelope. Dates are ISO strings. API errors use existing error envelope and meaningful HTTP status. IDs are UUID strings. List responses use `{items: T[], total: number}` unless described otherwise. Participant bearer token is opaque, event-scoped; organizer requests use existing Firebase bearer authentication.

### Administrator `/events/:eventId/networking`

- GET/PATCH `/config` -> NetworkingConfig
- POST `/sync` -> `{created,updated}`; idempotently projects existing registrations
- GET `/profiles?q=&status=&sector=&page=&limit=` -> profiles list
- PATCH `/profiles/:profileId` -> profile; status, featured and company/stand assignment controls
- GET/POST `/tables`, PATCH/DELETE `/tables/:tableId` -> table/inventory
- GET `/meetings?date=&status=&tableId=` -> meeting list
- PATCH `/meetings/:meetingId` -> meeting; organizer reassignment/cancel/no-show/completed
- GET `/reports`; PATCH `/reports/:reportId` -> moderation report/action
- GET `/analytics` -> aggregate networking metrics, time series and sector metrics
- GET `/export?kind=matches|meetings|participants|sectors&format=csv|xlsx|pdf`

### Participant `/networking/:slug`

- GET `/config` -> `{event:{id,name,slug,startsAt,endsAt,location,bannerUrl}, config: public NetworkingConfig}`
- POST `/auth/request` `{email}` -> `{challengeId}` (generic response irrespective of account existence)
- POST `/auth/verify` `{challengeId,code}` -> `{token,expiresAt,profile}`
- POST `/auth/logout`; GET/PATCH `/me` -> profile
- GET `/profiles?q=&sector=&sort=&page=&limit=` -> discovery list; GET `/profiles/:id` -> profile
- GET `/recommendations` -> `{items: [...profiles with score/reasons], total, strategy}`
- POST `/interests` `{profileId,action:'LIKE'|'PASS'}` -> `{matched,connectionId?}`; DELETE `/interests` resets dismissed suggestions
- GET `/connections` -> connection list; each includes `id,profile,lastMessage,unreadCount,createdAt`
- GET/POST `/connections/:id/messages` -> message list / created message; body `{body,clientMessageId}` max 1000 chars; POST `/connections/:id/read`
- POST `/blocks` `{profileId}`; DELETE `/blocks/:profileId`; GET `/blocks`
- POST `/reports` `{profileId,messageId?,reason}`
- GET/PUT `/availability` -> `{slots:string[]}` / body `{slots:string[]}`; GET `/profiles/:id/availability` -> `{slots:string[]}`
- GET/POST `/meetings` -> list / body `{profileId,startsAt,message?}`
- POST `/meetings/:id/respond` `{action:'ACCEPT'|'DECLINE'|'CANCEL'|'RESCHEDULE',startsAt?,message?}` -> meeting
- GET `/calendar.ics`; GET `/connections/export` (CSV)
- GET `/notifications` -> notification list; POST `/notifications/read` `{ids?:string[]}`
- POST/DELETE `/push-subscriptions` browser PushSubscription JSON
- GET `/badge`; POST `/meetings/:id/checkin` `{token}`
- GET `/stream` participant events (authenticated fetch stream; client may poll durable notification state on reconnect)
- GET `/me/export`; DELETE `/me` withdraws networking participation, preserving required historical integrity

### Shared shapes (backend contracts source is authoritative once published)

NetworkingConfig: `enabled, approvalMode:'MANUAL'|'AUTOMATIC', eligiblePaymentStatuses:string[], swipeEnabled, searchEnabled, chatEnabled, meetingsEnabled, autoAssignTables, slotDurationMinutes, timezone, opensAt?, closesAt?, retentionDays, requestExpiryHours, languages:string[], defaultLanguage, logoUrl?, primaryColor, welcomeMessage, supportEmail?, supportPhone?, fieldMapping:Record<string,string>, openingHours:Array<{date:string,start:string,end:string}>, blackoutSlots:string[]`.

Profile: `id,eventId,registrationId,firstName,lastName,company,jobTitle,sector,bio,city,country,website,photoUrl,interests:string[],offers:string,seeks:string,status:'PENDING'|'ACTIVE'|'SUSPENDED'|'EXCLUDED',visible,meetingsEnabled,emailPreference:'IMMEDIATE'|'DAILY'|'OFF',language,lastActiveAt,featured,standTableId?,createdAt,updatedAt`. Public profiles must omit private email, phone, registrationId, session/OTP data and admin-only fields.

Table: `id,eventId,name,capacity,location,active,kind:'TABLE'|'STAND',ownerProfileId?`.
Meeting: `id,eventId,requesterId,recipientId,requester,recipient,startsAt,endsAt,tableId,table,status:'PENDING'|'PENDING_ALLOCATION'|'CONFIRMED'|'DECLINED'|'CANCELLED'|'EXPIRED'|'COMPLETED'|'NO_SHOW',message,proposedStartsAt?,proposalBy?,revision,createdAt`.
Message: `id,connectionId,senderId,body,createdAt`.
Notification: `id,type,title,body,href,readAt,createdAt`.

## Full requirement ledger

- [x] Event module entitlements, activation, dependency checks, feature toggle interactions.
- [x] Registration projection, field mapping, sync on create/update/payment, approval/revocation, historical backfill.
- [x] Participant OTP, sessions, logout/recovery, optional second factor, authorization, rate limits.
- [x] Profiles, participant overrides, image/branding, visibility/pause, block/unblock, withdrawal/data export/retention.
- [x] Swipe/button discovery, interest/pass/reset, atomic mutual match, connections/search/sorting.
- [x] Vector persistence, asynchronous profile/offer/need embeddings, event-filtered complementary retrieval, ranking/explanations/model versioning, relevance evaluation.
- [x] Name/company/title search including phonetic/fuzzy matching, sectors/multiple filters/counts, paging and sorting.
- [x] Text chat (1000 characters), safe URLs, idempotent sends, pagination/history, read state, reconnect/realtime.
- [x] Availability, timezone/open hours/closures, requests/expiry/accept/decline/counterproposal/cancel/reschedule.
- [x] Transactional participant and table reservations; concurrency tests; manual allocation; reassign/add/release/no-show.
- [x] Table/stand capacity, localization, ownership, balancing and exhibitor promotion controls.
- [x] Notifications, event email templates/variables, preferences/digests, durable retries/dedupe, J-1/H-1 reminders, ICS revisions/cancellations, browser push.
- [x] Virtual badges, mutual meeting check-in, access validation and attendance evidence.
- [x] Organizer settings, field mapping, participants, tables/calendar/list, moderation/report actions/audit.
- [x] Accurate analytics, time/sector series, occupancy, per-participant engagement, CSV/XLSX/PDF exports and post-event report.
- [x] Registration frontend networking opt-in/preview/link; no breaking existing registration or payment behavior.
- [x] Participant PWA complete responsive flows, install/service worker/offline handling, push badges, FR/EN/AR + RTL + accessibility.
- [x] Builds/typechecks/tests across all apps; local database migration and booking concurrency verification.
- [x] Browser end-to-end verification of admin + registration + two participant sessions; screenshots, operations/setup documentation.

## Verification record

See [NETWORKING_QA.md](NETWORKING_QA.md) for the final source/test/browser/artifact evidence and exact limitations. Production is not modified.

### Progress evidence (2026-09-08, implementation ongoing)

- Form: `pnpm exec tsc --noEmit -p tsconfig.app.json` passes; all 20 existing test files / 113 tests pass with registration networking integration.
- Backend registrations: 61 existing service tests pass after adding transactional networking projection hooks.
- Embedding provider and notification boundary unit tests: 8 pass (batch response validation/order, professional-field-only input, encrypted OTP tamper rejection, safe HTML and push-provider URL boundaries).
- Native vector DB tests: 2 pass against isolated PostgreSQL18 + pgvector0.8.6; prove complementary distance ranking and event/payment/visibility/block/pass exclusions, plus embedding-model separation.
- Networking DB migrations0012–0015 applied to `postgresql://localhost/focale_networking_test_20260908_0200`; migration runner records checksums and refuses unsafe test bootstraps. No production connection used.
- Backend agent reports 7 real-DB domain tests (concurrent match, sessions/eligibility, OTP replay, table contention, participant collisions, rescheduling rollback, message idempotency/block cancellation) and 7 policy tests passing. Expanded MFA tests still in progress.
- Admin production build and 8 focused tests pass. Existing full-admin TypeScript baseline has unrelated errors; new networking/client/Firebase files have none per agent. Shared API envelope normalization was required and implemented.
- Browser QA: actual local Firebase emulator login succeeds; organizer event networking overview displays 4 seeded profiles and correct empty metrics; created Table1 through admin UI and verified persisted name/location/capacity. Other browser journeys still pending.
- Local QA processes were started by root: Firebase auth9099 (demo-focale-networking), API3080, admin8084, form8083, PWA8082. Fixture IDs in /tmp/focale-networking-qa/fixture.json; /tmp/focale-networking-qa/start-api.py strips production email/embedding credentials. API must be restarted after backend changes (not watch mode).

Remaining work includes complete browser journeys, worker/lifecycle/delivery integration tests, MFA and upload/incoming-interest UI integration, full PDF requirement audit, source formatting, deployment/operations docs, and broader regression checks. None of the main checklist items above is claimed complete yet.

### Admin branch correction and HTTP integration evidence

- User explicitly requires admin on `develop`. Root preserved all original uncommitted admin work in stash `4052b6b33e31f40c3c222abe849d87d8e96d1cf6`, switched admin to develop (`b7ccdbe`), and applied the work there.
- Conflict resolutions retained develop's existing API normalization, Header and deleted Sidebar; networking was integrated into DashboardNavigation. Redundant main-only API-response helper/tests removed. Main remains `92542902666516c4da33506be9eff0fefd9588d4`, equal to origin/main. No new main commits or resets were made.
- Admin agent adapted networking to develop's DESIGN.md: always-dark Geist/gold, horizontal tabs, compact heading/flat tables, description/editor settings columns. On develop, all22 test files /148 tests, repository lint, and production build pass. Full TS baseline still has29 errors outside networking changes.
- Root HTTP smoke script `packages/db/scripts/networking-http-smoke.mjs` passes using actual local API and two independent fixture sessions: durable encrypted OTP login, fallback recommendation retrieval, mutual matching, idempotent text message, unread/read state, availability, request/accept/table assignment/reschedule, ICS export, cancellation releasing every reservation, and logout revocation.
- Runtime API was restarted after MFA migration. At last inspection local processes: API3080 PID41573/session31731, PWA8082 PID38567/session98646, form8083 PID38093/session54497, admin8084 PID38073/session28649, Firebase9099 PID35833/session83101. Revalidate each process before reuse. No network provider credentials are injected into local API.
- Browser connector disconnected after user interruption (CUA inventory returned no browsers); native Chrome was under active user control. Earlier browser observations only prove the main-era admin layout and initial PWA login, so final develop UI and two-participant browser flow remain unproven. Do not claim complete browser QA from the HTTP smoke.
- Current delegated followups: backend agent owns SQL performance/authorization/discovery input normalization; PWA agent now owns notification/lifecycle worker integration and tests in separate local `focale_networking_test_worker_20260908_0220`; admin agent completed develop design/verification.

### Worker/integration final regression pass (2026-09-08 03:07 Africa/Tunis)

- `ALLOW_DB_TESTS=1 TEST_DATABASE_URL=postgresql://localhost/focale_networking_test_worker_20260908_0220 pnpm --filter @app/integrations exec vitest run src/networking/notification-worker.db.test.ts`: all18 real isolated DB tests pass. Covers concurrent leases/reminders, independent channel retries, stale eligibility/revisions, OTP scrubbing, email log ownership/webhook ordering, OFF/DAILY policy, disabled-event retention, automatic public-field contacts CSV and private report persistence.
- `pnpm --filter @app/integrations test`:191 unit tests pass;18 gated DB tests skip in this invocation and pass separately above. Sender adapters are mocked; custom sender tests require verified sending-enabled Resend domains or valid SendGrid authenticated domains and reject tenant spoofing/configuration injection.
- `pnpm --filter @app/integrations typecheck` and `pnpm --filter @app/worker typecheck` pass after the report owner's PDF typing correction.
- Email alias templates now fall back to canonical templates (e.g. ASSIGN to ACCEPT) while explicit alias overrides retain priority. DB regression proves custom confirmation copy and ICS alarms coexist.
- Sender allowlist/domain-read credentials and post-event CSV preference behavior are documented in [delivery setup](packages/integrations/src/networking/README.md), `.env.example` and [operations](NETWORKING.md).
- No external email, push, domain verification, storage upload, deployment or demo queue processing occurred. Actual provider delivery/domain configuration, browser push permission and final browser email-action journeys remain external verification gaps; provider acceptance across a DB failure cannot promise exactly-once sending without provider idempotency (Resend uses the stable tracking ID).

### Full backend integration regression pass (2026-09-08)

- `pnpm typecheck`: all six workspace packages pass.
- `pnpm test`: all packages pass; 1,299 tests passed and 40 intentionally skipped across 87 passed test files and four skipped files. Breakdown: contracts139, shared46, DB47, integrations191, API851, worker25. Native DB/performance/provider opt-in tests remain skipped in this ordinary run; this does not supersede their isolated verification records. Log: `/tmp/focale-backend-full-tests.log`.
- `pnpm build`: all six workspace packages pass.
- Updated the pre-existing canonical client-module assertion from six modules to seven including `networking`, matching the intentionally expanded contract. No production databases, external providers, branch changes or API restarts were involved.
- Additional isolated API regressions pass: 17 real DB authorization/booking/export/filter tests, nine policy tests and two CSV/XLSX contract tests (28 total). Organizer meeting search filters by either participant name/company before pagination; required client-module revocation and consistent planned-meeting export counts are covered.
- Durable local benchmark evidence and limitations: [NETWORKING_PERFORMANCE.md](NETWORKING_PERFORMANCE.md) and [raw JSON](networking-performance.json). Full browser/provider and deployed-concurrency acceptance remain distinct unfinished evidence.

### Independent embedding boundary follow-up (2026-09-08 03:12 Africa/Tunis)

- Vector candidates now exclude another profile sharing the requester's email, case-insensitively, matching directory/fallback behavior. Embedding enqueue and claim require all three client module dependencies (`networking`, `registrations`, `emails`), so dependency revocation stops provider-bound work.
- Native vector DB suite now4/4 passes on the isolated worker test database, covering the shared-email candidate and each revoked dependency alongside existing model/event/payment/visibility/block/pass/consent checks. `pnpm --filter @app/db typecheck` passes. No external model calls were made.

### Embedding lease and final-hydration corrections (2026-09-08 03:15 Africa/Tunis)

- Expired embedding leases at five attempts are terminalized as FAILED and cannot be reclaimed until explicit reindex. Four-attempt expired leases may make the final attempt. Worker counters only count successful lease-owned saves; a lost lease does not fail the new owner.
- Final vector profile hydration rechecks event, current registration payment/opt-in, symmetric blocks, profile consent/visibility/withdrawal and shared-email exclusion after candidate retrieval.
- Native vector suite6/6 and focused embedding provider/worker unit suite7/7 pass. DB, integrations and API typechecks pass. Tests used only the isolated worker PostgreSQL database and mocked provider; no external embeddings generated.

### Private participant cross-event ROI (PDF p33)

- `GET /api/networking/:slug/me/analytics` revalidates the current participant session and eligibility, then returns only aggregate own-email metrics for events belonging to the same client. Duplicate same-email profiles are grouped per event; counterpart-email deduplication prevents duplicate matches, and each stored meeting/message/view is counted once. No counterpart email/contact details are returned.
- Shared `NetworkingPersonalAnalytics` contract exposes currentEventId and event comparisons (event ID/name/dates, profile views, matches, sent messages, planned and completed meetings). Planned includes CONFIRMED/COMPLETED/NO_SHOW, consistent with organizer reporting. The feature is available to all eligible participants, including exhibitors.
- Participant updates reject explicitly blank company/jobTitle/sector in both schema and business validation. Omitted fields remain allowed so incomplete projected profiles can finish onboarding or change unrelated preferences.
- Verification: 18 isolated native API DB tests and two private ROI/schema tests pass. Tests cover forged profile/email ownership, other-client and other-email exclusion, duplicate profile aggregation, counts and blank updates. No external services used.

## Final local acceptance

All functional implementation items above have source and bounded verification evidence in NETWORKING_QA.md. Final ordinary counts: backend1310, admin151, form113 and PWA44 passing tests; native DB suites ran separately. Current admin TypeScript errors were proved identical to baseline (29). Actual develop admin, two participant sessions, registration preview, mobile RTL, activated service worker, cold offline shell/recovery, and FR/EN/AR PDF rendering were checked.

Provider credentials, production deployment/migrations, physical-device permissions/delivery and real participant relevance calibration remain environment/release work and were not performed or represented as passing. No requested code feature remains a placeholder.
