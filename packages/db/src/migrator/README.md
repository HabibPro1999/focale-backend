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
updating the conditional lease row. Lease times always use `clock_timestamp()`,
because `now()` is frozen at the start of a transaction. If another runner takes an expired lease,
the current transaction rolls back and the runner stops before the next SQL
statement. On CockroachDB, a heartbeat renewal that commits while a fenced
transaction is open can fail that fence with a serialization error (40001);
the transaction is rolled back and run again, up to five times. A retry only
repeats work that was rolled back: a `transaction none` statement commits on
its own, so only its ledger write is retried. A transactional unit that stays
open longer than the 30 s heartbeat interval can hit a renewal on every
attempt; it then fails safely (rolled back, re-runnable), so keep transactional
units short on CockroachDB, for example as `per-statement` steps.

The runner never records a schema change it saw fail. On CockroachDB with
`autocommit_before_ddl` off, a schema change on a table that is not
`schema_locked` runs after COMMIT; when it fails (a unique index that meets
duplicate rows), COMMIT returns XXA00 ("transaction committed but schema change
aborted"): the change is rolled back but the transaction's other writes,
ledger rows included, stay committed. The runner then removes the step rows
that transaction wrote and its migration row (or puts back the deferred row an
`--apply-deferred` replaced) in a new fenced transaction, and fails; fix the
data and run the same `apply` again. With `autocommit_before_ddl` on (the
CockroachDB 26.2 default), CockroachDB commits the open transaction before each
schema change and runs the change on its own, so the statement fails itself
and is never recorded; there a `per-file` file is not one transaction.

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
checks each object's final declared state so later index and table drops
supersede older create expectations; adoption still receives each migration's own probes.

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
- catalog probes derived from each file's DDL (tables and every column they
  declare, enum types and every label they declare, indexes, added columns and
  constraints, dropped indexes and tables) plus its `verify` directives.
  Probes check existence only, never types. A foreign key also matches under
  Prisma's default name (`<table>_<columns>_fkey`, `prismaForeignKeyName` in
  `catalog.ts`), which is how the legacy app named its keys. An
  object that a later migration declares again (0018 drops an index 0012
  creates; 0033 drops a table 0000 creates, with its columns) is judged only by
  the later migration, and a label added later (0028) is not required earlier;
  extension prerequisites are not evidence.

Decision per migration: all probes pass → `applied`; none → pending; partial on
an `idempotent` file → pending; partial on a non-idempotent file, a
non-idempotent file with no probes, a legacy ledger that disagrees with the
probes (recorded but missing objects, objects present but unrecorded, unknown
or tampered rows), a failed Prisma migration or an existing ledger →
**abort**, with nothing written; the report lists every probe that failed
(`missing:` lines), so a column or enum label that `prisma db push` never
created on production shows up by name. An interrupted CockroachDB 0018
(legacy step rows but no file row) is written as its completed steps so
`apply` resumes it. Pending migrations are left for `apply`, which also
evaluates `defer-unless`: on CockroachDB with populated
`networking_embeddings`, 0017 is recorded as `deferred` and 0018/0019 still
apply. 0011 is a guarded data repair without
catalog objects, so adoption leaves it pending and `apply` re-runs it (it is
declared idempotent, but it rewrites `registrations.total_amount`; see rollout
step 4). 0010's `verify` accepts the legacy TIMESTAMPTZ(6) check-in columns,
so production records it as applied and its rewrite never runs. The old
`networking_migrations` and `_prisma_migrations` tables are left untouched.
`tests/migration/legacy-prisma-adopt.migration.test.ts` adopts the legacy
production schema, generated by Prisma from main, on both engines and lists
the verdict it expects for every migration.

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

Production runs `enforce` from the first boot of any Nest service, so a pending
or unknown migration stops the deploy instead of failing queries at run time.

In production (`NODE_ENV=production`) a database with application tables but
no ledger, or an empty one, has not been adopted: the API and a job-running
worker refuse to start on it in every mode, `off` included
(`UnadoptedDatabaseError`, whose message says how to adopt). Under `off` that
is the only query. An unreachable database keeps the mode's behavior. A worker
with `RUN_WORKERS=false` idles before the check (`apps/worker/src/main.ts`), so
its shell can run the rollout below.

## Production rollout (operator steps)

The one-time move of the legacy production database (Prisma on CockroachDB,
main at tag `legacy-final`) onto this ledger. Every step runs **before any Nest
service serves traffic**: in production the API and a job-running worker refuse
to start on a database that was never adopted (boot check above), and a Nest
build on the legacy schema would fail on almost every query that names a new
column or table. The whole cutover around these steps (Render settings,
frontends first, stopping the legacy workers, smoke tests, rollback) is in the
root README, "Production cutover". Run them in the maintenance window, after a
verified backup and after the legacy background work is stopped and drained,
as the database user the services use.

Where to run them: a shell of this build with the production `DATABASE_URL`.

- The Render worker service of this build while it has `RUN_WORKERS=false`. It
  idles before the boot check (`apps/worker/src/main.ts:48-63`, check at :69),
  but its environment must still pass the config parse (`loadConfig`, :26).
  Until 0023 creates `worker_heartbeats` it logs `worker heartbeat row write
  failed` and prune warnings and keeps idling; that is expected.
- Or a built checkout (`pnpm install --frozen-lockfile && pnpm build`) with the
  production `DATABASE_URL` in the shell environment.

Rehearse the whole sequence first on a restored copy of production, on the
same CockroachDB version, and boot the API and the worker of the release image
against it.

1. **Preflight (read-only).**
   `node packages/db/dist/ops/cutover-preflight-cli.js preflight --out <dir>`
   (from `packages/db`: `pnpm cutover:preflight preflight --out <dir>`;
   `--out=<dir>` also works). In the image only `/tmp` is writable by the
   `node` user: use an absolute `<dir>` under it and copy it out. It runs every query in one READ ONLY transaction
   on a read-only session, proves a write is refused (SQLSTATE 25006) and ends
   with ROLLBACK. `<dir>` must be new or empty; it is created 0700 with 0600
   files: `report.md`, `report.json`, `table-counts.json` (the postflight
   baseline) and `affected/<id>.json` (every row 0004, 0006, 0011, 0030 and
   0033 will change or that makes them fail, with its current values; 0010 only
   when adopt would leave it pending). The exports hold personal data: keep the
   directory on restricted storage, share it only with the people who sign off,
   delete it once the cutover is accepted. The command exits 1 when `report.md`
   lists a blocker (the files are still written); review items need a decision.
   Run it at T-1 for the sign-offs, and again in the window after the drain
   (into a new directory) for the baseline. On CockroachDB also run, as the
   same user, `SHOW autocommit_before_ddl;` and
   `SHOW CLUSTER SETTING sql.defaults.autocommit_before_ddl.enabled;` (both on
   in 26.2.5), and check `SHOW CREATE TABLE abstract_book_jobs;` /
   `SHOW CREATE TABLE registrations;` for `schema_locked`: off plus not
   schema-locked is the mode where a failed index build comes back as XXA00
   after COMMIT (see the XXA00 paragraph above).
2. **Adopt, dry run.** `node packages/db/dist/migrator/cli.js adopt`. On a
   database shaped like main 0f86c91d the CockroachDB rehearsal printed (exit
   0):

   ```text
   Migration adoption (cockroach; dry run (no changes)):
     0000 baseline [shared] probes 649/649 (all); _prisma_migrations 31 finished (latest 20260814000000_add_committee_invite_tokens)
     0001 applied  [shared] probes 6/6 (all)
     0002 applied  [shared] probes 1/1 (all)
     0003 pending  [shared] probes 0/2 (none)
     0004 pending  [shared] probes 0/1 (none)
     0005 pending  [shared] probes 0/3 (none)
     0006 pending  [shared] probes 0/1 (none)
     0007 applied  [shared] probes 3/3 (all)
     0008 applied  [shared] probes 9/9 (all)
     0009 applied  [shared] probes 1/1 (all)
     0010 applied  [shared] probes 1/1 (all)
     0011 pending  [shared] probes 0/0 (unverifiable)
     0012 pending  [shared] probes 0/241 (none)
     ... 0013 to 0023 pending, none of their probes present (0018: 1/17) ...
     0024 pending  [shared] probes 4/5 (partial)
            missing: verify SELECT count(*) = 2 FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AN...
     ... 0025 to 0035 pending, none of their probes present (0031: 1/5) ...
   warning: 0011 has no catalog probes; apply will run it again (declared idempotent)
   warning: 0017 is deferrable; apply evaluates its defer-unless condition
   warning: 0030 is deferrable; apply evaluates its defer-unless condition
   warning: Pending 0003, 0004, 0005, 0006 precede migrations already present; apply will run them after those
   Dry run only; re-run with --apply to write these ledger rows.
   ```

   Why: main's 31 Prisma migrations created every object of 0000 (foreign keys
   under Prisma's `_fkey` names), the raw indexes of 0001, the drop of 0002 and
   the objects of 0007-0009; the check-in columns are TIMESTAMPTZ(6), which
   0010's `verify` accepts. Expected and harmless: `0018 1/17 (none)` and
   `0031 1/5 (none)` (an absence probe passing); `0024 4/5 (partial)` with its
   `missing:` line (pending on an idempotent file: `apply` rebuilds the two
   `email_logs` dedupe indexes, whose new predicates are a subset of the old
   ones, so no new violation is possible); `0011 0/0 (unverifiable)`; the
   out-of-order warning (`apply` runs 0003-0006 after the applied ones).
   Variants: 0001 partial or pending means a later `prisma db push` dropped the
   raw partial indexes, so check each partial unique predicate for duplicates
   before `apply` rebuilds them; a `networking_migrations` table (networking
   was never deployed) changes the 0012-0019 evidence; extra legacy objects
   such as `registrations.edit_token_expiry` are harmless.
   **Stop on any `ABORT` verdict or `error:` line.** `missing:` lines on an
   abort name what `prisma db push` never created on production. Add each with
   reviewed expand-only SQL taken from 0000's definitions, rehearse it on the
   restored copy, re-run the dry run, and run each `ALTER TYPE` alone, outside
   a transaction, for example
   `ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';` or
   `ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "banner_url" text;`. A
   `missing: constraint x (or y_fkey)` line means the key has neither the
   Drizzle nor the Prisma name: inspect it before renaming anything.
3. **Adopt.** `node packages/db/dist/migrator/cli.js adopt --apply`. It assesses
   again under the migration lease and writes the same verdicts, or aborts
   without writing a ledger row if the evidence changed (the empty ledger
   tables it created first stay; adopt, apply and the preflight read an empty
   ledger as no ledger, so run `adopt --apply` again once the cause is fixed). Expected: the same lines under
   `Migration adoption (cockroach; apply):`, ending
   `Wrote 7 migration record(s) and 0 step record(s).` It writes ledger rows
   only (0000 baseline; 0001, 0002 and 0007-0010 applied), creates exactly
   `schema_migrations`, `schema_migration_steps` and `schema_migration_lock`,
   and leaves `_prisma_migrations` (31 rows) untouched.
4. **0011 sign-off.** Adoption cannot prove 0011 (a guarded data repair of
   `registrations.total_amount` with no catalog objects), so `apply` runs it.
   Run its predicate read-only:

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
   would rewrite those live totals from net to gross (`total_amount` becomes
   the breakdown's `subtotal`), so get sign-off on that row list first, the same
   bar as a per-row money-repair manifest. The preflight's `affected/0011.json`
   holds the same rows with `total_amount`, `paid_amount`,
   `sponsorship_amount`, the breakdown's `subtotal` and `total`,
   `payment_status`, `new_total_amount` and the old `updated_at`. Legacy
   subtracted the sponsorship from a total that was already net, so these rows
   showed 0 due; after 0011 they owe the quoted net. Then run this read-only
   query:

   ```sql
   SELECT r.id, r.event_id, r.total_amount, r.sponsorship_amount, (r.price_breakdown->>'sponsorshipTotal')::integer AS quoted_sponsorship
   FROM registrations r
   JOIN events e ON e.id = r.event_id
   WHERE r.sponsorship_amount > 0
     AND e.status <> 'ARCHIVED'
     AND e.end_date >= now()
     AND jsonb_typeof(r.price_breakdown->'subtotal') = 'number'
     AND jsonb_typeof(r.price_breakdown->'total') = 'number'
     AND jsonb_typeof(r.price_breakdown->'sponsorshipTotal') = 'number'
     AND r.total_amount = (r.price_breakdown->>'total')::integer
     AND (r.price_breakdown->>'subtotal')::integer > r.total_amount
     AND r.sponsorship_amount < (r.price_breakdown->>'sponsorshipTotal')::integer;
   ```

   Each row it returns signed up with a sponsorship code that an admin linked
   afterwards; main capped the usage at the net total. After 0011 it owes
   `subtotal − sponsorship_amount`, more than it was quoted, and stays
   SPONSORED until a settlement write recomputes the usage against the gross
   total. No script repairs these rows. The query lists only live events (not
   archived, end date not passed): a row of a finished or archived event keeps
   0011's result as it is (decision of 2026-10-30), because nobody collects a
   balance there. Carry each listed row on the sign-off list, with a decision.
5. **Prechecks, then apply.** `apply --dry-run` evaluates only `defer-unless`
   conditions, so it lists 0004 as "would apply" even when 0004 will fail.
   - 0004 (required). Expect no rows:

     ```sql
     SELECT event_id, count(*) FROM abstract_book_jobs
     WHERE status IN ('PENDING', 'RUNNING') GROUP BY event_id HAVING count(*) > 1;
     ```

     A legacy RUNNING job whose lease expired counts. Settle the duplicate
     first (let the legacy worker finish before you stop it, or mark the extra
     job FAILED with sign-off); otherwise `apply` fails at 0004 with 23505 and
     records nothing, and resumes there once it is settled.
   - 0030 (its `defer-unless` condition). Rows mean `apply` records 0030 as
     deferred and every code stays exactly as typed until the sponsorship-code
     repair (root README, "Data repairs"):

     ```sql
     SELECT event_id, NULLIF(upper(trim(sponsorship_code)), '') AS code, count(*)
     FROM registrations WHERE NULLIF(upper(trim(sponsorship_code)), '') IS NOT NULL
     GROUP BY 1, 2 HAVING count(*) > 1;
     ```

     Optional: `SELECT id, event_id, sponsorship_code FROM registrations WHERE
     sponsorship_code ~ '[^A-Za-z0-9 -]';` should return nothing; 0030's SQL
     `trim()` strips spaces only, while Nest's `normalizeSponsorshipCode` also
     strips tabs and non-breaking spaces (`packages/shared/src/sponsorship-math.ts:89-92`).
   - `node packages/db/dist/migrator/cli.js apply --dry-run`. Expected:

     ```text
     Would apply on cockroach: 0003, 0004, 0005, 0006, 0011, 0012, 0013, 0014, 0015, 0016, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025, 0026, 0027, 0028, 0029, 0030, 0031, 0032, 0033, 0034, 0035
     Preconditions unknown until earlier migrations apply: 0017 (networking_embeddings will be created by pending 0013)
     Already applied: 0000, 0001, 0002, 0007, 0008, 0009, 0010
     ```

     With a duplicate code, 0030 is listed as deferred instead.
   - Off-peak, `node packages/db/dist/migrator/cli.js apply --yes`. Expected
     `Applied on cockroach:` with the same ids plus 0017, and the same
     `Already applied:` line. 0017 applies only when
     `feature.vector_index.enabled` is on (the preflight reports it; an
     unreadable setting stops `apply` at 0017 and is a preflight blocker);
     otherwise a `Deferred: 0017` line appears. `Deferred: 0030` appears when a
     code is stored twice.
   - An XXA00 failure (`Migration NNNN was not applied: CockroachDB committed
     its transaction but rolled back its schema change (...). Its ledger rows
     were removed ...`) exits 1: fix the data, then rerun the same command,
     with the same `--apply-deferred` flag if any. If the message says
     removing its ledger rows failed, or any `apply` ended with a dropped
     connection, run `verify --schema` before rerunning.
6. **Verify, then postflight.** `node packages/db/dist/migrator/cli.js verify
   --schema` must report no errors. Expected:

   ```text
   Migration verification (cockroach):
     warning: Migration 0011 has no catalog probes
     ledger and requested schema checks passed
   ```

   A deferred 0017 or 0030 adds a `Migration 0017 is deferred` (or 0030)
   warning. Then, before the Nest worker starts (its retention jobs delete old
   outbox rows):
   `node packages/db/dist/ops/cutover-preflight-cli.js postflight --baseline <dir>/table-counts.json --out <dir2>`.
   It recounts every table read-only and exits 1 when a table lost rows,
   vanished or could not be counted; the only accepted loss is
   `abstract_code_sequences` (0033, its rows are in `affected/0033.json`).
   Expected: `Postflight (cockroach database "<name>"): no table lost rows`,
   an `expected: abstract_code_sequences dropped ...` line and `new table: ...`
   lines.
7. **Boot check and Pre-Deploy Command.** `MIGRATIONS_CHECK=enforce` on both
   services before their first Nest boot (it can sit in the shared environment
   group from the start: the idle worker never runs the check). Add the Render
   Pre-Deploy Command to the worker and the API:
   `node packages/contracts/dist/cli/check-config.js && node packages/db/dist/migrator/cli.js apply --yes`
   (the lease serializes the two services). The API health check path is
   `/health/live`. Then unset `RUN_WORKERS` on the worker and deploy it, and
   deploy the API after it: the worker must know `networking.registration.sync`
   and `networking.event.sync` (0035) before the API enqueues them.
8. **After go-live.** Re-run the 0011 predicate of step 4. A row it returns now
   was written by the legacy API after `apply`, in the old net convention; 0011
   is recorded as applied and does not run again, so put the row on the same
   sign-off list and repair it by hand. Then retire the laptop migration flow
   (`load-env.fish`).

## Data safety per migration

What each migration does to the data production holds today. "On production"
is the adopt verdict of the rehearsal above: `baseline` and `applied`
migrations never run there. Every migration is also covered by
`packages/db/tests/migration/legacy-prisma-adopt.migration.test.ts` (adopt,
apply, `verify --schema` and boot on main's schema, both engines) and
`legacy-data-preservation.migration.test.ts` (main's rows in every legacy
table: no table, column or row lost and no value changed beyond the list
pinned in its `EXPECTED_CHANGES`, both engines). Test names below are files in
`packages/db/tests/migration/`. Classes: **none** (nothing runs or nothing
existing is touched), **expand-only** (new tables, nullable or defaulted
columns, indexes, enum values), **data-changing**, **destructive**.

| Migration | On production | Class and effect on existing data | Rows touched | Reversal, preflight export | Tests | CockroachDB |
|---|---|---|---|---|---|---|
| 0000 init | baseline | none: adopt records it | none | n/a | schema | per-file, 183 statements; with `autocommit_before_ddl` on not one transaction (fresh installs only) |
| 0001 raw indexes | applied | none (main created them) | none | n/a | schema | `USING GIN` is an inverted index |
| 0002 drop code-number index | applied | none (main dropped it) | none | n/a | schema | |
| 0003 email dedupe key | pending | expand-only: nullable `email_logs.dedupe_key` and a unique index over non-null keys | none (existing rows are NULL) | drop the column | email-dedupe | |
| 0004 one active book job | pending | expand-only unique index; **fails** while an event has two PENDING/RUNNING jobs (not deferrable) | none | `affected/0004.json` lists the conflicting jobs | schema-change-abort, cutover-preflight | XXA00 handled: a failed build is unrecorded |
| 0005 certificate scope | pending | expand-only: `scope` NOT NULL DEFAULT 'BOTH' with a CHECK, nullable `allowed_abstract_final_types`; existing templates behave as before | none | drop the columns | certificate-scope | |
| 0006 theme slots | pending | **data-changing**: active themes sharing a `sort_order` in one config; the one with most issued codes keeps it, the others move above the config's largest slot | `abstract_themes.sort_order` and `updated_at` of the moved themes | by hand from `affected/0006.json` (`sort_order`, `new_sort_order`, `issued_codes`, `slot_kept_by`, old `updated_at`); a restored duplicate needs the index dropped | theme-sort-order, cutover-preflight | per-statement: UPDATE, then the index |
| 0007 multilanguage forms | applied | none | none | n/a | schema | |
| 0008 invite tokens | applied | none | none | n/a | schema | inline REFERENCES keys have no probe |
| 0009 invite lookup index | applied | none | none | n/a | schema | |
| 0010 check-in timestamptz | applied | none: its `verify` accepts the TIMESTAMPTZ(6) columns, so microseconds stay | none | n/a (where it runs, `affected/0010.json` holds old and rounded values) | legacy-data-preservation, cutover-preflight | a rewrite of a populated (6) column succeeded on 26.2.5 locally; never runs on production |
| 0011 gross total | pending | **data-changing**: net to gross for rows its predicate proves | `registrations.total_amount` (becomes the breakdown `subtotal`) and `updated_at`; exactly the step 4 rows | by hand from `affected/0011.json` (`total_amount`, `new_total_amount`, old `updated_at`); sign-off first | apply-lease-race, cutover-preflight | |
| 0012 networking | pending | expand-only: 17 new tables | none | n/a | schema, adopt | per-file, 79 statements: with `autocommit_before_ddl` on, a failure partway leaves earlier objects and the rerun refuses (`uses per-file transactions but has incomplete step history`, `runner.ts:211`); rehearse |
| 0013 embeddings | pending | expand-only: 2 tables | none | n/a | schema | native VECTOR; PostgreSQL needs the `vector` extension installed first |
| 0014 networking opt-in | pending | expand-only: nullable `registrations.networking_opt_in` (NULL keeps the old policy) | none | drop the column | schema | |
| 0015 networking MFA | pending | expand-only | none | n/a | schema | |
| 0016 networking read indexes | pending | expand-only (indexes on empty tables) | none | n/a | schema | |
| 0017 vector index (CockroachDB only) | pending | expand-only | none | n/a | adopt | deferred while `networking_embeddings` has rows (empty here: 0013 creates it in the same `apply`) or `feature.vector_index.enabled` is off; an unreadable setting stops `apply` |
| 0018 networking spaces | pending | data-changing SQL on `networking_tables`, `networking_profiles`, `networking_reservations`; empty on production (0012 creates them in the same `apply`) | none on production | no dedicated export; the preflight lists the tables' row counts and flags rows | networking-spaces | per-statement override, fixed crosswalk in `legacy-networking.ts` |
| 0019 networking alignment | pending | expand-only | none | n/a | schema | |
| 0020 challenge verified_at | pending | expand-only | none | n/a | schema | |
| 0021 reference counters | pending | expand-only: new table, each prefix seeded from the largest stored suffix on first use | none | n/a | legacy-data-preservation (numbers continue after legacy ones) | |
| 0022 allocation locks | pending | expand-only | none | n/a | schema | |
| 0023 worker heartbeats | pending | expand-only; must exist before Nest boots (`/health/worker` 500, `/health/ready` 503 without it) | none | n/a | schema | |
| 0024 certificate email indexes | pending (4/5) | none: rebuilds the two `email_logs` dedupe indexes without `CERTIFICATE_SENT` (temporary name, drop, rename); new predicates are a subset | none | n/a | certificate-email-indexes | per-statement |
| 0025 networking retention | pending | expand-only | none | n/a | networking-delivery-lanes | per-statement |
| 0026 networking email index | pending | expand-only expression index on `email_logs` | none | n/a | schema | |
| 0027 outbox retention index | pending | expand-only index on `outbox_events` | none | n/a | schema | |
| 0028 UNCERTAIN | pending | expand-only enum value | none | cannot be removed; legacy Prisma throws reading an UNCERTAIN row (rollback) | email-provider-attempt | `transaction none`: its own schema change |
| 0029 provider attempt | pending | expand-only: nullable `provider_attempted_at`, `provider`, an index | none | drop the columns | email-provider-attempt | per-statement |
| 0030 sponsorship code | pending, or deferred | **data-changing**: codes trimmed, upper-cased, blank to NULL; then one registration per (event, code); deferred, changing nothing, while a normalized code is stored twice | `registrations.sponsorship_code` of codes not yet normalized (`updated_at` unchanged) | by hand from `affected/0030.json` (`sponsorship_code`, `new_sponsorship_code`, duplicates under `related.duplicates`) | sponsorship-code-unique, cutover-preflight | per-statement; `--apply-deferred` skips the `defer-unless` check (`runner.ts:357`), so run it by hand first |
| 0031 delivery lanes | pending | expand-only indexes; drops 0025's index | none | n/a | networking-delivery-lanes | per-statement |
| 0032 certificate render image | pending | expand-only: three nullable columns, filled later by `backfill-certificate-renders` | none | drop the columns | certificate-render-image | per-statement |
| 0033 drop code sequences | pending | **destructive**: drops `abstract_code_sequences` with its rows | every row of that table | only from `affected/0033.json`, the one copy left | abstract-code-sequences-drop, cutover-preflight (postflight exception) | per-statement |
| 0034 incoming interests index | pending | expand-only | none | n/a | networking-incoming-index | per-statement |
| 0035 networking sync state | pending | expand-only: columns on `networking_configs`, defaults 0 or NULL | none | n/a | networking-sync-state | per-statement |

`abstract_code_sequences` (0033): its values cannot be rebuilt from other data,
and no code reads them. Only the global allocator of 9aca6727 used the table,
for a few hours on 2026-05-24, until a4545064; later per-theme allocations move
the counters past it and a reopen clears a stored code, so a sequence value can
be in no counter and no stored code. Nest's `allocateAbstractCode`
(`packages/db/src/queries/abstracts/decisions.ts:56`) and main's both take the
larger of the theme's largest stored `code_number` and the (event, theme, final
type) counter, and `legacy-data-preservation` asserts that new codes reuse no
issued code, including codes a reopen took back. Main declares the table only
as a Prisma model (`prisma/schema.prisma:914-921` at `legacy-final`); its only
source reference is a test asserting it is never called, so the drop does not
block a rollback. Keep the preflight export: after 0033 it is the only copy.

Two themes that already shared a slot on main can still collide: 0006 moves
one, but its printed codes keep the old slot number, so the other theme's next
code can repeat one of them. The unique (event, code) refuses it and Nest
answers `code_conflict` with nothing written, as main did. This predates the
cutover and is rare.

## Writing a migration

Rules for new SQL under `packages/db/migrations/`. Every migration runs through
this runner on PostgreSQL and on CockroachDB (production).

### Numbering

- A file is `NNNN_name.sql`; `NNNN` is its ledger id and migrations run in
  numeric order. Take the next free number when the PR merges; while several
  branches add migrations the coordinator assigns the numbers, and two files
  with one number fail the lint (`plan`, `apply`, CI).
- `node packages/db/dist/migrator/cli.js new <name>` (after
  `pnpm --filter @app/db build`) creates the next number with a
  `transaction per-file` header.
- Never number a new file below a migration already on `develop`: `apply` would
  still run it, but after later migrations other databases ran before it.
- Never edit, rename, renumber or delete a merged migration. The ledger stores
  each file's checksum; a changed body fails `verify` and the boot check (the
  `-- migrate:` header lines are left out of the checksum). Fix mistakes with a
  new migration. The one exception is a `-- migrate:` line that changes only how
  `adopt` and `verify --schema` recognize the migration, never what it runs:
  0010's `verify` accepts precision 6 so the legacy production check-in columns
  are adopted as applied instead of rewritten. Give the reason in a `/* */`
  comment inside the directive's SQL; an ordinary comment line is part of the
  checksum.
- `migrations/cockroach/NNNN_name.sql` replaces the shared file with the same
  number on CockroachDB, or adds a CockroachDB-only migration (0017, the vector
  index). Prefer SQL both engines accept; 0017 and 0018 are the only overrides.

### Header directives

Every file declares its `-- migrate:` lines before its first SQL statement. The
runner refuses unknown or duplicated directives and requires a `transaction`
one.

| Directive | Meaning | Use it for |
|---|---|---|
| `transaction per-file` | The whole file in one transaction. | One schema change, or a new table (0022) with its indexes (0023). |
| `transaction per-statement` | Each chunk between `--> statement-breakpoint` markers in its own transaction; one SQL statement per chunk (lint). | Several schema changes, or a data change plus a schema change (0024, 0029, 0030, 0031, 0032). |
| `transaction none` | No transaction. | Statements whose result cannot be used in the transaction that makes it, such as `ALTER TYPE … ADD VALUE` (0028). |
| `idempotent` | Safe to replay after a partial run. Required for `per-statement` and `none`. | `IF NOT EXISTS` / `IF EXISTS` forms and guarded updates (`WHERE … IS DISTINCT FROM …`). |
| `verify <sql>` | A query returning one boolean; `verify --schema` and `adopt` run it. | Changes the catalog probes cannot see: enum values (0028), a rebuilt index predicate (0024), an index whose presence matters (0030). |
| `deferrable` + `defer-unless "<sql>"` | The quoted query (JSON string) returns one boolean; false records the migration as `deferred` and later migrations still run. `apply --apply-deferred=NNNN --yes` retries it. | A migration that cannot succeed until data is fixed: 0030 waits until no event stores a sponsorship code twice. |
| `requires-extension <name>` | Checks that a PostgreSQL extension is installed; never installs it. | `vector` (0013). `CREATE EXTENSION` in a file fails the lint. |

A file may not contain `BEGIN`: the runner owns the transactions. The catalog
probes (`verify --schema`, `adopt`) are derived from `CREATE TABLE` (the table
and each column), `CREATE TYPE … AS ENUM` (the type and each label),
`CREATE [UNIQUE|VECTOR] INDEX`, `DROP INDEX`, `DROP TABLE`,
`ALTER INDEX … RENAME TO`, `ALTER TABLE … ADD COLUMN` and
`ALTER TABLE … ADD CONSTRAINT`, and check existence, not types. Anything else
(`DROP COLUMN`, `DROP CONSTRAINT`, `ALTER TYPE … ADD VALUE`, data changes)
needs a `verify` directive, or a `catalog.ts` change as 0033 made for
`DROP TABLE`. A foreign key added with `ADD CONSTRAINT` also matches under
Prisma's default name; inline `REFERENCES` keys (0008) get no probe.

### Expand and contract

The Pre-Deploy Command applies migrations while the previous release still
serves, and a rollback runs the previous code on the new schema. There are no
down migrations, so each migration works with the code before it and the code
after it:

1. **Expand**, before or with the code that uses it: new tables, nullable or
   defaulted columns, indexes, enum values. The code accepts rows written
   before the change (0029's nullable marker columns; 0032's render-image
   columns, with the renderer falling back to the original image).
2. **Migrate data** with a guarded, idempotent statement, or with a script for
   large or reviewed changes (`backfill-certificate-renders` fills 0032's
   columns; the repair scripts in `apps/worker/src/scripts/` run as a dry run,
   then `--apply`).
3. **Contract** in a later release, once no running code reads the old shape:
   drop the column, table or index (0033).

To replace an index without a window where neither exists, create the new one
and then drop the old one (0031), or build it under a temporary name, drop the
old one and `ALTER INDEX … RENAME TO` the old name (0024). Never in one step:
renaming a column or table the running code uses, adding `NOT NULL` without a
default to a table with rows, or changing a column's type in place; split them
into expand, backfill, code switch, contract. A migration that must be applied
before the code that needs it says so in its PR; the Pre-Deploy Command
guarantees that order on Render.

### CockroachDB rules

- **Never reference a column in the same file that adds it.** A schema change
  is usable only after its transaction commits, so an `UPDATE`, index or
  constraint on a column added earlier in the same transaction fails. Add the
  column in one migration and use it from the next (0025 adds
  `networking_profiles.erased_at`, 0031 indexes it). A table created in the file
  can be indexed in the same file (0023).
- **One schema change per transaction** when a file has several: use
  `per-statement` with a breakpoint between them, and keep data changes and
  schema changes in separate chunks (0030).
- **No `DO` blocks**: CockroachDB does not run `ALTER TABLE` inside PL/pgSQL.
  Use `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` and
  `DROP … IF EXISTS`. PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`: write
  `DROP CONSTRAINT IF EXISTS`, then `ADD CONSTRAINT` (0005).
- **Keep transactional units short.** A transaction open across the 30 s lease
  renewal can fail with 40001 on every retry; it rolls back safely, but never
  finishes. Split long work into `per-statement` chunks.
- A unique index that meets duplicates fails at its statement (default
  session), or at COMMIT with XXA00 (`autocommit_before_ddl` off on a table
  that is not schema-locked); either way nothing is recorded. Give such an index
  a preflight check or a `defer-unless`.
- `CREATE INDEX … USING GIN` works on both engines (0001). Vector indexes
  differ per engine, hence the CockroachDB-only 0017.
- In queries, CockroachDB reads a leading zero as octal when casting a string
  to `INT` (`'008'` fails): cast digit strings through `DECIMAL`
  (`packages/db/src/queries/registrations.ts`).

### Partial unique indexes and `ON CONFLICT`

- An `ON CONFLICT (cols)` that targets a **partial** unique index repeats the
  index predicate, otherwise PostgreSQL cannot infer the index (42P10):
  `ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`; in
  Drizzle `onConflictDoNothing({ target: outboxEvents.dedupeKey, where: sql.raw('"dedupe_key" IS NOT NULL') })`
  (`enqueueOutboxEvent`, `packages/db/src/outbox/outbox.ts`).
- Target-less `ON CONFLICT DO NOTHING` only where any unique violation means
  "skip this row" (`insertEmailLogsSkippingConflicts`,
  `packages/db/src/queries/email.ts`).
- A query meant to use a partial index repeats its predicate (the networking
  delivery claims repeat 0031's).
- Test every `ON CONFLICT` against a migrated database on both engines. When
  nothing uses `ON CONFLICT` against a new unique index, say so in the
  migration's comment (0030).
- List every partial or engine-specific index in
  [the schema README](../schema/README.md#indexes-and-constraints-from-raw-migrations).

A new timestamp column is `TIMESTAMPTZ(3)` in SQL and
`timestamp({ precision: 3, withTimezone: true })` in Drizzle; calendar logic
reads UTC ([conventions](../schema/README.md#conventions)).

### PR checklist

1. The assigned (or next free) number; header directives; a comment saying why
   the migration exists, which plan item it serves, and any operational effect
   (a plain `CREATE INDEX` briefly blocks writes to the table on PostgreSQL).
2. The Drizzle schema in `packages/db/src/schema/` declares the same final
   columns, indexes and constraints (`tests/migration/schema.migration.test.ts`
   compares them).
3. A migration test in `packages/db/tests/migration/`: fresh apply, a rerun for
   idempotent files, the deferral for deferrable ones. `pnpm test:migration`
   runs on both engines in CI.
4. If a later file supersedes an object an earlier one created, update the
   superseded list in `packages/db/src/migrator/adopt.test.ts` (0031 and 0033
   did). Add the migration's verdict on the legacy production schema to
   `LEGACY_VERDICTS` in `legacy-prisma-adopt.migration.test.ts` (`pending`,
   unless that schema already has its objects); the test fails without it.
5. If it changes existing rows: a data check in `DATA_CHECKS`
   (`packages/db/src/ops/cutover-preflight-checks.ts`; its unit test fails for a
   row-changing migration without one), its rows in `EXPECTED_CHANGES` (and
   `MONEY` for registration money) of `legacy-data-preservation.migration.test.ts`,
   and, if it has no catalog probe, a line in that test's pinned `verify`
   warnings.
6. A row in [Data safety per migration](#data-safety-per-migration).
7. `node packages/db/dist/migrator/cli.js plan` passes (CI runs it in the image).
8. The PR body says whether the migration must be applied before the code, and
   anything an operator must do (also in the root README, "Production cutover",
   when it needs a step beyond `apply`).
