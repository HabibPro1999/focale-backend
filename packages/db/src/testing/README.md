# Disposable database test helpers

The test helper is exported as `@app/db/testing` only for the workspace's
`@app/source` resolution condition. It is not an installed production entry
point. Test suites read process variables only; they never load `.env` files.

The shared fixtures in `tests/helpers/` (seed factories, networking fixtures,
the race barrier and row readers) are exported as `@app/db/testing/fixtures`,
under the same `@app/source`-only condition. The build compiles `src/` only, so
they never reach `dist`. App tests import them from there instead of reaching
into `packages/db/tests` by relative path.

Every Vitest config in `apps/` and `packages/` is built from
`packages/vitest.shared.ts`: the resolve conditions, the SWC decorator options,
and the unit and DB-tier builders with their `TEST_DB_MAX_WORKERS` and
`TEST_DB_SETUP_TIMEOUT_MS` checks. Each config still lists its own globs and
setup files (in order); the DB-tier and perf configs also set their own
timeouts. The root `vitest.unit.setup.ts` is the
workspace's unit setup, not part of the legacy app.

Set `ALLOW_DB_TESTS=1` and `TEST_DB_ADMIN_URL` to opt in. The admin URL itself
must point at a database name with an exact `test` or `ci` token. Its hostname
must be loopback or an exact comma-separated entry in `TEST_DB_ALLOWED_HOSTS`.
Database names containing `prod`, `production`, `main`, `staging`, or `live` as
complete tokens are refused. Validation happens before a connection or DDL.
Opting in without an admin URL is an error; without the opt-in, DB tiers skip.

`createScratchDatabase({ label, to? })` creates a generated `focale_test_*`
database, explicitly provisions `vector` only on its new PostgreSQL database,
then applies the unified migration runner. `database.applyMigrations({ to? })`
can resume the runner after a fixture has been seeded. Migration execution uses
the migration client's normal transaction isolation and its own lease heartbeat.
`close()` closes the client and drops its database: PostgreSQL uses
`DROP DATABASE ... WITH (FORCE)`, while CockroachDB uses `DROP DATABASE ...
CASCADE`.

The general DB and concurrency tiers use one fully migrated PostgreSQL template
per Vitest run and clone it into a unique database for each test file. The
pinned CockroachDB CCL 26.2.5 reports `CREATE DATABASE ... TEMPLATE` as
unimplemented (issue 10151), so each file instead creates a unique database and
applies migrations from the same runner. PostgreSQL jobs use at most two file
workers; Cockroach jobs run files serially to keep migration setup within the
in-memory service budget. Every file owns and drops its own database. The full
generated `focale_test_<timestamp>_<label>_<hex>` namespace is reserved
exclusively for this helper on the allowed disposable server. The startup
janitor's age-and-name match relies on that namespace convention; it is not a
cryptographic ownership proof. It explicitly excludes the selected admin
database and removes only matching databases older than 24 hours, never a
recent template.

CI pins PostgreSQL to `pgvector/pgvector:pg16` and CockroachDB to
`cockroachdb/cockroach:v26.2.5` with an in-memory 1 GiB store. Cockroach CI
explicitly enables `feature.vector_index.enabled`; its
`sql.txn.read_committed_isolation.enabled` cluster setting is already enabled
by that version. Only application test-pool sessions set
`default_transaction_isolation = 'read committed'` through an awaited per-new-
connection hook, matching the app contract. The migration runner stays on the
engine's default SERIALIZABLE isolation; no cluster-wide default is changed.

The production runner only checks declared extension requirements. The explicit
test-only PostgreSQL `CREATE EXTENSION vector` step is limited to a newly
created, validated scratch database before migrations run.
