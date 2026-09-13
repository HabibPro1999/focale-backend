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
4. Configure the event timezone, daily opening hours, slot duration and closures. Create tables or exhibitor stands. Enable meetings only with a valid schedule.
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
