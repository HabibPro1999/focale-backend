# Writing a migration

Rules for new SQL under `packages/db/migrations/`. Every migration runs through
the unified runner on PostgreSQL and on CockroachDB (production). How the runner
works (ledger, lease, adoption, boot check) is in the
[migrator README](../packages/db/src/migrator/README.md); this page is about
writing a file that is safe on both engines and during a deploy.

## Numbering

- A file is `NNNN_name.sql`; `NNNN` is its ledger id and migrations run in
  numeric order.
- Take the next free number when the PR merges. While several branches add
  migrations, the coordinator assigns the numbers; two files with the same
  number in one directory fail the lint (`plan`, `apply`, CI).
- `node packages/db/dist/migrator/cli.js new <name>` (after
  `pnpm --filter @app/db build`) creates the next number with a
  `transaction per-file` header.
- Never number a new file below a migration already on `develop`. `apply` would
  still run it, since it applies whatever the ledger lacks, but after later
  migrations that other databases ran before it.
- Never edit, rename, renumber or delete a merged migration. The ledger stores
  each file's checksum; a changed body fails `verify` and the boot check (the
  `-- migrate:` header lines are left out of the checksum). Fix mistakes with a
  new migration.
- `migrations/cockroach/NNNN_name.sql` replaces the shared file with the same
  number on CockroachDB, or adds a CockroachDB-only migration (0017, the vector
  index). Prefer SQL both engines accept; 0017 and 0018 are the only overrides.

## Header directives

Every file starts with `-- migrate:` lines, before any other line. The runner
refuses unknown or duplicated directives.

| Directive | Meaning | Use it for |
|---|---|---|
| `transaction per-file` | The whole file in one transaction. | One schema change, or a new table (0022) with its indexes (0023). |
| `transaction per-statement` | Each chunk between `--> statement-breakpoint` markers in its own transaction; one SQL statement per chunk (lint). | Several schema changes, or a data change plus a schema change (0024, 0029, 0030, 0031, 0032). |
| `transaction none` | No transaction. | Statements whose result cannot be used in the transaction that makes it, such as `ALTER TYPE … ADD VALUE` (0028). |
| `idempotent` | Safe to replay after a partial run. Required for `per-statement` and `none`. | Use `IF NOT EXISTS` / `IF EXISTS` forms and guarded updates (`WHERE … IS DISTINCT FROM …`). |
| `verify <sql>` | A query returning one boolean; `verify --schema` and `adopt` run it. | Changes the catalog probes cannot see: enum values (0028), a rebuilt index predicate (0024), an index whose presence matters (0030). |
| `deferrable` + `defer-unless "<sql>"` | The quoted query (JSON string) returns one boolean; false records the migration as `deferred` and later migrations still run. `apply --apply-deferred=NNNN --yes` retries it. | A migration that cannot succeed until data is fixed: 0030 waits until no event stores a sponsorship code twice. |
| `requires-extension <name>` | Checks that a PostgreSQL extension is installed; never installs it. | `vector` (0013). `CREATE EXTENSION` in a file fails the lint. |

The runner splits SQL only at `--> statement-breakpoint` markers, never at
semicolons. A file may not contain `BEGIN` or other transaction control.

The catalog probes (used by `verify --schema` and `adopt`) are derived from
`CREATE TABLE`, `CREATE TYPE`, `CREATE [UNIQUE|VECTOR] INDEX`, `DROP INDEX`,
`DROP TABLE`, `ALTER INDEX … RENAME TO`, `ALTER TABLE … ADD COLUMN` and
`ALTER TABLE … ADD CONSTRAINT`. Anything else (`DROP COLUMN`,
`DROP CONSTRAINT`, data changes) needs a `verify` directive, or a
`packages/db/src/migrator/catalog.ts` change as 0033 made for `DROP TABLE`.

## Expand and contract

The Render Pre-Deploy Command applies migrations while the previous release is
still serving, and a rollback runs the previous code on the new schema. There
are no down migrations. Each migration must therefore work with the code before
it and the code after it:

1. **Expand**, before or with the code that uses it: new tables, new nullable
   columns or columns with a default, new indexes, new enum values. The code
   must accept rows written before the change. Examples: 0029 adds
   `provider_attempted_at` and `provider` as nullable columns; 0032 adds
   nullable render-image columns and the renderer falls back to the original
   image while they are empty.
2. **Migrate data** with a guarded, idempotent statement, or with a script for
   large or reviewed changes (`backfill-certificate-renders` fills 0032's
   columns; the repair scripts in `apps/worker/src/scripts/` run as dry run,
   then `--apply`).
3. **Contract** in a later release, once no running code reads the old shape:
   drop the column, table or index. 0033 dropped `abstract_code_sequences`
   after the last reader was gone.

To replace an index without a window where neither exists: create the new one,
then drop the old one (0031), or build it under a temporary name, drop the old
one and `ALTER INDEX … RENAME TO` the old name (0024).

Never in one step: renaming a column or table the running code uses, adding
`NOT NULL` without a default to a table with rows, or changing a column's type
in place. Split them into expand, backfill, code switch, contract.

A migration that must be applied before the code that needs it says so in its
PR ("apply 0031 before this code"); the Pre-Deploy Command guarantees that
order on Render. Add the line to
[production-rollout-checklist.md](production-rollout-checklist.md) when the
migration needs anything beyond `apply`.

## CockroachDB rules

- **Never reference a column in the same file that adds it.** CockroachDB makes
  a schema change usable only after its transaction commits, so an `UPDATE`,
  index or constraint on a column added earlier in the same transaction fails.
  The shared 0018 did this in one transaction and needed a statement-by-statement
  CockroachDB override. Add the column in one migration and use it from the
  next number: 0025 adds `networking_profiles.erased_at`, 0031 indexes it. A
  table created in the file can be indexed in the same file (0023).
- **One schema change per transaction** when a file has several: use
  `per-statement` with a breakpoint between them, and keep data changes and
  schema changes in separate chunks (0030).
- **No `DO` blocks.** CockroachDB does not run `ALTER TABLE` inside PL/pgSQL.
  Make statements idempotent with `ADD COLUMN IF NOT EXISTS`,
  `CREATE INDEX IF NOT EXISTS` and `DROP … IF EXISTS`. PostgreSQL has no
  `ADD CONSTRAINT IF NOT EXISTS`: write `DROP CONSTRAINT IF EXISTS` and then
  `ADD CONSTRAINT` (0005).
- **Keep transactional units short.** A transaction open across the runner's
  30 s lease renewal can fail with 40001 on every retry on CockroachDB; it rolls
  back safely, but the migration never finishes. Split long work into
  `per-statement` chunks.
- `CREATE INDEX … USING GIN` works on both engines (CockroachDB reads it as an
  inverted index, 0001). Vector indexes differ per engine, hence the
  CockroachDB-only 0017.
- In queries: CockroachDB reads a leading zero as octal when casting a string
  to `INT` (`'008'` fails); cast digit strings through `DECIMAL`
  (`packages/db/src/queries/registrations.ts`).

## Partial unique indexes and `ON CONFLICT`

- An `ON CONFLICT (cols)` that targets a **partial** unique index repeats the
  index predicate, otherwise PostgreSQL cannot infer the index (error 42P10):

  ```sql
  INSERT INTO outbox_events (…) VALUES (…)
  ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
  RETURNING id
  ```

  In Drizzle: `onConflictDoNothing({ target: outboxEvents.dedupeKey, where: sql.raw('"dedupe_key" IS NOT NULL') })`
  (`enqueueOutboxEvent` in `packages/db/src/outbox/outbox.ts`).
- Target-less `ON CONFLICT DO NOTHING` only where any unique violation means
  "skip this row" (`insertEmailLogsSkippingConflicts` in
  `packages/db/src/queries/email.ts`).
- A query meant to use a partial index repeats its predicate: the networking
  delivery claims repeat 0031's index predicates.
- Test every `ON CONFLICT` against a migrated database on both engines (the
  CI DB tier). When nothing uses `ON CONFLICT` against a new unique index, say
  so in the migration's comment (0030).
- List every partial or engine-specific index in the table of
  [the schema README](../packages/db/src/schema/README.md#indexes-and-constraints-from-raw-migrations).

## Timestamps

A new timestamp column is `TIMESTAMPTZ(3)` in SQL and
`timestamp({ precision: 3, withTimezone: true })` in Drizzle. Calendar logic
reads UTC. See the conventions in
[the schema README](../packages/db/src/schema/README.md#conventions).

## PR checklist

1. The number the coordinator assigned; header directives; a comment saying why
   the migration exists, which plan item it serves, and any operational effect
   (a plain `CREATE INDEX` briefly blocks writes to the table on PostgreSQL).
2. The Drizzle schema in `packages/db/src/schema/` declares the same final
   columns, indexes and constraints: the drift test
   (`packages/db/tests/migration/schema.migration.test.ts`) compares them.
3. A migration test in `packages/db/tests/migration/`: fresh apply, a rerun for
   idempotent files, the deferral for deferrable ones. `pnpm test:migration`
   runs on both engines in CI.
4. If a later file supersedes an object an earlier one created (a dropped or
   replaced index or table), update the superseded list in
   `packages/db/src/migrator/adopt.test.ts` (0031 and 0033 did).
5. `node packages/db/dist/migrator/cli.js plan` passes (CI runs it in the
   image).
6. The PR body says whether the migration must be applied before the code, and
   anything an operator must do.
