# Networking alignment fixes

Scope: the 20-point B2B audit follow-up. Two-seat tables and space capacity counting tables/exhibitors are explicitly retained (point 13). Embeddings remain the selected implementation.

| Point | Work | Status |
| --- | --- | --- |
| 1 | Preserve moderation through registration synchronization | Implemented and verified |
| 2 | Redact blocked/ineligible counterparts in meeting history/export | Implemented and verified |
| 3 | Deliver safe cancellation notices after eligibility loss | Implemented and verified |
| 4 | Save only intended profile overrides; restore registration values | Implemented and verified |
| 5 | Clear removed registration mappings | Implemented and verified |
| 6 | Withhold incomplete profiles from discovery | Implemented and verified |
| 7 | Distinguish acceptance awaiting allocation from confirmation | Implemented and verified |
| 8 | Use actual unread messages for the app badge | Implemented and verified |
| 9 | Preserve cancellation explanations | Implemented and verified |
| 10 | Refresh profile details without inflating views | Implemented and verified |
| 11 | Complete notification identity/time/location/help content | Implemented and verified |
| 12 | Configure iOS 12-compatible output/APIs | Build/API fixes verified; physical-device acceptance pending |
| 13 | Retain two-seat capacity model | Accepted as requested |
| 14 | Represent pending table reservations and release them safely | Implemented and verified |
| 15 | Use shared availability grids for partner preview/booking | Implemented and verified |
| 16 | Complete charts, hourly activity and activity tiers | Implemented and verified |
| 17 | Generate post-event reports at event end | Implemented and verified |
| 18 | Optimize hot reads/recommendations; measure latency | Hot reads optimized; cold latency target remains unmet |
| 19 | Integrate confirmed-meeting checks into zone admission | Implemented and verified |
| 20 | Verify available browser/provider/operational acceptance | Local verification complete; deployment / QA follow-up in progress |

## Documentation consulted through Context7

- TanStack Query v5: active-query invalidation, refetch intervals and AbortSignal.
- Vite 6: explicit browser build targets and runtime polyfills.
- CockroachDB: event-prefixed cosine vector indexes and bounded search.

Migration, verification and external acceptance limits are recorded below.

## Upgrade and verification progress

- Applied `0019_networking_alignment.sql` to `backend/.env` CockroachDB on 2026-09-15. It adds cancellation explanations and scoped read indexes.
- Found and fixed a CockroachDB-specific failure in the existing spaces migration runner: new columns must commit before subsequent statements reference them. The original migration/checksum is preserved; journaled, resumable steps handle partial DDL left by an interrupted transaction. Verified recovery and repeat execution locally.
- Passing so far: full backend unit suite (1,320 tests), PWA (48), admin (154), form (113, one unrelated skipped), alignment database regressions (16), existing API database suite (18 on PostgreSQL and 18 on CockroachDB), inventory (11), projection/embedding (9), delivery worker (18).
- PWA/admin/form/backend production builds pass; admin lint and backend/PWA typechecks pass. Standalone admin app typechecking retains 29 pre-existing errors outside networking; no errors remain in the changed networking code.
- Pending table requests hold inventory only; people become booked at acceptance. Manual allocation keeps PENDING until the other participant accepts. Decline/cancellation/expiry releases holds. Confirmed reschedules retain the original booking until accepted.
- Activity tiers are explicit recency bands: VERY_ACTIVE within 24h, ACTIVE 1–7 days, INACTIVE older/never. Hourly counts include views, swipes, messages, new matches and booking requests in the event timezone. Booking trends use request creation dates.
- Physical iOS/Android devices, live email/push providers and production load are separate acceptance checks; passing a compatible build or injected-provider test is not evidence of those outcomes.
- Initial fixes are pushed and deployed: backend Live on Render; admin, form and networking Ready in Vercel Production. The five-minute WhatsApp QA loop with Jihed is active. The user clarified that the 30-minute inactivity timer starts only after all reported fixes are deployed.

## Jihed QA follow-up

- B2B-001: form builder accepts a single checkbox option for explicit consent.
- B2B-002: convert email counts to numbers at the database boundary; CockroachDB's integer wire values previously made string `"0"` truthy and displayed NaN percentages.
- B2B-003: initial public networking consent is unchecked.
- B2B-004: missing networking secret configured in Render; QA verified the code-entry screen is reachable. QA verified real inbox OTP sign-in for both participant accounts.
- B2B-005: waived registrations show no net amount or balance due in admin.
- B2B-006: neutral default registration success text no longer claims email delivery. Dev now uses the user-authorized Resend configuration. QA received OTP and action emails; the dev webhook returns HTTP 200 and updates delivered counts.
- B2B-007: saved-template preview replaces catalog variables with escaped sample values.
- B2B-008: malformed/expired badge validation returns HTTP 400 rather than organizer-session HTTP 401.
- B2B-009: accepted product behavior. The user explicitly retains “Inclus” for free optional items; it means no extra charge if selected, not automatic selection.
- B2B-010: backend rejects meeting opening hours outside the event boundaries before saving; QA passed.
- B2B-011: shared meeting notices use neutral wording and participation updates are localized in FR/EN/AR (QA passed). Declining a reschedule proposal now explicitly preserves the original confirmed meeting, distinct from declining the meeting itself; a native worker regression verifies email and in-app wording.
- Deployment: the image now supports `APP=all` to supervise API and worker in one existing service. It forwards shutdown signals and stops the service if either child exits. The previous default API-only process did not run networking/email jobs. This mode is deployed; both processes and indexing are running.
- Presentation: localize networking-auth unavailability; replace dummy contact links with organizer-contact guidance.

Focused checks: 18 alignment database tests, 9 boundary-policy tests, 10 admin analytics/preview tests, and 3 runtime supervision tests pass. Numeric zero email counts were also verified on native CockroachDB. Backend typechecks/build and all frontend builds pass; form (113) and networking (48) suites pass. QA, rather than this implementation task, performs the live platform retests.

## Native CockroachDB worker follow-up

- Explicit reminder parameter types fix CockroachDB interval/CASE inference failures. Reminder links use the actual `/e/:slug/agenda` route.
- Post-event aggregates use `int4`, preserving their existing PostgreSQL numeric contract on CockroachDB instead of serializing counts as strings.
- All 18 worker database regressions pass on native CockroachDB 26.2.5. Tests poll due work like the scheduled worker because [CockroachDB can briefly skip committed intents](https://github.com/cockroachdb/cockroach/issues/167582); production locking and lease checks remain intact.
- Jihed passed single-checkbox, long-message feedback, reciprocal connections, chat, reschedule/cancel/decline, slot release, badge admission/revocation, calendar and Excel/PDF exports. Moderation, fresh form consent and device push acceptance are still in progress.

## Performance result and remaining external acceptance

The new 10,000-profile CockroachDB run returned all 30 eligible results with 100% top-30 overlap against the exact scorer for all three callers. Cold indexed retrieval took 519, 554 and 525 ms (exact baseline 955–1,046 ms). See [raw measurements](packages/db/scripts/benchmarks/networking-vectors-alignment-10000.json). The test used synthetic vectors, one local node, 512 MiB DB cache and 1 GiB SQL memory. An initial attempt with a 128 MiB SQL budget exhausted memory; it produced no valid latency result.

Changes bound participant meeting reads, replace whole-event conversation loading with a scoped latest-message/unread query, scope incremental notification reads, deduplicate profile-view polling, avoid loading every meeting to expire proposals, and pass reranking candidate IDs as one array parameter. Existing candidate caching still rechecks live eligibility. The universal <200 ms requirement is **not met** by cold recommendation retrieval; these optimizations and local checks do not establish a production SLA.

In-app Browser acceptance on the isolated local fixture verified: free/disabled time cells, selecting and submitting a mutual slot, a pending request with an allocated table, cancellation reason persistence alongside the original message, trend/hourly sections, and the zone pie (2 North / 1 South, 67% / 33%). Physical-device, live-provider, backup/restore, monitoring, uptime and human-support commitments still require environment/operational evidence.
