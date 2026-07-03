# Schema (Prisma → Drizzle port)

One file per domain cluster; all tables/enums re-exported from `index.ts` and the
package barrel (`src/index.ts`). 28 legacy models + the `_AccessPrerequisites` join
table = **29 tables**, **19 pg enums**.

## Conventions

- **Casing**: property names are camelCase; `casing: 'snake_case'` (client + drizzle
  config) derives column names. Explicit column names are passed only where the legacy
  column diverges from `snake_case(property)`:
  - `emailLogs.providerMessageId` → `sendgrid_message_id` (kept for back-compat).
  - `registrations.role` → `registration_role`.
  - `_AccessPrerequisites.a` / `.b` → columns `"A"` / `"B"`.
- **IDs**: every PK/FK is `text` — the live CockroachDB columns are `STRING`, and
  Prisma's `@default(uuid())` is an app-side default, not a DB-native uuid type.
  Every PK uses `idPk()` (`text` + app-side UUIDv7 via `newId`) EXCEPT:
  - `users.id` — `text().primaryKey()`, no default (Firebase UID, app-supplied).
- **FKs**: every FK is `onUpdate: 'cascade'` (Prisma default, reproduced explicitly);
  `onDelete` matches the prisma schema per column (cascade / set null / restrict).
  All FK columns are `text` (matching every PK).
- **Timestamps**: `timestamp({ precision: 3 })` — naive `TIMESTAMP(3)`, NO timezone,
  matching the live DB. `createdAt`/`updatedAt` via the `timestamps` helper
  (`updatedAt` is app-managed via `$defaultFn` on insert + `$onUpdate`, with NO DB
  default — matching the live `TIMESTAMP(3) NOT NULL` column). Tables without `updatedAt`
  (payment_transaction, sponsorship_batches, sponsorship_usages, abstract_revisions,
  access_check_ins, audit_logs) declare only the columns they have.
- **Types matching the live dump**: `event_access.companion_price` is `integer`
  (INT4, matching `_schema_full.sql` and its sibling `price`). `book_line_spacing`,
  `average_score`, `score` are `double precision` (FLOAT8). Text arrays
  (`enabled_modules`, `access_type_ids`, `dropped_access_ids`, `covered_access_ids`)
  are nullable `text[]` with a default (Prisma scalar-list quirk on CockroachDB — no
  NOT NULL); `applicable_roles` is a nullable `RegistrationRole[]` enum array.

## Raw-SQL-only indexes — NOT tracked by drizzle-kit

Drizzle's schema builder cannot express partial (`WHERE`) unique indexes or GIN /
inverted indexes, so **`drizzle-kit generate` / `drizzle-kit migrate` will never see or
track these**. They live in the hand-written `migrations/0001_raw_indexes.sql`, applied
after `0000_init.sql`, with index NAMES byte-for-byte identical to the legacy
CockroachDB migrations (app code matches on them for P2002 mapping and dedupe guards):

| Index | Table | Kind |
|---|---|---|
| `email_template_registration_uniq` | email_templates | partial unique (`WHERE abstract_trigger IS NULL`) |
| `email_template_abstract_uniq` | email_templates | partial unique (`WHERE trigger IS NULL`) |
| `abstracts_event_id_author_email_normalized_key` | abstracts | partial unique (`WHERE ... IS NOT NULL`) |
| `email_logs_registration_trigger_active_key` | email_logs | partial unique (status + queued_at cutoff) |
| `email_logs_abstract_submission_ack_active_key` | email_logs | partial unique |
| `email_logs_template_recipient_trigger_active_key` | email_logs | partial unique (status + queued_at cutoff) |
| `abstracts_event_id_code_number_key` | abstracts | partial unique (`WHERE code_number IS NOT NULL`) |
| `outbox_events_dedupe_key_key` | outbox_events | partial unique (`WHERE dedupe_key IS NOT NULL`) |
| `registrations_access_type_ids_inverted_idx` | registrations | GIN (CRDB `INVERTED INDEX`) |

**CRDB vs Postgres divergence**: the last one is a CockroachDB `INVERTED INDEX` in prod.
`0001` writes it as `CREATE INDEX ... USING GIN`, which is valid on Postgres and is also
accepted by CockroachDB as an alias for `INVERTED INDEX` — so one statement covers both.
Everything else in `0001` (partial predicates comparing enum columns to string literals,
`queued_at >= TIMESTAMP '...'`) is standard SQL valid on both engines. Verified by
applying `0000` + `0001` to a scratch local Postgres DB.
