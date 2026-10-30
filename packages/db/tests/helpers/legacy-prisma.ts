import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Client } from "pg";
import type { DatabaseEngine } from "../../src/migrator";
import { createScratchDatabase, type ScratchDatabase } from "../../src/testing/database";

// The legacy production database before adoption: Prisma's schema from main
// plus a finished `_prisma_migrations`, and no unified migration ledger. The
// fixture's header says how it was generated.

export const LEGACY_PRISMA_FIXTURE = resolve(__dirname, "../migration/fixtures/legacy-prisma-schema.cockroach.sql");

/** main's prisma/migrations directories (commit 0f86c91d): the fixture records each one as finished. */
export const LEGACY_PRISMA_MIGRATION_NAMES = [
  "0_init",
  "20260223000000_add_target_registration_id",
  "20260319000000_align_develop_db_to_schema",
  "20260319000001_add_inverted_index_access_type_ids",
  "20260319000002_add_sponsorship_event_status_index",
  "20260319000003_fix_prod_event_access_columns",
  "20260319000004_drop_unused_indexes",
  "20260323000000_add_certificates_module",
  "20260325000000_add_reference_number",
  "20260403000000_add_checkin_module",
  "20260411000000_add_certificate_sent_trigger",
  "20260426000000_add_abstracts_config",
  "20260426100000_add_abstracts_submission",
  "20260426210000_add_committee_scoring_foundation",
  "20260426300000_add_abstract_finalization",
  "20260426400000_add_abstract_book_jobs",
  "20260501000000_add_worker_job_leases",
  "20260512000000_add_abstract_code_number_unique",
  "20260514000000_tshg_abstract_requirements",
  "20260516000000_add_dedupe_hardening",
  "20260516001000_add_outbox_events",
  "20260522000000_add_abstracts_module_default",
  "20260524000000_add_abstract_decision_email_triggers",
  "20260524001000_add_abstract_code_sequences",
  "20260524002000_add_abstract_theme_descriptions",
  "20260525000000_align_prod_dev_schema",
  "20260525001000_normalize_checkin_timestamp_default",
  "20260528000000_extend_email_trigger_dedupe",
  "20260530000000_add_abstract_author_affiliation",
  "20260806000000_add_multilanguage_forms",
  "20260814000000_add_committee_invite_tokens",
] as const;

export interface LegacyPrismaSchemaOptions {
  /** Rewrites the fixture's CockroachDB SQL before it runs, e.g. to leave out a column or an enum label. */
  edit?: (sql: string) => string;
}

/** Splits a SQL script at semicolons outside quotes and comments, and drops the comments. */
export function splitSqlScript(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
    } else if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
    } else if (char === "'" || char === '"') {
      // A doubled quote is an escaped one, so scanning to each closing quote in turn keeps it.
      let end = sql.indexOf(char, index + 1);
      while (end !== -1 && sql[end + 1] === char) end = sql.indexOf(char, end + 2);
      if (end === -1) throw new Error(`Unterminated ${char} quote in SQL script`);
      current += sql.slice(index, end + 1);
      index = end + 1;
    } else if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      index += 1;
    } else {
      current += char;
      index += 1;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

const QUOTED = /('(?:[^']|'')*'|"(?:[^"]|"")*")/;

/** A fixture statement as PostgreSQL runs it: STRING is TEXT, an inverted index is a GIN index. */
export function toPostgres(statement: string): string {
  const unquoted = statement
    .split(QUOTED)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/\bSTRING\b/g, "TEXT")))
    .join("");
  return unquoted.replace(
    /^CREATE INVERTED INDEX ("(?:[^"]|"")+")\s+ON ("(?:[^"]|"")+")\s*\(/,
    "CREATE INDEX $1 ON $2 USING GIN (",
  );
}

/** The fixture's statements, in order, for an engine. */
export function legacyPrismaStatements(engine: DatabaseEngine, options: LegacyPrismaSchemaOptions = {}): string[] {
  const source = readFileSync(LEGACY_PRISMA_FIXTURE, "utf8");
  const statements = splitSqlScript(options.edit ? options.edit(source) : source);
  return engine === "postgres" ? statements.map(toPostgres) : statements;
}

/**
 * Builds the legacy schema in an empty database, one statement per transaction:
 * CockroachDB cannot use a table in a schema change made earlier in the same transaction.
 */
export async function loadLegacyPrismaSchema(
  client: Client,
  engine: DatabaseEngine,
  options: LegacyPrismaSchemaOptions = {},
): Promise<void> {
  for (const statement of legacyPrismaStatements(engine, options)) {
    try {
      await client.query(statement);
    } catch (error) {
      throw new Error(`Legacy Prisma fixture failed at: ${statement.slice(0, 200)}`, { cause: error });
    }
  }
}

/** Writes only the fixture's `_prisma_migrations` table and rows, e.g. beside a schema the runner built. */
export async function writeLegacyPrismaLedger(client: Client): Promise<void> {
  const statements = legacyPrismaStatements("cockroach").filter((statement) =>
    /^(?:CREATE TABLE|INSERT INTO) "_prisma_migrations"/.test(statement),
  );
  if (statements.length !== 2) throw new Error("The legacy Prisma fixture no longer has its _prisma_migrations section");
  for (const statement of statements) await client.query(statement);
}

/**
 * A scratch database shaped like production before the cutover: the legacy
 * Prisma schema and `_prisma_migrations`, no `schema_migrations`. Adopt it
 * with `adoptMigrations` before `applyMigrations`, which refuses it until then.
 */
export async function createLegacyPrismaDatabase(
  options: { label: string } & LegacyPrismaSchemaOptions,
): Promise<ScratchDatabase> {
  const database = await createScratchDatabase({ label: options.label, empty: true });
  try {
    await loadLegacyPrismaSchema(database.client, database.engine, options);
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
  return database;
}
