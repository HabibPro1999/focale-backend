import type { Client } from "pg";
import type { DatabaseEngine, MigrationDefinition } from "./migration";
import type { ApplyMigrationsOptions, SchemaMigrationRecord } from "./types";

function beginsWithCockroachVectorIndex(statement: string): boolean {
  const sql = statement
    .replace(/^(?:\s*--[^\r\n]*(?:\r?\n|$))+/, "")
    .trimStart();
  return /^CREATE\s+VECTOR\s+INDEX\b/i.test(sql);
}

export async function unmetRequirement(
  client: Client,
  engine: DatabaseEngine,
  migration: MigrationDefinition,
): Promise<string | undefined> {
  if (engine === "postgres") {
    for (const extension of migration.directives.requiresExtensions) {
      const result = await client.query<{ present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = $1) AS present",
        [extension],
      );
      if (!result.rows[0]?.present) {
        return `Migration ${migration.id} requires the PostgreSQL ${extension} extension to be installed before apply`;
      }
    }
  }

  if (engine === "cockroach" && migration.statements.some(beginsWithCockroachVectorIndex)) {
    const result = await client.query("SHOW CLUSTER SETTING feature.vector_index.enabled");
    const value = Object.values(result.rows[0] ?? {}).some((entry) => entry === true || entry === "true" || entry === "on");
    if (!value) return "CockroachDB vector indexes require feature.vector_index.enabled; ask the database administrator to enable it";
  }
  return undefined;
}

export function mayDeferRequirement(engine: DatabaseEngine, migration: MigrationDefinition, options: ApplyMigrationsOptions): boolean {
  return engine === "cockroach" && migration.directives.deferrable && options.applyDeferred !== migration.id;
}

export async function evaluateSafeCondition(client: Client, sql: string): Promise<boolean> {
  const result = await client.query(sql);
  if (!result.rows.length) return false;
  const firstRow = result.rows[0] as Record<string, unknown>;
  const firstValue = firstRow[Object.keys(firstRow)[0] ?? ""];
  return firstValue === true || firstValue === "true" || firstValue === 1;
}

export function missingRelationFrom(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code !== "42P01" || typeof candidate.message !== "string") return undefined;
  const match = candidate.message.match(/relation\s+["']?([a-zA-Z_][a-zA-Z0-9_$.]*)/i);
  return match?.[1];
}

function migrationCreatesTable(migration: MigrationDefinition, relationName: string): boolean {
  const name = relationName.split(".").at(-1)?.replaceAll('"', "");
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sql = migration.source.replace(/--[^\r\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  return new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:(?:public|"public")\\s*\\.\\s*)?(?:"${escaped}"|${escaped})(?![a-zA-Z0-9_$])`,
    "i",
  ).test(sql);
}

export function pendingMigrationCreatingRelation(
  relationName: string,
  earlierMigrations: MigrationDefinition[],
  records: Map<string, SchemaMigrationRecord>,
): MigrationDefinition | undefined {
  return earlierMigrations.find((migration) => {
    const record = records.get(migration.id);
    return record === undefined && migrationCreatesTable(migration, relationName);
  });
}
