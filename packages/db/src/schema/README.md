# Schema (Prisma → Drizzle port)

One file per domain cluster; all tables/enums re-exported from `index.ts` and the
package barrel (`src/index.ts`): the tables ported from the legacy Prisma models
(with the `_AccessPrerequisites` join table), then the networking, outbox, reference
counter and worker heartbeat tables added since, and **19 pg enums**. The
fresh-migration drift test (`tests/migration/schema.migration.test.ts`) requires a
migrated database to have exactly these tables, columns, indexes, CHECKs and FKs.

There are no Drizzle `relations()`: the client is built without a schema, so the
relational query API (`db.query.*`, `with:`) is not available; queries join
explicitly.

## Conventions

- **Casing**: property names are camelCase; `casing: 'snake_case'` (client + drizzle
  config) derives column names. Explicit column names are passed only where the legacy
  column diverges from `snake_case(property)`:
  - `emailLogs.providerMessageId` → `sendgrid_message_id` (kept for back-compat).
  - `registrations.role` → `registration_role`.
  - `_AccessPrerequisites.a` / `.b` → columns `"A"` / `"B"`.
- **IDs**: every id column (PK or FK) is `text` — the live CockroachDB columns are `STRING`, and
  Prisma's `@default(uuid())` is an app-side default, not a DB-native uuid type.
  PKs use `idPk()` (`text` + app-side UUIDv7 via `newId`) EXCEPT natural keys
  with no default, supplied by the app:
  - `users.id` — Firebase UID.
  - One row per parent: `networking_configs.event_id`,
    `networking_second_factors.profile_id`, `networking_embedding_jobs.profile_id`.
  - `registration_reference_counters.prefix`, `worker_heartbeats.worker_id`.
  - `networking_allocation_locks` — composite `(event_id, bucket_start)`, the
    second a `timestamptz`.
  - `_AccessPrerequisites` has no PK, only the unique `(A, B)` index.
- **FKs**: on the tables ported from Prisma every FK is `onUpdate: 'cascade'`
  (Prisma default, reproduced explicitly) and `onDelete` matches the prisma schema
  per column (cascade / set null / restrict). The networking tables (0012 on)
  declare only `onDelete`, so their FKs are `ON UPDATE NO ACTION` as in their SQL.
  All FK columns are `text`, like the id PKs they reference.
- **New columns use `timestamptz`**: a new timestamp column is `TIMESTAMPTZ(3)` in
  SQL and `timestamp({ precision: 3, withTimezone: true })` in Drizzle, as most
  networking columns already are (their `instant()` helper). Calendar logic reads
  UTC (`getUTC*`, e.g. the reference-number year in `allocateReferenceNumber`),
  never the process time zone. The naive legacy columns below keep their type;
  do not copy it into new tables or columns.
  Batch 3 of the remediation (migrations 0021–0033) mostly followed this:
  0022 (`networking_allocation_locks`), 0023 (`worker_heartbeats`) and 0025
  (`purge_started_at`, `purged_at`, `erased_at`) are `TIMESTAMPTZ(3)`. One
  exception: 0029 added `email_logs.provider_attempted_at` as naive
  `timestamp(3)`, like the rest of `email_logs`. It is only tested for
  `IS NULL` and written from the database clock or `new Date()`, so its type has
  no effect today; leave it as it is unless the table's timestamps move
  together. Comparisons between naive and `timestamptz` values go through the
  session time zone, which the migrator and the application pool pin to UTC (the
  boot check asserts it).
- **Timestamps (legacy)**: `timestamp({ precision: 3 })` — naive `TIMESTAMP(3)`, NO timezone,
  matching the live DB. `createdAt`/`updatedAt` via the `timestamps` helper
  (`updatedAt` is app-managed via `$defaultFn` on insert + `$onUpdate`, with NO DB
  default — matching the live `TIMESTAMP(3) NOT NULL` column), except the three
  networking tables created by 0013/0018 whose historical SQL defines `DEFAULT now()`;
  those table declarations preserve both the SQL default and app-side hooks. Tables without `updatedAt`
  (for example payment_transaction, sponsorship_batches, sponsorship_usages, abstract_revisions,
  access_check_ins, audit_logs) declare only the columns they have.
- **Types matching the migrations**: `event_access.companion_price` is `bigint`
  (INT8, as `0000` creates it) while its sibling `price` is `integer`. `book_line_spacing`,
  `average_score`, `score` are `double precision` (FLOAT8). Text arrays
  (`enabled_modules`, `access_type_ids`, `dropped_access_ids`, `covered_access_ids`)
  are nullable `text[]` with a default (Prisma scalar-list quirk on CockroachDB — no
  NOT NULL); `applicable_roles` is a nullable `RegistrationRole[]` enum array.

## Indexes and constraints from raw migrations

The migrations after `0000` are hand-written SQL (the runner applies them in
order to preserve migration history). Every index, column and constraint they
leave in the final catalog is also declared in this Drizzle schema, so the drift
test can compare a fresh migration against the application model. The partial
and engine-specific indexes from the legacy CockroachDB migrations keep their
names byte-for-byte (application error mapping and dedupe guards depend on them):

| Index | Table | Kind |
|---|---|---|
| `email_template_registration_uniq` | email_templates | partial unique (`WHERE abstract_trigger IS NULL`) |
| `email_template_abstract_uniq` | email_templates | partial unique (`WHERE trigger IS NULL`) |
| `abstracts_event_id_author_email_normalized_key` | abstracts | partial unique (`WHERE ... IS NOT NULL`) |
| `email_logs_registration_trigger_active_key` | email_logs | partial unique (status + queued_at cutoff) |
| `email_logs_abstract_submission_ack_active_key` | email_logs | partial unique |
| `email_logs_template_recipient_trigger_active_key` | email_logs | partial unique (status + queued_at cutoff) |
| `outbox_events_dedupe_key_key` | outbox_events | partial unique (`WHERE dedupe_key IS NOT NULL`) |
| `registrations_access_type_ids_inverted_idx` | registrations | GIN (CRDB `INVERTED INDEX`) |
| `email_logs_dedupe_key_active_key` | email_logs | partial unique (active statuses only) |
| `abstract_book_jobs_event_id_active_key` | abstract_book_jobs | partial unique (pending/running only) |
| `abstract_themes_config_id_sort_order_active_key` | abstract_themes | partial unique (active themes only) |
| `networking_messages_sender_created_idx` | networking_messages | composite index from 0019 |
| `networking_notifications_unread_idx` | networking_notifications | partial index from 0019 |
| `networking_meetings_requester_start_idx` | networking_meetings | composite index from 0019 |
| `networking_meetings_recipient_start_idx` | networking_meetings | composite index from 0019 |

`abstracts_event_id_code_number_key` was intentionally removed in migration 0002
and is not part of the final schema. The legacy `abstract_code_sequences` table
(a global per-final-type counter nothing used; codes come from
`abstract_code_counters`) is dropped by 0033. The old `networking_tables_event_name_key`
is dropped by 0018 and replaced with the space-scoped uniqueness rule.

**CRDB vs Postgres divergence**: the last one is a CockroachDB `INVERTED INDEX` in prod.
`0001` writes it as `CREATE INDEX ... USING GIN`, which is valid on Postgres and is also
accepted by CockroachDB as an alias for `INVERTED INDEX` — so one statement covers both.
Everything else in `0001` (partial predicates comparing enum columns to string literals,
`queued_at >= TIMESTAMP '...'`) is standard SQL valid on both engines. Verified by
applying `0000` + `0001` to a scratch local Postgres DB.
