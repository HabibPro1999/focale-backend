import type { Client } from "pg";
import { tableExists } from "../migrator/catalog-read";
import type { MigrationDefinition } from "../migrator/migration";
import { evaluateSafeCondition } from "../migrator/preconditions";

/*
 * Data-impact checks of the cutover preflight: for each migration that changes
 * or can refuse existing rows, the rows it will touch, selected with the
 * migration's own predicate. Every predicate cites the migration file and line
 * it mirrors (`citations`, verified by cutover-preflight-checks.test.ts).
 * Migration SQL bodies are checksummed and never edited, so these copies
 * cannot drift silently. All queries are SELECTs; the caller runs them inside
 * the preflight's read-only transaction, each check under its own savepoint.
 */

export type PreflightRow = Record<string, unknown>;

export type DataCheckStatus =
  /** The ledger records the migration as applied: apply will not run it. */
  | "skipped"
  /** The table it reads does not exist, so there is nothing to change. */
  | "not-applicable"
  | "no-change"
  | "changes-rows"
  /** apply stops at this migration until the exported rows are fixed. */
  | "fails"
  /** apply records it as deferred and changes nothing until --apply-deferred. */
  | "deferred"
  /** The check itself could not run; see `error`. */
  | "error";

export interface DataCheckResult {
  status: Exclude<DataCheckStatus, "skipped" | "error">;
  /** One sentence for report.md. */
  summary: string;
  /** Rows the migration modifies (or, for a failing one, the rows that make it fail). */
  rows: PreflightRow[];
  /** Further row sets exported beside `rows`, e.g. the duplicates that defer 0030. */
  related?: Record<string, PreflightRow[]>;
  details?: Record<string, unknown>;
  /** Needs a person's decision or sign-off before apply. */
  review?: boolean;
}

export interface DataCheckContext {
  client: Client;
  migration: MigrationDefinition;
  /** Runs `run` under a savepoint, rolled back (and rethrown) on error. */
  isolated<T>(run: () => Promise<T>): Promise<T>;
}

export interface DataCheckDefinition {
  migrationId: string;
  file: string;
  /** What the migration does to existing rows. */
  effect: string;
  /** File lines whose text this check mirrors; a unit test asserts each fragment is there. */
  citations: Array<{ line: number; fragment: string }>;
  run(context: DataCheckContext): Promise<DataCheckResult>;
}

async function rows(client: Client, sql: string): Promise<PreflightRow[]> {
  return (await client.query<PreflightRow>(sql)).rows;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The verb form agreeing with `count`: verb(1, "moves", "move") is "moves". */
function verb(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

/** information_schema data_type in the short form migrations use. */
function shortType(dataType: unknown, precision: unknown): string {
  const name = String(dataType).toLowerCase()
    .replace("timestamp with time zone", "timestamptz")
    .replace("timestamp without time zone", "timestamp");
  return `${name}(${precision ?? "?"})`;
}

const notApplicable = (table: string): DataCheckResult => ({
  status: "not-applicable",
  summary: `${table} does not exist; nothing to change`,
  rows: [],
});

// 0004_abstract_book_jobs_active_unique.sql:13-15
const ABSTRACT_BOOK_JOB_DUPLICATES = `
SELECT j.id, j.event_id, j.status::text AS status, j.requested_by, j.attempt_count,
       j.created_at, j.started_at, j.locked_by, j.locked_until
FROM abstract_book_jobs j
WHERE j.status IN ('PENDING', 'RUNNING')
  AND j.event_id IN (
    SELECT event_id FROM abstract_book_jobs
    WHERE status IN ('PENDING', 'RUNNING')
    GROUP BY event_id HAVING count(*) > 1)
ORDER BY j.event_id, j.created_at, j.id`;

// 0006_abstract_themes_sort_order_active_unique.sql:20-46, verbatim; only the
// final UPDATE (:47-51) is replaced by a SELECT of the same to_bump rows with
// the value it would write (max_so + k), plus the theme that keeps the slot.
const ABSTRACT_THEME_BUMPS = `
WITH issued AS (
  SELECT t."id", COALESCE(SUM(acc."last_value"), 0) AS n
  FROM "abstract_themes" t
  LEFT JOIN "abstract_code_counters" acc ON acc."theme_id" = t."id"
  GROUP BY t."id"
),
ranked AS (
  SELECT t."id", t."config_id", t."sort_order",
         ROW_NUMBER() OVER (
           PARTITION BY t."config_id", t."sort_order"
           ORDER BY i.n DESC, t."created_at", t."id"
         ) AS rn
  FROM "abstract_themes" t
  JOIN issued i ON i."id" = t."id"
  WHERE t."active"
),
to_bump AS (
  SELECT "id", "config_id",
         ROW_NUMBER() OVER (PARTITION BY "config_id" ORDER BY "sort_order", "id") AS k
  FROM ranked
  WHERE rn > 1
),
maxes AS (
  SELECT "config_id", MAX("sort_order") AS max_so
  FROM "abstract_themes"
  GROUP BY "config_id"
)
SELECT t."id", t."config_id", t."label", t."sort_order",
       (m.max_so + b.k)::int8 AS new_sort_order,
       i.n::int8 AS issued_codes,
       keeper."id" AS slot_kept_by,
       t."created_at", t."updated_at"
FROM to_bump b
JOIN maxes m ON m."config_id" = b."config_id"
JOIN "abstract_themes" t ON t."id" = b."id"
JOIN issued i ON i."id" = t."id"
LEFT JOIN ranked keeper
  ON keeper."config_id" = t."config_id" AND keeper."sort_order" = t."sort_order" AND keeper.rn = 1
ORDER BY t."config_id", new_sort_order`;

const CHECK_IN_COLUMNS = `
SELECT table_name, data_type, datetime_precision
FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'checked_in_at'
  AND table_name IN ('registrations', 'access_check_ins')
ORDER BY table_name`;

// 0010_checkin_timestamptz.sql:8 and :10 rewrite each value with
// "checked_in_at"::timestamptz(3) under SET TIME ZONE 'UTC' (:6); the caller
// pins the session to UTC too. A value changes when that cast rounds it.
const CHECK_IN_ROUNDED = (table: "registrations" | "access_check_ins") => `
SELECT '${table}' AS table_name, id, checked_in_at,
       "checked_in_at"::timestamptz(3) AS new_checked_in_at
FROM ${table}
WHERE checked_in_at IS NOT NULL
  AND "checked_in_at"::timestamptz(3) <> checked_in_at
ORDER BY id`;

// 0011_registration_gross_total.sql:10-14, the WHERE clause verbatim (also
// packages/db/src/migrator/README.md, rollout step 4). The UPDATE (:7-9) sets
// total_amount to the subtotal and updated_at to the current time.
const GROSS_TOTAL_REPAIRS = `
SELECT id, event_id, reference_number, payment_status::text AS payment_status,
       total_amount, paid_amount, sponsorship_amount,
       price_breakdown->'subtotal' AS price_breakdown_subtotal,
       price_breakdown->'total' AS price_breakdown_total,
       (price_breakdown->>'subtotal')::integer AS new_total_amount,
       updated_at
FROM registrations
WHERE sponsorship_amount > 0
  AND jsonb_typeof(price_breakdown->'subtotal') = 'number'
  AND jsonb_typeof(price_breakdown->'total') = 'number'
  AND total_amount = (price_breakdown->>'total')::integer
  AND (price_breakdown->>'subtotal')::integer > total_amount
ORDER BY event_id, id`;

// Rows the 0011 casts (:13-14) cannot read as an integer: a JSON number such
// as 10.5 passes jsonb_typeof (:11-12) and then fails ::integer, which fails
// the whole UPDATE. Diagnostic only; nine digits keeps the value in int4 range.
const GROSS_TOTAL_UNPARSEABLE = `
SELECT id, event_id, price_breakdown->'subtotal' AS price_breakdown_subtotal,
       price_breakdown->'total' AS price_breakdown_total
FROM registrations
WHERE sponsorship_amount > 0
  AND jsonb_typeof(price_breakdown->'subtotal') = 'number'
  AND jsonb_typeof(price_breakdown->'total') = 'number'
  AND NOT ((price_breakdown->>'subtotal') ~ '^-?[0-9]{1,9}$' AND (price_breakdown->>'total') ~ '^-?[0-9]{1,9}$')
ORDER BY event_id, id`;

// 0030_registration_sponsorship_code_unique.sql:26-29: the normalizing UPDATE.
const SPONSORSHIP_CODE_NORMALIZATIONS = `
SELECT id, event_id, payment_status::text AS payment_status, sponsorship_code,
       NULLIF(upper(trim(sponsorship_code)), '') AS new_sponsorship_code
FROM registrations
WHERE sponsorship_code IS NOT NULL
  AND sponsorship_code IS DISTINCT FROM NULLIF(upper(trim(sponsorship_code)), '')
ORDER BY event_id, id`;

// 0030_registration_sponsorship_code_unique.sql:4 (defer-unless): the
// (event, normalized code) pairs stored more than once, with their rows.
const SPONSORSHIP_CODE_DUPLICATES = `
SELECT r.event_id, d.code AS normalized_code, r.id, r.sponsorship_code,
       r.payment_status::text AS payment_status, r.created_at
FROM registrations r
JOIN (
  SELECT event_id, NULLIF(upper(trim(sponsorship_code)), '') AS code
  FROM registrations
  WHERE NULLIF(upper(trim(sponsorship_code)), '') IS NOT NULL
  GROUP BY event_id, NULLIF(upper(trim(sponsorship_code)), '')
  HAVING count(*) > 1
) d ON d.event_id = r.event_id AND d.code = NULLIF(upper(trim(r.sponsorship_code)), '')
ORDER BY r.event_id, d.code, r.created_at, r.id`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const DATA_CHECKS: DataCheckDefinition[] = [
  {
    migrationId: "0004",
    file: "0004_abstract_book_jobs_active_unique.sql",
    effect: "adds a unique index on abstract_book_jobs(event_id) for PENDING/RUNNING jobs; changes no row",
    citations: [
      { line: 13, fragment: 'CREATE UNIQUE INDEX IF NOT EXISTS "abstract_book_jobs_event_id_active_key"' },
      { line: 14, fragment: 'ON "abstract_book_jobs" ("event_id")' },
      { line: 15, fragment: `WHERE "status" IN ('PENDING', 'RUNNING');` },
    ],
    async run({ client }) {
      if (!(await tableExists(client, "abstract_book_jobs"))) return notApplicable("abstract_book_jobs");
      const duplicates = await rows(client, ABSTRACT_BOOK_JOB_DUPLICATES);
      if (!duplicates.length) {
        return { status: "no-change", summary: "no event has more than one PENDING/RUNNING job; the index builds", rows: [] };
      }
      const events = new Set(duplicates.map((row) => row.event_id)).size;
      return {
        status: "fails",
        summary: `${plural(events, "event")} with more than one PENDING/RUNNING job: the unique index cannot be built and apply stops at 0004 (not deferrable); settle the stale jobs with sign-off first`,
        rows: duplicates,
        details: { events },
      };
    },
  },
  {
    migrationId: "0006",
    file: "0006_abstract_themes_sort_order_active_unique.sql",
    effect: "moves duplicate active abstract themes to new sort_order slots (and sets their updated_at), then adds a unique index",
    citations: [
      { line: 20, fragment: "WITH issued AS (" },
      { line: 30, fragment: 'ORDER BY i.n DESC, t."created_at", t."id"' },
      { line: 34, fragment: 'WHERE t."active"' },
      { line: 38, fragment: 'ROW_NUMBER() OVER (PARTITION BY "config_id" ORDER BY "sort_order", "id") AS k' },
      { line: 40, fragment: "WHERE rn > 1" },
      { line: 48, fragment: 'SET "sort_order" = m.max_so + b.k, "updated_at" = now()' },
    ],
    async run({ client }) {
      if (!(await tableExists(client, "abstract_themes"))) return notApplicable("abstract_themes");
      const bumps = await rows(client, ABSTRACT_THEME_BUMPS);
      if (!bumps.length) return { status: "no-change", summary: "no two active themes of a config share a sort_order", rows: [] };
      const coded = bumps.filter((row) => Number(row.issued_codes) > 0).length;
      return {
        status: "changes-rows",
        summary: `${plural(bumps.length, "active theme")} ${verb(bumps.length, "moves", "move")} to a new sort_order slot${coded ? `; ${coded} of them already issued codes that embed the old slot` : ""}`,
        rows: bumps,
        review: true,
        details: { themesWithIssuedCodes: coded },
      };
    },
  },
  {
    migrationId: "0010",
    file: "0010_checkin_timestamptz.sql",
    effect: "rewrites registrations.checked_in_at and access_check_ins.checked_in_at as timestamptz(3), rounding sub-millisecond values",
    citations: [
      { line: 3, fragment: "datetime_precision = 3" },
      { line: 6, fragment: "SET TIME ZONE 'UTC';" },
      { line: 8, fragment: 'ALTER TABLE "registrations" ALTER COLUMN "checked_in_at" TYPE timestamptz(3) USING "checked_in_at"::timestamptz(3);' },
      { line: 10, fragment: 'ALTER TABLE "access_check_ins" ALTER COLUMN "checked_in_at" TYPE timestamptz(3) USING "checked_in_at"::timestamptz(3);' },
    ],
    async run({ client }) {
      const columns = await rows(client, CHECK_IN_COLUMNS);
      if (!columns.length) return notApplicable("registrations.checked_in_at / access_check_ins.checked_in_at");
      const changed: PreflightRow[] = [];
      const described: PreflightRow[] = [];
      for (const column of columns) {
        const table = column.table_name === "registrations" ? "registrations" : "access_check_ins";
        const values = await client.query<{ n: number }>(`SELECT count(checked_in_at) AS n FROM ${table}`);
        changed.push(...(await rows(client, CHECK_IN_ROUNDED(table))));
        described.push({
          table,
          dataType: column.data_type,
          precision: column.datetime_precision === null ? null : Number(column.datetime_precision),
          nonNullValues: Number(values.rows[0]?.n ?? 0),
        });
      }
      const target = described.every(
        (column) => String(column.dataType).toLowerCase() === "timestamp with time zone" && column.precision === 3,
      );
      const types = described.map((column) => `${column.table} ${shortType(column.dataType, column.precision)}`).join(", ");
      if (target) {
        return { status: "no-change", summary: `already timestamptz(3) (${types}); nothing to rewrite`, rows: [], details: { columns: described } };
      }
      return {
        status: changed.length ? "changes-rows" : "no-change",
        summary: `rewrites ${types} as timestamptz(3); ${changed.length ? `${plural(changed.length, "value")} ${verb(changed.length, "loses", "lose")} sub-millisecond digits` : "no stored value changes"}`,
        rows: changed,
        review: changed.length > 0,
        details: { columns: described },
      };
    },
  },
  {
    migrationId: "0011",
    file: "0011_registration_gross_total.sql",
    effect: "sets registrations.total_amount from the net total to the gross subtotal for legacy sponsored rows (and updated_at)",
    citations: [
      { line: 8, fragment: "SET total_amount = (price_breakdown->>'subtotal')::integer," },
      { line: 9, fragment: "updated_at = CURRENT_TIMESTAMP" },
      { line: 10, fragment: "WHERE sponsorship_amount > 0" },
      { line: 11, fragment: "AND jsonb_typeof(price_breakdown->'subtotal') = 'number'" },
      { line: 12, fragment: "AND jsonb_typeof(price_breakdown->'total') = 'number'" },
      { line: 13, fragment: "AND total_amount = (price_breakdown->>'total')::integer" },
      { line: 14, fragment: "AND (price_breakdown->>'subtotal')::integer > total_amount;" },
    ],
    async run({ client, isolated }) {
      if (!(await tableExists(client, "registrations"))) return notApplicable("registrations");
      const unparseable = await rows(client, GROSS_TOTAL_UNPARSEABLE);
      const related = unparseable.length ? { unparseable } : undefined;
      let repairs: PreflightRow[];
      try {
        repairs = await isolated(() => rows(client, GROSS_TOTAL_REPAIRS));
      } catch (error) {
        return {
          status: "fails",
          summary: `its predicate fails on this data (${errorMessage(error)}); apply stops at 0011. ${plural(unparseable.length, "sponsored row")} carry a non-integer subtotal/total`,
          rows: unparseable,
          related,
          details: { predicateError: errorMessage(error) },
        };
      }
      const base = { related, details: { unparseable: unparseable.length } };
      if (!repairs.length) {
        return { status: "no-change", summary: "no legacy sponsored row stores the net total; re-running 0011 changes nothing", rows: [], review: unparseable.length > 0, ...base };
      }
      return {
        status: "changes-rows",
        summary: `${plural(repairs.length, "registration")} ${verb(repairs.length, "changes", "change")} total_amount from net to gross (sign-off required, migrator README rollout step 4)`,
        rows: repairs,
        review: true,
        ...base,
      };
    },
  },
  {
    migrationId: "0030",
    file: "0030_registration_sponsorship_code_unique.sql",
    effect: "normalizes registrations.sponsorship_code (trim, upper-case, blank to NULL), then adds a unique index per (event, code); deferred while normalized duplicates exist",
    citations: [
      { line: 4, fragment: `defer-unless "SELECT NOT EXISTS (SELECT 1 FROM registrations WHERE NULLIF(upper(trim(sponsorship_code)), '') IS NOT NULL GROUP BY event_id, NULLIF(upper(trim(sponsorship_code)), '') HAVING count(*) > 1)"` },
      { line: 27, fragment: "SET sponsorship_code = NULLIF(upper(trim(sponsorship_code)), '')" },
      { line: 28, fragment: "WHERE sponsorship_code IS NOT NULL" },
      { line: 29, fragment: "AND sponsorship_code IS DISTINCT FROM NULLIF(upper(trim(sponsorship_code)), '');" },
    ],
    async run({ client, migration }) {
      if (!(await tableExists(client, "registrations"))) return notApplicable("registrations");
      const normalizations = await rows(client, SPONSORSHIP_CODE_NORMALIZATIONS);
      const duplicates = await rows(client, SPONSORSHIP_CODE_DUPLICATES);
      // The runner evaluates this exact header query before any statement
      // (runner.ts, defer-unless), so a deferred 0030 normalizes nothing yet.
      const safe = migration.directives.deferUnless
        ? await evaluateSafeCondition(client, migration.directives.deferUnless)
        : true;
      const pairs = new Set(duplicates.map((row) => `${String(row.event_id)}\u0000${String(row.normalized_code)}`)).size;
      const related = duplicates.length ? { duplicates } : undefined;
      const details = { duplicatePairs: pairs, deferUnless: safe };
      if (!safe) {
        return {
          status: "deferred",
          summary: `${plural(pairs, "(event, code) pair")} ${verb(pairs, "is", "are")} stored more than once: apply records 0030 as deferred and changes nothing; ${plural(normalizations.length, "normalization")} ${verb(normalizations.length, "runs", "run")} with --apply-deferred=0030 once the duplicates are resolved`,
          rows: normalizations,
          related,
          review: true,
          details,
        };
      }
      if (!normalizations.length) return { status: "no-change", summary: "every stored code is already normalized; the index builds", rows: [], details };
      return {
        status: "changes-rows",
        summary: `${plural(normalizations.length, "registration")} ${verb(normalizations.length, "gets", "get")} a normalized sponsorship_code`,
        rows: normalizations,
        review: true,
        details,
      };
    },
  },
  {
    migrationId: "0033",
    file: "0033_drop_abstract_code_sequences.sql",
    effect: "drops the legacy abstract_code_sequences table with every row it holds",
    citations: [
      { line: 12, fragment: "DROP INDEX IF EXISTS abstract_code_sequences_final_type_key;" },
      { line: 14, fragment: "DROP TABLE IF EXISTS abstract_code_sequences;" },
    ],
    async run({ client }) {
      if (!(await tableExists(client, "abstract_code_sequences"))) return notApplicable("abstract_code_sequences");
      const all = await rows(client, "SELECT * FROM abstract_code_sequences ORDER BY id");
      return {
        status: all.length ? "changes-rows" : "no-change",
        summary: all.length ? `drops the table and its ${plural(all.length, "row")} (exported in full)` : "drops the empty table",
        rows: all,
      };
    },
  },
];
