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
statement. On CockroachDB, a heartbeat renewal that commits while a fenced
transaction is open can fail that fence with a serialization error (40001);
the transaction is rolled back and run again, up to five times. A retry only
repeats work that was rolled back: a `transaction none` statement commits on
its own, so only its ledger write is retried. A transactional unit that stays
open longer than the 30 s heartbeat interval can hit a renewal on every
attempt; it then fails safely (rolled back, re-runnable), so keep transactional
units short on CockroachDB, for example as `per-statement` steps.

SQL is divided only at explicit `--> statement-breakpoint` markers, both the
inline Drizzle form (`;--> statement-breakpoint`) and standalone lines used by
the CockroachDB override. The runner never splits on ordinary semicolons. New
files should use breakpoints wherever individual statements need separate
transactions. The `-- migrate:` header is removed from whole-file and per-step
checksums so adding runner metadata does not change historical checksums. The
CockroachDB 0018 execution variant has a fixed legacy crosswalk in
`legacy-networking.ts`; changes to it require an explicit crosswalk update.
Catalog verification reads every marked statement and has explicit metadata
for older multi-statement SQL whose bodies remain fixed for compatibility. It
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
- `adopt [--apply]` classifies an existing database that has no ledger. It is a
  dry run unless `--apply` is given; `--apply` writes ledger rows only (never
  migration SQL) under the same lease as `apply`.

`apply` refuses to run on a non-empty schema without a non-empty migration
ledger. Existing databases must be adopted before applying new migrations.

## Adopting an existing database

`adopt` gathers three kinds of evidence for every migration of this build:

- the old `networking_migrations` ledger written by `migrate-networking.mjs`
  (whole-file checksums for 0012+, `cockroach/0017`, and on CockroachDB the
  `0018_networking_spaces.sql:step:N` rows, mapped through the fixed crosswalk
  in `legacy-networking.ts` onto the explicit `cockroach/0018` statements);
- `_prisma_migrations` from the legacy app: finished rows with no failed row
  record 0000 as `baseline` when its catalog probes also match;
- catalog probes derived from each file's DDL (tables, types, indexes, added
  columns and constraints, dropped indexes) plus its `verify` directives.
  An object that a later migration declares again (0018 drops an index 0012
  creates) is judged only by the later migration; extension prerequisites are
  not evidence.

Decision per migration: all probes pass → `applied`; none → pending; partial on
an `idempotent` file → pending; partial on a non-idempotent file, a
non-idempotent file with no probes, a legacy ledger that disagrees with the
probes (recorded but missing objects, objects present but unrecorded, unknown
or tampered rows), a failed Prisma migration or an existing ledger →
**abort**, with nothing written. An interrupted CockroachDB 0018 (legacy step
rows but no file row) is written as its completed steps so `apply` resumes it.
Pending migrations are left for `apply`, which also evaluates `defer-unless`:
on CockroachDB with populated `networking_embeddings`, 0017 is recorded as
`deferred` and 0018/0019 still apply. 0011 is a guarded data repair without
catalog objects, so adoption leaves it pending and `apply` re-runs it (it is
declared idempotent, but it rewrites `registrations.total_amount`; see rollout
step 4). The old `networking_migrations` and `_prisma_migrations`
tables are left untouched.

## Boot check (`MIGRATIONS_CHECK`)

The API (before `listen`) and the worker (before it starts its jobs) call
`assertSchemaCurrent()` from `@app/db`. On a connection from the application
pool it asserts the session time zone is UTC, then compares the ledger with the
migrations shipped in the build. A missing ledger, a pending migration, a
checksum/variant mismatch, a non-UTC session or an unreachable database is an
error; deferred migrations and ledger rows newer than the build (a rollback)
only warn. The check is bounded (15 s) and read-only.

- `MIGRATIONS_CHECK=enforce`: errors stop the process at boot.
- `MIGRATIONS_CHECK=warn` (default): errors are logged and boot continues.
- `MIGRATIONS_CHECK=off`: no check.

## Production rollout (operator steps)

Run these against production only in a planned window, with credentials loaded
the way operators already do; nothing here is automated by the repository.

1. Deploy this build with `MIGRATIONS_CHECK=warn` (the default). The boot check
   logs the missing ledger but the services start.
2. Run `node packages/db/dist/migrator/cli.js adopt` (dry run) and review the
   report: every migration's verdict, its probe counts, legacy ledger evidence
   and any abort reasons. This also settles whether production has 0016/0017.
3. Run `adopt --apply`. It re-assesses under the migration lease and writes the
   same rows, or aborts without writing if the evidence changed.
4. Before `apply`, check what 0011 would change. Adoption cannot prove 0011 (a
   guarded data repair of `registrations.total_amount` with no catalog
   objects), so it stays pending and `apply` runs it again. Run its predicate
   read-only first:

   ```sql
   SELECT id, event_id, total_amount, price_breakdown->>'subtotal' AS subtotal
   FROM registrations
   WHERE sponsorship_amount > 0
     AND jsonb_typeof(price_breakdown->'subtotal') = 'number'
     AND jsonb_typeof(price_breakdown->'total') = 'number'
     AND total_amount = (price_breakdown->>'total')::integer
     AND (price_breakdown->>'subtotal')::integer > total_amount;
   ```

   No rows: re-running 0011 changes nothing; continue. Any rows: stop. `apply`
   would rewrite those live totals from net to gross, so get sign-off on that
   row list first (the same bar as the plan's per-row money-repair manifest).
5. Off-peak, run `apply --dry-run`, then `apply --yes` for the pending
   migrations (on CockroachDB 0017 stays deferred while embeddings exist; apply
   it later with `apply --apply-deferred=0017 --yes` in a maintenance window).
6. Run `verify --schema`; it must report no errors.
7. Set `MIGRATIONS_CHECK=enforce` on every service and add the Render
   Pre-Deploy Command `node packages/db/dist/migrator/cli.js apply --yes` to
   the API and worker services (the lease serializes them). Use `/health/live`
   as the API health check path.
8. After this rollout, retire the laptop migration flow (`load-env.fish`).
