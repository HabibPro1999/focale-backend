import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateDrizzleJson } from "drizzle-kit/api";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../src/schema";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import { dbTestsEnabled } from "../helpers/test-env";
import { normalizeSqlExpression } from "../helpers/sql-expression-normalizer";
import { dbTestSetupTimeoutMs } from "../../vitest.shared";

const RAW_INDEX_NAMES = [
  "email_template_registration_uniq",
  "email_template_abstract_uniq",
  "abstracts_event_id_author_email_normalized_key",
  "email_logs_registration_trigger_active_key",
  "email_logs_abstract_submission_ack_active_key",
  "email_logs_template_recipient_trigger_active_key",
  "outbox_events_dedupe_key_key",
];
const GIN_INDEX_NAME = "registrations_access_type_ids_inverted_idx";
const LEDGER_TABLES = new Set([
  "schema_migrations",
  "schema_migration_steps",
  "schema_migration_lock",
]);
// All raw migration indexes that remain in the final catalog are also declared
// in Drizzle now. This allowlist is intentionally empty; new raw-only indexes
// need a named entry and a short reason here before they can pass drift checks.
const RAW_INDEX_ALLOWLIST = new Set<string>();
// These domain invariants remain authored in raw 0012/0013 SQL. Keep their
// actual table and expression in the expected catalog so raw checks are not
// reduced to name-only allowlist entries.
const RAW_CHECK_CONSTRAINTS = {
  networking_blocks_no_self: {
    table_name: "networking_blocks",
    expression: "profile_id <> target_id",
  },
  networking_connections_ordered_pair: {
    table_name: "networking_connections",
    expression: "profile_a_id < profile_b_id",
  },
  networking_embedding_jobs_status_check: {
    table_name: "networking_embedding_jobs",
    expression: "status IN ('PENDING','PROCESSING','READY','FAILED')",
  },
  networking_embeddings_kind_check: {
    table_name: "networking_embeddings",
    expression: "kind IN ('PROFILE','OFFER','NEED')",
  },
  networking_interests_no_self: {
    table_name: "networking_interests",
    expression: "profile_id <> target_id",
  },
  networking_meetings_valid_interval: {
    table_name: "networking_meetings",
    expression: "ends_at > starts_at",
  },
  networking_meetings_valid_pair: {
    table_name: "networking_meetings",
    expression: "requester_id <> recipient_id",
  },
  networking_messages_body_length: {
    table_name: "networking_messages",
    expression: "char_length(body) BETWEEN 1 AND 1000",
  },
  networking_tables_minimum_capacity: {
    table_name: "networking_tables",
    expression: "capacity >= 2",
  },
} as const;

type DrizzleColumn = {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
  default?: string | number | boolean;
};
type DrizzleIndex = {
  name: string;
  columns: Array<{ expression: string }>;
  isUnique: boolean;
  method: string;
  where?: string;
};
type DrizzleForeignKey = {
  name: string;
  tableFrom: string;
  tableTo: string;
  columnsFrom: string[];
  columnsTo: string[];
  onDelete?: string;
  onUpdate?: string;
};
type DrizzleCheck = { name: string; value: string };
type DrizzleTables = Record<string, {
  name: string;
  columns: Record<string, DrizzleColumn>;
  indexes: Record<string, DrizzleIndex>;
  uniqueConstraints: Record<string, { name: string }>;
  foreignKeys: Record<string, DrizzleForeignKey>;
  checkConstraints: Record<string, DrizzleCheck>;
  compositePrimaryKeys: Record<string, { name: string; columns: string[] }>;
}>;

function normalizeType(type: string): string {
  return type
    .replace(/"([^"]+)"/g, "$1")
    .replace(/\s*\(\s*(\d+)\s*\)/g, "($1)")
    .replace(/ without time zone/g, "")
    .toLowerCase();
}

function quoteSnapshotColumnNames(expression: string, table: DrizzleTables[string]): string {
  // Drizzle's snapshot stores _AccessPrerequisites references as lowercase
  // property names even though the physical SQL columns are uppercase A/B.
  // Quote only physical names whose spelling cannot be represented unquoted.
  const columnNames = new Map(Object.values(table.columns)
    .filter((column) => column.name !== column.name.toLowerCase() || !/^[a-z_][a-z0-9_]*$/.test(column.name))
    .map((column) => [column.name.toLowerCase(), column.name]));
  let result = "";
  let index = 0;

  while (index < expression.length) {
    const char = expression[index];
    if (char === "'") {
      const escapePrefix = index > 0 && /e/i.test(expression[index - 1]) &&
        (index === 1 || !/[a-z0-9_$]/i.test(expression[index - 2]));
      let end = index + 1;
      while (end < expression.length) {
        if (escapePrefix && expression[end] === "\\") {
          end += 2;
          continue;
        }
        if (expression[end] !== "'") {
          end++;
          continue;
        }
        if (expression[end + 1] === "'") {
          end += 2;
          continue;
        }
        end++;
        break;
      }
      result += expression.slice(index, end);
      index = end;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      while (end < expression.length) {
        if (expression[end] !== '"') {
          end++;
          continue;
        }
        if (expression[end + 1] === '"') {
          end += 2;
          continue;
        }
        end++;
        break;
      }
      result += expression.slice(index, end);
      index = end;
      continue;
    }
    if (char === "$") {
      const delimiter = /^\$(?:[a-z_][a-z0-9_]*)?\$/i.exec(expression.slice(index))?.[0];
      if (delimiter) {
        const close = expression.indexOf(delimiter, index + delimiter.length);
        if (close >= 0) {
          const end = close + delimiter.length;
          result += expression.slice(index, end);
          index = end;
          continue;
        }
      }
    }
    if (/[a-z_]/i.test(char)) {
      let end = index + 1;
      while (end < expression.length && /[a-z0-9_$]/i.test(expression[end])) end++;
      const token = expression.slice(index, end);
      const columnName = columnNames.get(token.toLowerCase());
      result += columnName === undefined ? token : `"${columnName.replace(/"/g, '""')}"`;
      index = end;
      continue;
    }
    result += char;
    index++;
  }

  return result;
}

function normalizeDrizzleExpression(expression: string | null, table: DrizzleTables[string]): string | null {
  return expression === null
    ? null
    : normalizeSqlExpression(quoteSnapshotColumnNames(expression, table), table.name);
}

function normalizeAction(action: string | undefined): string {
  return (action ?? "no action").replace(/_/g, " ").toLowerCase();
}

function normalizeSimpleArrayLiteral(expression: string): string | null {
  const body = /^'\{(.*)\}'$/.exec(expression)?.[1];
  if (body === undefined) return null;
  if (body === "") return "[]";

  const values: Array<string | null> = [];
  let offset = 0;
  while (offset < body.length) {
    let value: string;
    let quoted = false;
    if (body[offset] === '"') {
      quoted = true;
      const end = body.indexOf('"', offset + 1);
      if (end < 0) return null;
      value = body.slice(offset + 1, end);
      if (!/^[a-z_][a-z0-9_]*$/i.test(value)) return null;
      offset = end + 1;
    } else {
      const match = /^[a-z_][a-z0-9_]*/i.exec(body.slice(offset));
      if (!match) return null;
      value = match[0];
      offset += value.length;
    }

    values.push(!quoted && value.toUpperCase() === "NULL" ? null : value);
    if (offset === body.length) break;
    if (body[offset] !== ",") return null;
    offset++;
    if (offset === body.length) return null;
  }
  return JSON.stringify(values);
}

function normalizeColumnDefault(expression: string | null, type: string): string | null {
  const normalized = normalizeSqlExpression(expression);
  if (normalized === null) return null;
  if (type.endsWith("[]")) {
    const arrayValue = normalizeSimpleArrayLiteral(normalized);
    if (arrayValue !== null) return arrayValue;
  }
  if (/^(smallint|integer|bigint|numeric|real|double precision)$/.test(type)) {
    const quotedNumber = /^'([+-]?\d+(?:\.\d+)?)'$/.exec(normalized);
    if (quotedNumber) return quotedNumber[1];
  }
  return normalized;
}

async function readPostgresColumnDetails(client: ScratchDatabase["client"]) {
  const { rows } = await client.query<{
    table_name: string;
    column_name: string;
    type: string;
    not_null: boolean;
    primary_key: boolean;
    default_expression: string | null;
  }>(`SELECT c.relname AS table_name, a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null,
            EXISTS (
              SELECT 1 FROM pg_constraint pc
              WHERE pc.conrelid=c.oid AND pc.contype='p'
                AND a.attnum = ANY(pc.conkey)
            ) AS primary_key,
            pg_get_expr(d.adbin, d.adrelid, true) AS default_expression
     FROM pg_attribute a
     JOIN pg_class c ON c.oid=a.attrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
     LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
     WHERE n.nspname='public' AND c.relkind IN ('r','p')
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname,a.attnum`);
  return Object.fromEntries(rows.map((column) => [
    `${column.table_name}.${column.column_name}`,
    {
      name: column.column_name,
      type: normalizeType(column.type),
      primaryKey: column.primary_key,
      notNull: column.not_null,
      default: normalizeColumnDefault(column.default_expression, normalizeType(column.type)),
    },
  ]));
}

async function readPostgresIndexDetails(client: ScratchDatabase["client"]) {
  const { rows } = await client.query<{
    index_name: string;
    table_name: string;
    is_primary: boolean;
    is_unique: boolean;
    method: string;
    is_partial: boolean;
    key_columns: string[];
    predicate: string | null;
  }>(`SELECT index_relation.relname AS index_name,
            table_relation.relname AS table_name,
            index_definition.indisprimary AS is_primary,
            index_definition.indisunique AS is_unique,
            access_method.amname AS method,
            index_definition.indpred IS NOT NULL AS is_partial,
            ARRAY(
              SELECT pg_get_indexdef(index_definition.indexrelid, key_position, true)
              FROM generate_series(1, index_definition.indnkeyatts) AS key_position
            ) AS key_columns,
            pg_get_expr(index_definition.indpred, index_definition.indrelid, true) AS predicate
     FROM pg_index index_definition
     JOIN pg_class index_relation ON index_relation.oid=index_definition.indexrelid
     JOIN pg_class table_relation ON table_relation.oid=index_definition.indrelid
     JOIN pg_am access_method ON access_method.oid=index_relation.relam
     JOIN pg_namespace n ON n.oid=table_relation.relnamespace
     WHERE n.nspname='public'`);
  return Object.fromEntries(rows.filter((index) => !index.is_primary).map((index) => [
    index.index_name,
    {
      table_name: index.table_name,
      key_columns: index.key_columns.map((expression) => normalizeSqlExpression(expression, index.table_name)),
      is_unique: index.is_unique,
      method: index.method.toLowerCase(),
      is_partial: index.is_partial,
      predicate: normalizeSqlExpression(index.predicate, index.table_name),
    },
  ]));
}

async function readPostgresCheckDetails(client: ScratchDatabase["client"]) {
  const { rows } = await client.query<{
    table_name: string;
    constraint_name: string;
    expression: string;
  }>(`SELECT table_relation.relname AS table_name,
            constraint_row.conname AS constraint_name,
            pg_get_expr(constraint_row.conbin, constraint_row.conrelid, true) AS expression
     FROM pg_constraint constraint_row
     JOIN pg_class table_relation ON table_relation.oid=constraint_row.conrelid
     JOIN pg_namespace n ON n.oid=table_relation.relnamespace
     WHERE n.nspname='public' AND constraint_row.contype='c'`);
  return Object.fromEntries(rows
    .filter((constraint) => !LEDGER_TABLES.has(constraint.table_name))
    .map((constraint) => [constraint.constraint_name, {
      table_name: constraint.table_name,
      expression: normalizeSqlExpression(constraint.expression, constraint.table_name),
    }]));
}

async function readPostgresForeignKeyDetails(client: ScratchDatabase["client"]) {
  const { rows } = await client.query<{
    constraint_name: string;
    table_name: string;
    referenced_table: string;
    columns_from: string[];
    columns_to: string[];
    on_delete: string;
    on_update: string;
  }>(`SELECT constraint_row.conname AS constraint_name,
            source_table.relname AS table_name,
            target_table.relname AS referenced_table,
            ARRAY(
              SELECT source_column.attname
              FROM unnest(constraint_row.conkey) WITH ORDINALITY AS source_key(attnum, ordinality)
              JOIN pg_attribute source_column
                ON source_column.attrelid=constraint_row.conrelid
               AND source_column.attnum=source_key.attnum
              ORDER BY source_key.ordinality
            )::text[] AS columns_from,
            ARRAY(
              SELECT target_column.attname
              FROM unnest(constraint_row.confkey) WITH ORDINALITY AS target_key(attnum, ordinality)
              JOIN pg_attribute target_column
                ON target_column.attrelid=constraint_row.confrelid
               AND target_column.attnum=target_key.attnum
              ORDER BY target_key.ordinality
            )::text[] AS columns_to,
            CASE constraint_row.confdeltype
              WHEN 'a' THEN 'no action' WHEN 'r' THEN 'restrict' WHEN 'c' THEN 'cascade'
              WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default'
            END AS on_delete,
            CASE constraint_row.confupdtype
              WHEN 'a' THEN 'no action' WHEN 'r' THEN 'restrict' WHEN 'c' THEN 'cascade'
              WHEN 'n' THEN 'set null' WHEN 'd' THEN 'set default'
            END AS on_update
     FROM pg_constraint constraint_row
     JOIN pg_class source_table ON source_table.oid=constraint_row.conrelid
     JOIN pg_namespace source_schema ON source_schema.oid=source_table.relnamespace
     JOIN pg_class target_table ON target_table.oid=constraint_row.confrelid
     JOIN pg_namespace target_schema ON target_schema.oid=target_table.relnamespace
     WHERE constraint_row.contype='f' AND source_schema.nspname='public'
       AND target_schema.nspname='public'`);
  return Object.fromEntries(rows.map((foreignKey) => [foreignKey.constraint_name, {
    table_name: foreignKey.table_name,
    columns_from: foreignKey.columns_from,
    referenced_table: foreignKey.referenced_table,
    columns_to: foreignKey.columns_to,
    on_delete: normalizeAction(foreignKey.on_delete),
    on_update: normalizeAction(foreignKey.on_update),
  }]));
}

const DRIZZLE_TABLES = Object.values(schema)
  .filter((value): value is PgTable => value instanceof PgTable)
  .map((table) => getTableConfig(table).name)
  .sort();

describe.runIf(dbTestsEnabled())("migration tier: apply + introspect", () => {
  let scratch: ScratchDatabase;
  beforeAll(async () => {
    scratch = await createScratchDatabase({ label: "schema_migration" });
  }, dbTestSetupTimeoutMs());
  afterAll(async () => scratch?.close());

  it("creates exactly the Drizzle application tables", async () => {
    const { rows } = await scratch.client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
    );
    const actual = rows.map((row) => row.table_name).filter((name) => !LEDGER_TABLES.has(name)).sort();
    expect(actual).toEqual(DRIZZLE_TABLES);
  });

  it("creates exactly 19 public enum types", async () => {
    const { rows } = await scratch.client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_type t
       JOIN pg_namespace n ON n.oid=t.typnamespace
       WHERE n.nspname='public' AND t.typtype='e'`,
    );
    expect(Number(rows[0].n)).toBe(19);
  });

  it("creates the partial indexes and engine-specific array index by name", async () => {
    const { rows } = await scratch.client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public'`,
    );
    const names = new Set(rows.map((row) => row.indexname));
    for (const name of RAW_INDEX_NAMES) expect(names.has(name)).toBe(true);
    expect(names.has(GIN_INDEX_NAME)).toBe(true);

    if (scratch.engine === "postgres") {
      const { rows: gin } = await scratch.client.query<{ amname: string }>(
        `SELECT am.amname FROM pg_class c
         JOIN pg_index i ON i.indexrelid=c.oid
         JOIN pg_am am ON am.oid=c.relam WHERE c.relname=$1`,
        [GIN_INDEX_NAME],
      );
      expect(gin[0]?.amname).toBe("gin");
    } else {
      const { rows: indexes } = await scratch.client.query<Record<string, unknown>>(
        `SHOW INDEX FROM registrations`,
      );
      const inverted = indexes.find((row) => row.index_name === GIN_INDEX_NAME);
      expect(inverted).toBeDefined();
      expect(JSON.stringify(inverted).toLowerCase()).toMatch(/inverted|gin/);
    }
  });

  it("does not recreate the intentionally dropped abstract code-number index", async () => {
    const { rows } = await scratch.client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public'`,
    );
    expect(rows.map((row) => row.indexname)).not.toContain("abstracts_event_id_code_number_key");
  });

  it("creates the one-active-job-per-event partial unique index", async () => {
    const { rows } = await scratch.client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename='abstract_book_jobs'`,
    );
    expect(rows.map((row) => row.indexname)).toContain("abstract_book_jobs_event_id_active_key");
  });

  it("preserves selected column types and defaults", async () => {
    const { rows } = await scratch.client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      column_default: string | null;
    }>(`SELECT table_name,column_name,data_type,column_default FROM information_schema.columns
        WHERE (table_name='event_access' AND column_name='companion_price')
           OR (table_name='clients' AND column_name IN ('id','updated_at'))`);
    const by = (table: string, column: string) => rows.find((row) => row.table_name === table && row.column_name === column);
    expect(by("event_access", "companion_price")?.data_type).toBe("bigint");
    expect(by("clients", "id")?.data_type).toBe("text");
    expect(by("clients", "updated_at")?.data_type).toBe("timestamp without time zone");
    expect(by("clients", "updated_at")?.column_default).toBeNull();
  });

  it("adds multilingual columns and timezone-aware check-in timestamps", async () => {
    const { rows } = await scratch.client.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name,column_name,data_type FROM information_schema.columns
       WHERE (table_name='forms' AND column_name='success_translations')
          OR (table_name='abstract_config' AND column_name='languages')
          OR (table_name='abstract_themes' AND column_name='translations')
          OR (table_name IN ('registrations','access_check_ins') AND column_name='checked_in_at')`,
    );
    expect(rows.filter((row) => row.data_type === "jsonb")).toHaveLength(3);
    expect(rows.filter((row) => row.data_type === "timestamp with time zone")).toHaveLength(2);
  });

  it("re-applying the runner applies nothing", async () => {
    const result = await scratch.applyMigrations();
    expect(result.applied).toEqual([]);
    expect(result.skipped.length + result.deferred.length).toBeGreaterThan(0);
  });

  it(
    "matches the fresh PostgreSQL catalog to the Drizzle snapshot",
    async ({ skip }) => {
      if (scratch.engine !== "postgres") skip();
      const expected = generateDrizzleJson(schema, undefined, ["public"], "snake_case");
      const tables = expected.tables as DrizzleTables;
      const expectedTableNames = Object.values(tables).map((table) => table.name).sort();

      const { rows: catalogTables } = await scratch.client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`,
      );
      const actualTableNames = catalogTables
        .map((row) => row.table_name)
        .filter((name) => !LEDGER_TABLES.has(name))
        .sort();
      expect(actualTableNames).toEqual(expectedTableNames);

      const actualColumns = await readPostgresColumnDetails(scratch.client);
      const comparableActualColumns = Object.fromEntries(Object.entries(actualColumns)
        .filter(([key]) => !LEDGER_TABLES.has(key.split(".")[0])));
      const expectedColumns = Object.fromEntries(Object.values(tables).flatMap((table) =>
        Object.values(table.columns).map((column) => [`${table.name}.${column.name}`, {
          name: column.name,
          type: normalizeType(column.type),
          // The catalog flags every column of a composite primary key (e.g. networking_allocation_locks).
          primaryKey: column.primaryKey || Object.values(table.compositePrimaryKeys ?? {})
            .some((key) => key.columns.includes(column.name)),
          notNull: column.notNull,
          default: normalizeColumnDefault(column.default === undefined ? null : String(column.default), normalizeType(column.type)),
        }] as const),
      ));
      expect(comparableActualColumns).toEqual(expectedColumns);

      const expectedIndexDetails = new Map(Object.values(tables).flatMap((table) =>
        Object.values(table.indexes).map((index) => [index.name, {
          table_name: table.name,
          key_columns: index.columns.map((column) => normalizeDrizzleExpression(column.expression, table)),
          is_unique: index.isUnique,
          method: index.method.toLowerCase(),
          is_partial: Boolean(index.where),
          predicate: normalizeDrizzleExpression(index.where ?? null, table),
        }] as const),
      ));
      const expectedIndexes = new Set([
        ...expectedIndexDetails.keys(),
        ...Object.values(tables).flatMap((table) =>
          Object.values(table.uniqueConstraints).map((constraint) => constraint.name),
        ),
      ]);
      const actualIndexDetails = await readPostgresIndexDetails(scratch.client);
      const actualIndexes = new Set(Object.keys(actualIndexDetails));
      const missingIndexes = [...expectedIndexes].filter((name) => !actualIndexes.has(name)).sort();
      const unexpectedIndexes = [...actualIndexes]
        .filter((name) => !expectedIndexes.has(name) && !RAW_INDEX_ALLOWLIST.has(name))
        .sort();
      expect({ missingIndexes, unexpectedIndexes }).toEqual({ missingIndexes: [], unexpectedIndexes: [] });

      const comparableExpectedIndexes = Object.fromEntries(expectedIndexDetails);
      const comparableActualIndexes = Object.fromEntries([...expectedIndexDetails.keys()]
        .map((name) => [name, actualIndexDetails[name]]));
      expect(comparableActualIndexes).toEqual(comparableExpectedIndexes);

      const expectedCheckNames = new Set([
        ...Object.values(tables).flatMap((table) => Object.values(table.checkConstraints).map((constraint) => constraint.name)),
        ...Object.keys(RAW_CHECK_CONSTRAINTS),
      ]);
      const actualChecks = await readPostgresCheckDetails(scratch.client);
      const actualCheckNames = new Set(Object.keys(actualChecks));
      expect([...actualCheckNames].sort()).toEqual([...expectedCheckNames].sort());
      const expectedCheckDetails = Object.fromEntries([
        ...Object.values(tables).flatMap((table) =>
          Object.values(table.checkConstraints).map((constraint) => [constraint.name, {
            table_name: table.name,
            expression: normalizeDrizzleExpression(constraint.value, table),
          }] as const),
        ),
        ...Object.entries(RAW_CHECK_CONSTRAINTS).map(([name, constraint]) => {
          const table = Object.values(tables).find((candidate) => candidate.name === constraint.table_name)!;
          return [name, {
            table_name: constraint.table_name,
            expression: normalizeDrizzleExpression(constraint.expression, table),
          }] as const;
        }),
      ]);
      const comparableActualChecks = actualChecks;
      expect(comparableActualChecks).toEqual(expectedCheckDetails);

      const expectedForeignKeys = Object.values(tables).flatMap((table) =>
        Object.values(table.foreignKeys).map((foreignKey) => ({
          table_name: foreignKey.tableFrom,
          columns_from: foreignKey.columnsFrom,
          referenced_table: foreignKey.tableTo,
          columns_to: foreignKey.columnsTo,
          on_delete: normalizeAction(foreignKey.onDelete),
          on_update: normalizeAction(foreignKey.onUpdate),
        })),
      ).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const actualForeignKeys = await readPostgresForeignKeyDetails(scratch.client);
      expect(Object.values(actualForeignKeys).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
        .toEqual(expectedForeignKeys);
    },
  );

  it("detects drift in an index predicate, case-sensitive CHECK/default literals, and foreign key", async ({ skip }) => {
    if (scratch.engine !== "postgres") skip();
    const expected = generateDrizzleJson(schema, undefined, ["public"], "snake_case");
    const tables = expected.tables as DrizzleTables;
    const clientsTable = Object.values(tables).find((table) => table.name === "clients")!;
    const eventAccessTable = Object.values(tables).find((table) => table.name === "event_access")!;
    const emailDedupeTable = Object.values(tables).find((table) =>
      Object.values(table.indexes).some((index) => index.name === "email_logs_dedupe_key_active_key"),
    )!;
    const emailDedupe = Object.values(emailDedupeTable.indexes)
      .find((index) => index.name === "email_logs_dedupe_key_active_key")!;
    const scopeCheckTable = Object.values(tables).find((table) =>
      Object.values(table.checkConstraints).some((constraint) => constraint.name === "certificate_templates_scope_check"),
    )!;
    const scopeCheck = Object.values(scopeCheckTable.checkConstraints)
      .find((constraint) => constraint.name === "certificate_templates_scope_check")!;
    const activeColumn = clientsTable.columns.active;
    const currencyColumn = eventAccessTable.columns.currency;
    const rawPairCheck = RAW_CHECK_CONSTRAINTS.networking_connections_ordered_pair;
    const eventForeignKey = Object.values(tables).flatMap((table) => Object.values(table.foreignKeys))
      .find((foreignKey) => foreignKey.name === "certificate_templates_event_id_events_id_fk")!;

    await scratch.client.query("BEGIN");
    try {
      await scratch.client.query("DROP INDEX email_logs_dedupe_key_active_key");
      await scratch.client.query(`CREATE UNIQUE INDEX email_logs_dedupe_key_active_key
        ON email_logs (dedupe_key) WHERE dedupe_key IS NOT NULL`);
      await scratch.client.query(`ALTER TABLE certificate_templates
        DROP CONSTRAINT certificate_templates_scope_check`);
      await scratch.client.query(`ALTER TABLE certificate_templates
        ADD CONSTRAINT certificate_templates_scope_check
        CHECK (scope IN ('registration', 'ABSTRACT', 'BOTH', 'OTHER'))`);
      await scratch.client.query(`ALTER TABLE networking_connections
        DROP CONSTRAINT networking_connections_ordered_pair`);
      await scratch.client.query(`ALTER TABLE networking_connections
        ADD CONSTRAINT networking_connections_ordered_pair
        CHECK (profile_a_id <= profile_b_id)`);
      await scratch.client.query("ALTER TABLE clients ALTER COLUMN active SET DEFAULT false");
      await scratch.client.query("ALTER TABLE event_access ALTER COLUMN currency SET DEFAULT 'tnd'");
      await scratch.client.query(`ALTER TABLE certificate_templates
        DROP CONSTRAINT certificate_templates_event_id_events_id_fk`);
      await scratch.client.query(`ALTER TABLE certificate_templates
        ADD CONSTRAINT certificate_templates_event_id_events_id_fk
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE RESTRICT ON UPDATE CASCADE`);

      const alteredIndex = (await readPostgresIndexDetails(scratch.client)).email_logs_dedupe_key_active_key;
      expect(alteredIndex.predicate).not.toBe(normalizeSqlExpression(emailDedupe.where ?? null, emailDedupeTable.name));
      const alteredCheck = (await readPostgresCheckDetails(scratch.client)).certificate_templates_scope_check;
      expect(alteredCheck.expression).not.toBe(normalizeSqlExpression(scopeCheck.value, scopeCheckTable.name));
      expect(alteredCheck.expression).toContain("'registration'");
      const alteredRawCheck = (await readPostgresCheckDetails(scratch.client)).networking_connections_ordered_pair;
      expect(alteredRawCheck).not.toEqual({
        table_name: rawPairCheck.table_name,
        expression: normalizeSqlExpression(rawPairCheck.expression, rawPairCheck.table_name),
      });
      const alteredColumns = await readPostgresColumnDetails(scratch.client);
      expect(alteredColumns["clients.active"].default)
        .not.toBe(normalizeSqlExpression(activeColumn.default === undefined ? null : String(activeColumn.default)));
      expect(alteredColumns["event_access.currency"].default).not.toBe(
        normalizeSqlExpression(currencyColumn.default === undefined ? null : String(currencyColumn.default)),
      );
      const alteredForeignKeys = await readPostgresForeignKeyDetails(scratch.client);
      const foreignKeyExpected = {
        table_name: eventForeignKey.tableFrom,
        columns_from: eventForeignKey.columnsFrom,
        referenced_table: eventForeignKey.tableTo,
        columns_to: eventForeignKey.columnsTo,
        on_delete: normalizeAction(eventForeignKey.onDelete),
        on_update: normalizeAction(eventForeignKey.onUpdate),
      };
      expect(alteredForeignKeys[eventForeignKey.name]).not.toEqual(foreignKeyExpected);
    } finally {
      await scratch.client.query("ROLLBACK");
    }
  });
});
