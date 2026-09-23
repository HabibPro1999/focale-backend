import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateDrizzleJson } from "drizzle-kit/api";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../src/schema";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import { dbTestsEnabled } from "../helpers/test-env";
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
const RAW_CHECK_CONSTRAINT_ALLOWLIST = new Set([
  // Still authored in the legacy 0012/0013 SQL migrations.
  "networking_blocks_no_self",
  "networking_connections_ordered_pair",
  "networking_embedding_jobs_status_check",
  "networking_embeddings_kind_check",
  "networking_interests_no_self",
  "networking_meetings_valid_interval",
  "networking_meetings_valid_pair",
  "networking_messages_body_length",
  "networking_tables_minimum_capacity",
]);

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
      const tables = expected.tables as Record<
        string,
        {
          name: string;
          columns: Record<string, { name: string; type: string; primaryKey: boolean; notNull: boolean }>;
          indexes: Record<string, {
            name: string;
            columns: Array<{ expression: string }>;
            isUnique: boolean;
            method: string;
            where?: string;
          }>;
          uniqueConstraints: Record<string, { name: string }>;
          checkConstraints: Record<string, { name: string }>;
        }
      >;
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

      const { rows: columns } = await scratch.client.query<{
        table_name: string;
        column_name: string;
        type: string;
        not_null: boolean;
        primary_key: boolean;
      }>(`SELECT c.relname AS table_name, a.attname AS column_name,
                format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull AS not_null,
                EXISTS (
                  SELECT 1 FROM pg_constraint pc
                  WHERE pc.conrelid=c.oid AND pc.contype='p'
                    AND a.attnum = ANY(pc.conkey)
                ) AS primary_key
         FROM pg_attribute a
         JOIN pg_class c ON c.oid=a.attrelid
         JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind IN ('r','p')
           AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY c.relname,a.attnum`);
      const normalizeType = (type: string) => type
        .replace(/"([^"]+)"/g, "$1")
        .replace(/\s*\(\s*(\d+)\s*\)/g, "($1)")
        .replace(/ without time zone/g, "")
        .toLowerCase();
      const actualColumns = Object.fromEntries(
        expectedTableNames.map((tableName) => [tableName, columns
          .filter((column) => column.table_name === tableName)
          .map((column) => ({
            name: column.column_name,
            type: normalizeType(column.type),
            primaryKey: column.primary_key,
            notNull: column.not_null,
          }))
          .sort((a, b) => a.name.localeCompare(b.name))]),
      );
      const expectedColumns = Object.fromEntries(
        Object.values(tables).map((table) => [table.name, Object.values(table.columns)
          .map((column) => ({
            name: column.name,
            type: normalizeType(column.type),
            primaryKey: column.primaryKey,
            notNull: column.notNull,
          }))
          .sort((a, b) => a.name.localeCompare(b.name))]),
      );
      expect(actualColumns).toEqual(expectedColumns);

      const expectedIndexDetails = new Map(Object.values(tables).flatMap((table) =>
        Object.values(table.indexes).map((index) => [index.name, {
          table_name: table.name,
          key_columns: index.columns.map((column) => column.expression),
          is_unique: index.isUnique,
          method: index.method,
          is_partial: Boolean(index.where),
        }] as const),
      ));
      const expectedIndexes = new Set([
        ...expectedIndexDetails.keys(),
        ...Object.values(tables).flatMap((table) =>
          Object.values(table.uniqueConstraints).map((constraint) => constraint.name),
        ),
      ]);
      const { rows: catalogIndexes } = await scratch.client.query<{
        index_name: string;
        table_name: string;
        is_primary: boolean;
        is_unique: boolean;
        method: string;
        is_partial: boolean;
        key_columns: string[];
      }>(`SELECT index_relation.relname AS index_name,
                table_relation.relname AS table_name,
                index_definition.indisprimary AS is_primary,
                index_definition.indisunique AS is_unique,
                access_method.amname AS method,
                index_definition.indpred IS NOT NULL AS is_partial,
                ARRAY(
                  SELECT pg_get_indexdef(index_definition.indexrelid, key_position, true)
                  FROM generate_series(1, index_definition.indnkeyatts) AS key_position
                ) AS key_columns
         FROM pg_index index_definition
         JOIN pg_class index_relation ON index_relation.oid=index_definition.indexrelid
         JOIN pg_class table_relation ON table_relation.oid=index_definition.indrelid
         JOIN pg_am access_method ON access_method.oid=index_relation.relam
         JOIN pg_namespace n ON n.oid=table_relation.relnamespace
         WHERE n.nspname='public'`);
      const actualIndexes = new Set(catalogIndexes
        .filter((index) => !index.is_primary)
        .map((index) => index.index_name));
      const missingIndexes = [...expectedIndexes].filter((name) => !actualIndexes.has(name)).sort();
      const unexpectedIndexes = [...actualIndexes]
        .filter((name) => !expectedIndexes.has(name) && !RAW_INDEX_ALLOWLIST.has(name))
        .sort();
      expect({ missingIndexes, unexpectedIndexes }).toEqual({ missingIndexes: [], unexpectedIndexes: [] });

      const normalizeExpression = (expression: string) => expression
        .replace(/"([^"]+)"/g, "$1")
        .replace(/\b[a-z_][a-z0-9_]*\./gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      const actualIndexDetails = new Map(catalogIndexes
        .filter((index) => !index.is_primary)
        .map((index) => [index.index_name, {
          table_name: index.table_name,
          key_columns: index.key_columns.map(normalizeExpression),
          is_unique: index.is_unique,
          method: index.method,
          is_partial: index.is_partial,
        }] as const));
      const normalizeIndexDetail = (details: {
        table_name: string;
        key_columns: string[];
        is_unique: boolean;
        method: string;
        is_partial: boolean;
      }) => ({
        table_name: details.table_name,
        key_columns: details.key_columns.map(normalizeExpression),
        is_unique: details.is_unique,
        method: details.method.toLowerCase(),
        is_partial: details.is_partial,
      });
      const comparableExpectedIndexes = Object.fromEntries([...expectedIndexDetails]
        .map(([name, details]) => [name, normalizeIndexDetail(details)]));
      const comparableActualIndexes = Object.fromEntries([...expectedIndexDetails.keys()]
        .map((name) => [name, actualIndexDetails.get(name)]));
      expect(comparableActualIndexes).toEqual(comparableExpectedIndexes);

      const expectedChecks = new Set([
        ...Object.values(tables).flatMap((table) =>
          Object.values(table.checkConstraints).map((constraint) => constraint.name),
        ),
        ...RAW_CHECK_CONSTRAINT_ALLOWLIST,
      ]);
      const { rows: catalogChecks } = await scratch.client.query<{
        table_name: string;
        constraint_name: string;
      }>(
        `SELECT table_relation.relname AS table_name,
                constraint_row.conname AS constraint_name
         FROM pg_constraint constraint_row
         JOIN pg_class table_relation ON table_relation.oid=constraint_row.conrelid
         JOIN pg_namespace n ON n.oid=table_relation.relnamespace
         WHERE n.nspname='public' AND constraint_row.contype='c'`,
      );
      const actualChecks = new Set(catalogChecks
        .filter((constraint) => !LEDGER_TABLES.has(constraint.table_name))
        .map((constraint) => constraint.constraint_name));
      expect(actualChecks).toEqual(expectedChecks);
    },
  );
});
