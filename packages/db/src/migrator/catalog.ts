import type { Client, QueryResultRow } from "pg";
import type { DatabaseEngine, MigrationDefinition } from "./migration";
import type {
  CatalogObjectKind,
  CatalogObjectProbe,
  CatalogSqlProbe,
  MigrationCatalogReport,
} from "./types";

function stripComments(sql: string): string {
  return sql.replace(/--[^\r\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

const IDENTIFIER = '(?:"((?:[^"]|"")+)"|([a-zA-Z_][a-zA-Z0-9_$]*))';
const QUALIFIED_IDENTIFIER = `(?:${IDENTIFIER}\\s*\\.\\s*)?${IDENTIFIER}`;

function identifierValue(match: RegExpExecArray, index: number): string {
  return (match[index] ?? match[index + 1] ?? "").replace(/""/g, '"');
}

function objectName(match: RegExpExecArray, qualifiedStart: number): string {
  return identifierValue(match, qualifiedStart + 2);
}

function findProbe(
  migration: MigrationDefinition,
  statementIndex: number,
  kind: CatalogObjectKind,
  name: string,
  options: { table?: string; expectedPresent?: boolean } = {},
): CatalogObjectProbe {
  return {
    migrationId: migration.id,
    variant: migration.variant,
    statementIndex,
    kind,
    name,
    ...(options.table ? { table: options.table } : {}),
    expectedPresent: options.expectedPresent ?? true,
    source: "ddl",
  };
}

function probesForStatement(
  migration: MigrationDefinition,
  statement: string,
  statementIndex: number,
): CatalogObjectProbe[] {
  const sql = stripComments(statement).trim();
  const probes: CatalogObjectProbe[] = [];
  let match: RegExpExecArray | null;

  match = new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QUALIFIED_IDENTIFIER}`, "i").exec(sql);
  if (match) {
    probes.push(findProbe(migration, statementIndex, "table", objectName(match, 1)));
    return probes;
  }

  match = new RegExp(`^CREATE\\s+TYPE\\s+${QUALIFIED_IDENTIFIER}`, "i").exec(sql);
  if (match) {
    probes.push(findProbe(migration, statementIndex, "type", objectName(match, 1)));
    return probes;
  }

  match = new RegExp(`^CREATE\\s+(?:VECTOR\\s+)?(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENTIFIER}\\s+ON\\s+${QUALIFIED_IDENTIFIER}`, "i").exec(sql);
  if (match) {
    probes.push(findProbe(migration, statementIndex, "index", identifierValue(match, 1), { table: objectName(match, 3) }));
    return probes;
  }

  match = new RegExp(`^DROP\\s+INDEX\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED_IDENTIFIER}`, "i").exec(sql);
  if (match) {
    probes.push(findProbe(migration, statementIndex, "index", objectName(match, 1), { expectedPresent: false }));
    return probes;
  }

  match = new RegExp(`^ALTER\\s+TABLE\\s+${QUALIFIED_IDENTIFIER}\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENTIFIER}`, "i").exec(sql);
  if (match) {
    probes.push(findProbe(migration, statementIndex, "column", identifierValue(match, 5), { table: objectName(match, 1) }));
    return probes;
  }

  match = new RegExp(`^ALTER\\s+TABLE\\s+${QUALIFIED_IDENTIFIER}\\s+ADD\\s+CONSTRAINT\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENTIFIER}`, "i").exec(sql);
  if (match) {
    probes.push(findProbe(migration, statementIndex, "constraint", identifierValue(match, 5), { table: objectName(match, 1) }));
  }
  return probes;
}

export function deriveCatalogProbes(migration: MigrationDefinition): Array<CatalogObjectProbe | CatalogSqlProbe> {
  const probes: Array<CatalogObjectProbe | CatalogSqlProbe> = [];
  migration.statements.forEach((statement, index) => {
    probes.push(...probesForStatement(migration, statement, index));
  });
  for (const extension of migration.directives.requiresExtensions) {
    probes.push({
      migrationId: migration.id,
      variant: migration.variant,
      statementIndex: -1,
      kind: "extension",
      name: extension,
      expectedPresent: true,
      source: "directive",
    });
  }
  for (const query of migration.directives.verify) {
    probes.push({ migrationId: migration.id, variant: migration.variant, query, source: "verify" });
  }
  return probes;
}

async function objectExists(
  client: Client,
  engine: DatabaseEngine,
  probe: CatalogObjectProbe,
): Promise<boolean> {
  if (probe.kind === "extension" && engine === "cockroach") return true;
  let result: { rows: Array<{ present: boolean }> };
  switch (probe.kind) {
    case "table":
      result = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = $1 AND table_type = 'BASE TABLE'
        ) AS present`,
        [probe.name],
      );
      break;
    case "column":
      result = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
        ) AS present`,
        [probe.table, probe.name],
      );
      break;
    case "index":
      result = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_indexes
          WHERE schemaname = 'public' AND indexname = $1
            AND ($2::text IS NULL OR tablename = $2)
        ) AS present`,
        [probe.name, probe.table ?? null],
      );
      break;
    case "constraint":
      result = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_schema = 'public' AND table_name = $1 AND constraint_name = $2
        ) AS present`,
        [probe.table, probe.name],
      );
      break;
    case "type":
      result = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_type t
          JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public' AND t.typname = $1
        ) AS present`,
        [probe.name],
      );
      break;
    case "extension":
      result = await client.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = $1) AS present`,
        [probe.name],
      );
      break;
  }
  const present = Boolean(result.rows[0]?.present);
  return probe.expectedPresent ? present : !present;
}

async function sqlProbe(client: Client, probe: CatalogSqlProbe): Promise<boolean> {
  const result = await client.query<QueryResultRow>(probe.query);
  if (!result.rows.length) return false;
  const firstRow = result.rows[0];
  const firstValue = firstRow[Object.keys(firstRow)[0] ?? ""];
  return firstValue === true || firstValue === "true" || firstValue === 1;
}

export async function inspectMigrationCatalog(
  client: Client,
  engine: DatabaseEngine,
  migration: MigrationDefinition,
): Promise<MigrationCatalogReport> {
  const results: Array<{ probe: CatalogObjectProbe | CatalogSqlProbe; passed: boolean }> = [];
  for (const probe of deriveCatalogProbes(migration)) {
    const passed = "query" in probe
      ? await sqlProbe(client, probe)
      : await objectExists(client, engine, probe);
    results.push({ probe, passed });
  }
  const matched = results.filter((result) => result.passed).length;
  const total = results.length;
  const state = total === 0 ? "unverifiable" : matched === total ? "all" : matched === 0 ? "none" : "partial";
  return { migrationId: migration.id, variant: migration.variant, matched, total, state, probes: results };
}
