# B2B Networking

The networking module shares Focale’s NestJS API, Drizzle database, registration records, storage and email providers. Organizers configure it in the existing **admin develop** app. Participants use the separate `../networking` PWA. Registration forms offer a profile preview and networking participation choice.

Implementation status and requirement verification are tracked in [NETWORKING_IMPLEMENTATION.md](NETWORKING_IMPLEMENTATION.md). An implementation checklist is not proof of production readiness; verification and provider/performance boundaries are summarized in [NETWORKING_QA.md](NETWORKING_QA.md).

## Services and configuration

Run the API and worker as separate processes, using the same database and networking secrets. Add both the admin/form origins and the participant PWA origin to `CORS_ORIGIN`.

| Environment variable | Purpose |
| --- | --- |
| `PUBLIC_NETWORKING_URL` | Public PWA base URL used in registration and notification links. Local development: `http://localhost:8082`. |
| `NETWORKING_TOKEN_SECRET` | At least32 characters of cryptographically random secret material. Used for participant authentication and encrypted short-lived secrets. Rotate deliberately: existing sessions and encrypted factors depend on it. |
| `NETWORKING_EMBEDDING_API_KEY` | Credential for the embedding provider; falls back to `OPENAI_API_KEY`. Server-side only. |
| `NETWORKING_EMBEDDING_MODEL` | Defaults to `text-embedding-3-small`. The configured model must accept1536-dimensional output. |
| `NETWORKING_EMBEDDING_BASE_URL` | Defaults to `https://api.openai.com/v1`; an HTTPS OpenAI-compatible endpoint is supported. |
| `NETWORKING_VAPID_PUBLIC_KEY` | Browser push application-server public key. |
| `NETWORKING_VAPID_PRIVATE_KEY` | Browser push private key; keep server-side. |
| `NETWORKING_VAPID_SUBJECT` | Contact URI for the push sender, such as a `mailto:` URI. |
| `NETWORKING_EMAIL_SENDERS` | Optional server-owned client-to-verified-sender JSON map; see [delivery setup](packages/integrations/src/networking/README.md). |
| `TRUST_PROXY` | Comma-separated IP/CIDR addresses of trusted reverse-proxy peers whose forwarded headers may be used. **Required in production** (startup fails without it); set the literal `false` only when clients connect directly without a proxy. Unset outside production = socket address. Replace old numeric hop-count values with actual proxy peer addresses from deployment network configuration; numeric hops, `true`, wildcard trust, hostnames, and `/0` networks are rejected. |
| `RESEND_DOMAIN_READ_API_KEY` / `SENDGRID_DOMAIN_READ_API_KEY` | Optional server-side domain-read credentials for custom sender verification. |
| Existing `EMAIL_PROVIDER` and provider credentials | Networking uses the same configured email delivery provider as the platform. |

The PWA uses `VITE_API_URL` (including `/api`) and optionally `VITE_EVENT_SLUG`. The registration form uses `VITE_NETWORKING_URL` as a fallback when the public networking response has no application URL. Secrets must never appear in `VITE_*` variables.

A missing embedding credential leaves the participant directory usable with an explicitly labeled rules-based fallback. It does not generate synthetic vectors or pretend semantic recommendations succeeded. OTP delivery requires a configured email provider. Push requires HTTPS/secure-context installation support and participant permission; provide the in-app notification experience on unsupported devices.

## Database migration

Existing databases must already have the platform baseline through0011 applied. Do not rerun the baseline on an existing database.

PostgreSQL requires the pgvector extension package installed on the server. The networking migration runner enables the extension. CockroachDB uses its native `VECTOR` type; the runner detects CockroachDB and does not execute `CREATE EXTENSION`. Verify the deployed CockroachDB version has native vector support before migration.

From the backend root:

```sh
# Print the networking migration plan without connecting or changing a database.
pnpm --filter @app/db exec node scripts/migrate-networking.mjs

# Apply additive networking migrations to the explicitly configured database.
pnpm --filter @app/db exec node scripts/migrate-networking.mjs --apply
```

The runner records migration checksums and skips previously applied files; changed applied migrations cause an error. Future changes belong in a new numbered migration. Existing `drizzle-kit migrate` only knows migrations in its journal, so use the networking runner for these manually maintained migrations.

Vector lookup currently uses exact cosine distance within eligible event profiles. This keeps relevance and tenant filtering explicit. Evaluate both recall and latency before adding engine-specific approximate indexes; an approximate index is not automatically used by a weighted multi-vector ranking query.

## Event activation

1. Enable `networking`, `registrations` and `emails` for the client.
2. Open the event’s Networking settings in admin. Select manual or automatic networking approval and the payment states eligible for access.
3. Map the registration’s professional fields (company, role, sector, interests, offers and needs). Review the projected values; option IDs must resolve to meaningful labels.
4. Configure the event timezone, daily opening hours, slot duration and closures. Create spaces with capacity measured in tables or exhibitors. Tables seat two; each exhibitor can have several representatives with independent availability. See [spaces and migration](NETWORKING_SPACES.md). Enable meetings only with a valid schedule.
5. Configure branding, language choices, participant/table labels, support details and notification templates.
6. Synchronize existing registrations and approve pending participants where required. Registration changes subsequently update the networking projection.
7. For sensitive events, enable the authenticator second factor. Participants complete enrollment after email verification, and retain their single-use recovery codes.

Network access remains separate from payment state. Suspension, exclusion, withdrawal and changed registration eligibility must revoke effective access and release future meetings according to the domain policy. Hidden/paused profiles are excluded from discovery. Messaging and meeting requests require a mutual connection, and blocking applies in both directions without disclosing the block reason.

## Recommendations and recovery

Each profile has separate professional-profile, offer and need vectors. Complementary matching compares one participant’s needs with another’s offers in both directions, plus shared background. Only professional networking fields are embedded; email, phone, payment proof and administrative notes are excluded.

The worker reconciles changed profiles, batches provider calls, records the source hash/model and uses expiring leases with bounded retries. Unchanged professional content does not need another embedding call merely because activity timestamps changed. Eligibility is checked again when jobs are claimed.

Administrator endpoints:

- `GET /api/events/:eventId/networking/recommendations/status`: configured provider status, model/dimensions and job counts.
- `POST /api/events/:eventId/networking/recommendations/reindex`: retry/rebuild eligible event profiles, preserving live worker leases.

After fixing provider credentials or a delivery failure, inspect job state and explicitly reindex exhausted embedding jobs as needed. Validate recommendation relevance using reviewed real professional pairs; synthetic distance tests prove filtering and ranking mechanics, not real-world matchmaking accuracy.

## Local verification without live services

The local QA setup uses a `demo-` Firebase Auth emulator project and disposable PostgreSQL databases. The API launcher in the local QA directory removes real email, storage service-account and embedding credentials from its process environment.

```sh
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

A wrong or expired OTP on `auth/verify` stays HTTP 401 (`AUTH_1001`); no session is issued. Organizer routes (`/api/events/:eventId/networking/*`) keep the generic codes: request validation failures return `VAL_2001` with `details`.

### Consent

`registration.networkingOptIn` decides when it is a boolean (`false` excludes the registrant). When it is null, the participant's explicit PWA choice wins, then the mapped consent field (yes / no / unanswered; option labels and translations are read, never option IDs), else the registrant is undecided. Withdrawal or an explicit "no" always wins. Undecided registrants who are otherwise eligible can request a code and sign in; their session is consent-pending: every participant endpoint except `GET me`, `PATCH me` (only `consent` is applied), `DELETE me`, `POST auth/logout`, `GET config` and `auth/mfa/*` returns 403 `NETWORKING_CONSENT_REQUIRED` until `PATCH me {"consent": true}`, which records the choice and makes the profile visible. A consent mapping must point at a checkbox, radio or select field of the event's form.

## Rate limits

Participant routes (`/api/networking/:slug/…`) share a venue bucket of **24,000 requests/minute per client IP and event slug**, sized for 500–2,000 attendees behind one public IP and checked alongside identity quotas. `config` and `registration` reads skip the per-IP default limit and are bounded only by the venue bucket. Organizer routes (`/api/events/:eventId/networking/…`) are outside the venue bucket; organizer bearer requests (e.g. badge scanning) get per-token quotas. Other modules retain the legacy per-IP limits (100/minute in production by default).

Sign-in endpoints (`auth/request`, `auth/verify`, `auth/mfa/verify`) also share **300/minute per client IP and event slug** per endpoint.

Identity quotas are separate per handler:
- OTP request: **5 per 10 minutes**, keyed by event slug and trimmed, lowercase email (even when a bearer header is supplied).
- OTP verify: **10/minute per event slug and challenge ID**. The verify contract contains no email; the existing database-enforced five-attempt challenge cap remains in place. Invalid/missing challenge IDs fall back to IP.
- MFA: **10/minute per bearer session** per endpoint.
- Chat sends: **30/minute per bearer session**.
- Other authenticated networking requests, including mutations: the configured default limit per bearer session (100/minute in production), unless an endpoint has a tighter override (reports: 5/minute).

Trackers hash session tokens and OTP identities; raw tokens/emails are not stored in throttle keys. Other anonymous requests fall back to IP. The client IP uses `X-Forwarded-For` only when the immediate socket peer matches an explicitly configured `TRUST_PROXY` IP/CIDR; requests from other peers ignore forwarded headers. Throttled participant responses use HTTP 429 and `NETWORKING_RATE_LIMITED` inside the normal error envelope. **All quotas are in memory and therefore per API replica**: with N replicas behind a load balancer the effective ceilings are up to N times higher. The OTP service also retains its existing persistent request/attempt checks.

## Participant lists

`GET connections` and `GET meetings` always paginate (`limit` 1–200, default 50; opaque `cursor`). The first page returns `{ items, nextCursor, total }`; later pages omit `total`. Cursors are scoped to the event, participant and list, and survive organizer configuration edits. `GET connections/:id`, `GET connections/with/:profileId` (`{ connection }`, possibly null) and `GET meetings/:id` return single items in the list shapes. Calendar, CSV and personal-data exports are never truncated.
