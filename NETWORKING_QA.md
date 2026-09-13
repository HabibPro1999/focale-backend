# Networking implementation handoff

Date: 2026-09-08. The requested backend, admin, registration-form integration and dedicated participant PWA are implemented and verified locally. Production deployment and real-provider/device acceptance were not performed.

## Branches and preservation

- Backend, admin and form are on `develop`.
- The new `networking/` app has its own local Git repository on `develop`.
- Admin `main` and `origin/main` both remain `92542902666516c4da33506be9eff0fefd9588d4`.
- The original admin work was preserved in stash `4052b6b33e31f40c3c222abe849d87d8e96d1cf6` before porting to develop. Conflicts were resolved using develop’s dark design, tabbed navigation and existing API normalization.
- Changes remain local; no commits were pushed and no production database was modified.

## Automated verification

| Area | Result and evidence |
| --- | --- |
| Full backend | `pnpm typecheck`, `pnpm test`, `pnpm build` pass across all six packages. 1,310 tests pass; 41 environment-gated tests skip in the ordinary run. Logs: `/tmp/focale-networking-final-typecheck.log`, `/tmp/focale-networking-final-tests.log`, `/tmp/focale-networking-final-build.log`. |
| Native domain database tests | Separate isolated runs cover OTP/MFA, session and client isolation, dependency revocation, duplicate-email ownership, matching, pagination, explicit availability, stand allocation, global overlap buckets, booking contention, rescheduling, exports and private own-event comparisons. See test files in `apps/api/src/modules/networking/` and `NETWORKING_PERFORMANCE.md`. |
| Native vector tests | Six isolated database regressions cover complementary ranking, model separation, event/payment/consent/visibility/block/shared-email filtering, revoked dependencies, leases and hydration. Provider adapter tests cover1536-dimensional batch validation, ordering, normalization and excluded contact data. |
| Worker integrations | All18 real-DB worker regressions pass in the separate worker test database, with injected providers. This includes current report SQL/rendering, dedupe, preferences, reminders, OTP expiry, tracking/recovery ownership, retention, contacts CSV and stale revisions. Log: `/tmp/focale-networking-final-worker-db.log`. |
| Admin |151 tests, repository-wide lint and production build pass. Full TypeScript output was compared against a clean detached develop worktree: both have exactly the same29 pre-existing errors; no new errors. Logs: `/tmp/focale-admin-baseline-ts.log`, `/tmp/focale-admin-current-ts.log`. Temporary baseline worktree removed. |
| Form |113 ordinary tests pass; one live-API test skips unless explicitly enabled. That opt-in test was separately run successfully against the local API. Production build and app/node typechecks pass. |
| PWA |44 tests, typecheck and production build pass. Manifest and injected service worker emitted; precache contains24 static entries (~1,017KiB). |
| PDF reports | Eight focused PDF/bidirectional-text tests pass. Generated French, English and Arabic PDFs were rendered with Poppler and inspected visually; charts, pagination, Arabic shaping and mixed-direction numbers are legible. Fixtures are synthetic, not event results. |
| Whitespace/conflicts | `git diff --check` passes in all four repositories; no unresolved admin merge conflicts. |

## Actual local API and browser journeys

The API and fixtures use local disposable PostgreSQL + pgvector and the `demo-focale-networking` Firebase Auth emulator. Provider keys were removed from the QA API environment; no real email/push/storage operation occurred.

- Actual organizer Firebase login, event networking overview and table creation were exercised through Chrome. The final develop dark/tabbed admin was rechecked against the running backend, including profile counts, match/reciprocity definitions, email evidence states, operational metrics and indexing/report controls.
- Two independent participant browser contexts (normal and private) authenticated as synthetic Leila/Sami accounts. Verified English URL-language handoff, Arabic RTL interface, live search, profile detail, mutual interest, persisted Arabic chat via Enter, explicit availability, meeting proposal, acceptance with automatic Table1 allocation, and cancellation restoring the slot.
- The integrated planner was inspected in desktop and emulated430×932 mobile view. Unselected times display unavailable; booked times display contact/table; cancellation restores selected availability.
- The registration form was filled through its confirmation step. Its professional profile preview matched entered data, and networking participation could be unchecked independently of registration terms. Separate real HTTP registrations proved both `networkingOptIn=true` and `false` persisted and projected consistently; those extra synthetic records were removed through the current admin API.
- Browser testing exposed the form’s existing HTTPS-only connect policy blocking a separate local HTTP API. Local Vite now supports a same-origin `/api` proxy; production CSP is unchanged. The form was reloaded and verified through that proxy.
- The built production PWA was served on8082. Chrome showed `sw.js` activated/running and installation availability. At430×932, the app shell reloaded while offline, displayed a connection/retry state, and recovered the authenticated event after networking was restored. Offline emulation was turned off and DevTools closed.
- Real HTTP smoke also covers idempotent chat retry, unread/read state, safe rescheduling, ICS export, release of every reservation on cancellation and logout revocation. Administrator analytics, indexing status and report availability endpoints were queried with the real local emulator-issued token.

## Scope of the delivered implementation

The source and tests cover the full functional module: event configuration and entitlements; registration projection/approval; OTP and optional TOTP/recovery; profile visibility, overrides and photos; discovery/facets/phonetics; mutual matching; text conversations and stable history; availability and transactional meetings; tables/stands and organizer overrides; notifications, templates, verified sender identities, preferences, digests, reminders, browser push and calendar files; badges/check-in/moderation; metrics and CSV/XLSX/PDF reporting; automatic post-event reports/contact exports; participant-owned cross-event comparisons; FR/EN/AR PWA, branding, offline shell and installation flow.

Offers and needs remain optional, matching the PDF; professional company/title/sector are required for completed profiles. Match rate is the literal matches/likes measure, with a separate reciprocal-interest measure. Five-minute global reservation buckets prevent overlapping appointments even when input windows have offsets. Current inventory and event-local dates are used consistently in operational analytics.

## Production configuration and verification boundaries

Read [NETWORKING.md](NETWORKING.md) before release. Apply the additive migrations using the checked migration runner, configure API/PWA origins, networking token secret, embedding provider, email sender/provider, storage and VAPID keys, then enable the client/event modules. A separately hosted PWA needs its backend HTTPS `VITE_API_URL`; Vercel SPA fallback and service-worker revalidation are provided.

Embedding and VAPID credentials were absent from this session. Semantic provider behavior is implemented and tested using injected responses/native vectors; the local preview truthfully uses profile-rule recommendations. No claim is made about measured real-participant recommendation quality, real email deliverability/push delivery, physical camera use, actual iOS installation, production CockroachDB version or universal sub200ms latency. The documented10k-profile benchmark is local sequential Nest/Fastify injection evidence, not a production load guarantee. These are deployment/environment acceptance boundaries, not hidden placeholder implementations.

## Local preview

- PWA: `http://127.0.0.1:8082/e/networking-demo` (production preview build).
- Admin: `http://127.0.0.1:8084/`.
- Registration form: `http://127.0.0.1:8083/networking-demo`.
- API: `http://127.0.0.1:3080/api`.

The preview contains synthetic test participants only. No real event data was imported.
