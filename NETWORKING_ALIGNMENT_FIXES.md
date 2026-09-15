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
- User additionally authorized deployment verification/promotion and a five-minute WhatsApp QA loop with Jihed after initial deployment, ending after 30 minutes without new QA input. Not started yet.

## Performance result and remaining external acceptance

The new 10,000-profile CockroachDB run returned all 30 eligible results with 100% top-30 overlap against the exact scorer for all three callers. Cold indexed retrieval took 519, 554 and 525 ms (exact baseline 955–1,046 ms). See [raw measurements](packages/db/scripts/benchmarks/networking-vectors-alignment-10000.json). The test used synthetic vectors, one local node, 512 MiB DB cache and 1 GiB SQL memory. An initial attempt with a 128 MiB SQL budget exhausted memory; it produced no valid latency result.

Changes bound participant meeting reads, replace whole-event conversation loading with a scoped latest-message/unread query, scope incremental notification reads, deduplicate profile-view polling, avoid loading every meeting to expire proposals, and pass reranking candidate IDs as one array parameter. Existing candidate caching still rechecks live eligibility. The universal <200 ms requirement is **not met** by cold recommendation retrieval; these optimizations and local checks do not establish a production SLA.

In-app Browser acceptance on the isolated local fixture verified: free/disabled time cells, selecting and submitting a mutual slot, a pending request with an allocated table, cancellation reason persistence alongside the original message, trend/hourly sections, and the zone pie (2 North / 1 South, 67% / 33%). Physical-device, live-provider, backup/restore, monitoring, uptime and human-support commitments still require environment/operational evidence.
