# Unified database migrator

Migration files live in `packages/db/migrations/` as `NNNN_name.sql`. A file at
`migrations/cockroach/NNNN_name.sql` replaces the shared file with the same
number on CockroachDB, or adds an engine-only migration when no shared file has
that number. Numbers are the ledger IDs and migrations run in numeric order.

Every file starts with a `-- migrate:` header. It declares `transaction
per-file`, `per-statement`, or `none`. `idempotent` records that a migration is
safe to replay after partial completion; per-statement and non-transactional
migrations must declare it. `requires-extension <name>` checks for
an installed PostgreSQL extension; it never installs one, and CockroachDB's
native vector support does not require a PostgreSQL extension. `deferrable`
must be paired with `defer-unless "<sql>"`; that query must return one boolean
value, where true means it is safe to apply and false records the migration as
deferred while allowing later migrations to continue. `verify <sql>` is another
boolean query used by schema verification and adoption. A deferrable CockroachDB
vector index is also recorded as deferred when its cluster feature setting is
off; it still requires an explicit `--apply-deferred` after an administrator
enables the setting.

Provision PostgreSQL extensions before invoking the runner. The disposable DB
test helper may install `vector` in its newly-created test database; production
`apply` only verifies that the extension is already present. On each migration,
the runner checks lease ownership between statements and fences each commit by
updating the conditional lease row. If another runner takes an expired lease,
the current transaction rolls back and the runner stops before the next SQL
statement.

SQL is divided only at explicit `--> statement-breakpoint` markers, both the
inline Drizzle form (`;--> statement-breakpoint`) and standalone lines used by
the CockroachDB override. The runner never splits on ordinary semicolons. New
files should use breakpoints wherever individual statements need separate
transactions. The `-- migrate:` header is removed from whole-file and per-step
checksums so adding runner metadata does not change historical checksums. The
CockroachDB 0018 execution variant has a fixed legacy crosswalk in
`legacy-networking.ts`; changes to it require an explicit crosswalk update.
Catalog verification reads every marked statement and has explicit metadata
for older multi-statement networking files whose bodies cannot change. It
checks each object's final declared state so later index drops supersede older
create expectations; adoption still receives each migration's own probes.

The CLI is emitted at `packages/db/dist/migrator/cli.js`:

- `plan` lints files and prints both engine plans without connecting to a DB.
- `status` reads the ledger.
- `apply [--dry-run] --yes` applies pending migrations after setting the
  session time zone to UTC and acquiring a conditional-update lease.
  A dry-run reports a precondition as unknown if an earlier pending migration
  creates the relation the condition needs; it does not guess or modify schema.
- `apply --apply-deferred=NNNN --yes` explicitly retries a migration already
  recorded as deferred.
- `verify [--schema]` checks ledger checksums and, with `--schema`, catalog and
  declared SQL probes.
- `new <name>` creates the next numbered migration with a transaction header.
- `adopt` is intentionally disabled in item 1.2. It must fail without writes
  until item 1.4 adds evidence-based classification and ledger writes.

`apply` refuses to run on a non-empty schema without a non-empty migration
ledger. Existing databases must be adopted before applying new migrations.
