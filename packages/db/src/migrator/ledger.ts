import type { Client } from "pg";
import { tableExists } from "./catalog-read";
import { inspectMigrationCatalog } from "./catalog";
import {
  statementChecksum,
  type MigrationDefinition,
  type MigrationVariant,
} from "./migration";
import type {
  MigrationAdoptionSupport,
  MigrationCatalogAccess,
  MigrationLedgerAccess,
  MigrationStatus,
  SchemaMigrationRecord,
  SchemaMigrationStepRecord,
} from "./types";

export async function schemaHasApplicationObjects(client: Client): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name NOT IN ('schema_migrations', 'schema_migration_steps', 'schema_migration_lock')
    ) AS present`,
  );
  return Boolean(result.rows[0]?.present);
}

export async function migrationLedgerExists(client: Client): Promise<boolean> {
  return tableExists(client, "schema_migrations");
}

export async function createMigrationLedger(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      id text PRIMARY KEY,
      variant text NOT NULL CHECK (variant IN ('shared', 'cockroach')),
      checksum text NOT NULL,
      status text NOT NULL CHECK (status IN ('applied', 'baseline', 'deferred')),
      applied_at timestamptz NOT NULL DEFAULT now(),
      applied_by text NOT NULL,
      evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migration_steps (
      migration_id text NOT NULL,
      variant text NOT NULL CHECK (variant IN ('shared', 'cockroach')),
      step_index integer NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      applied_by text NOT NULL,
      PRIMARY KEY (migration_id, variant, step_index)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migration_lock (
      id integer PRIMARY KEY,
      owner text,
      lease_until timestamptz
    )
  `);
  await client.query(
    "INSERT INTO public.schema_migration_lock (id, owner, lease_until) VALUES (1, NULL, NULL) ON CONFLICT (id) DO NOTHING",
  );
}

export async function assertAdoptionRequiredIfNonEmpty(client: Client): Promise<void> {
  if (!(await schemaHasApplicationObjects(client))) return;
  if (!(await tableExists(client, "schema_migrations"))) {
    throw new Error("Refusing to apply migrations to a non-empty schema without a ledger; run migrate adopt first");
  }
  const ledger = await client.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM public.schema_migrations) AS present",
  );
  if (!ledger.rows[0]?.present) {
    throw new Error("Refusing to apply migrations to a non-empty schema with an empty ledger; run migrate adopt first");
  }
}

export async function listMigrationRecords(client: Client): Promise<SchemaMigrationRecord[]> {
  if (!(await migrationLedgerExists(client))) return [];
  const result = await client.query<SchemaMigrationRecord>(
    `SELECT id, variant, checksum, status, applied_at, applied_by, evidence
     FROM public.schema_migrations ORDER BY id`,
  );
  return result.rows;
}

export async function listMigrationStepRecords(
  client: Client,
  migrationId: string,
  variant: MigrationVariant,
): Promise<SchemaMigrationStepRecord[]> {
  // CockroachDB maps SQL INTEGER to INT8 and its PostgreSQL wire driver returns
  // those values as decimal strings, while PostgreSQL returns JavaScript
  // numbers. Normalize the ledger boundary so resumption uses the same keys.
  const result = await client.query<Omit<SchemaMigrationStepRecord, "step_index"> & { step_index: number | string }>(
    `SELECT migration_id, variant, step_index, checksum, applied_at, applied_by
     FROM public.schema_migration_steps
     WHERE migration_id = $1 AND variant = $2
     ORDER BY step_index`,
    [migrationId, variant],
  );
  return result.rows.map((record) => {
    const stepIndex = Number(record.step_index);
    if (!Number.isSafeInteger(stepIndex) || stepIndex < 0) {
      throw new Error(`Migration ${migrationId} has an invalid recorded step index`);
    }
    return { ...record, step_index: stepIndex };
  });
}

export async function writeMigrationRecord(
  client: Client,
  migration: MigrationDefinition,
  status: MigrationStatus,
  appliedBy: string,
  evidence: Record<string, unknown>,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO public.schema_migrations AS ledger (id, variant, checksum, status, applied_at, applied_by, evidence)
     VALUES ($1, $2, $3, $4, now(), $5, $6::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       variant = EXCLUDED.variant,
       checksum = EXCLUDED.checksum,
       status = EXCLUDED.status,
       applied_at = EXCLUDED.applied_at,
       applied_by = EXCLUDED.applied_by,
       evidence = EXCLUDED.evidence
     WHERE ledger.status = 'deferred'`,
    [migration.id, migration.variant, migration.checksum, status, appliedBy, JSON.stringify(evidence)],
  );
  if (result.rowCount !== 1) {
    throw new Error(`Refusing to replace an existing non-deferred migration record: ${migration.id}`);
  }
}

export async function writeMigrationStepRecord(
  client: Client,
  migration: MigrationDefinition,
  stepIndex: number,
  appliedBy: string,
): Promise<void> {
  await client.query(
    `INSERT INTO public.schema_migration_steps (migration_id, variant, step_index, checksum, applied_at, applied_by)
     VALUES ($1, $2, $3, $4, now(), $5)`,
    [migration.id, migration.variant, stepIndex, statementChecksum(migration.statements[stepIndex]), appliedBy],
  );
}

export const migrationLedgerAccess: MigrationLedgerAccess = {
  ensureSchema: createMigrationLedger,
  listMigrations: listMigrationRecords,
  listSteps: listMigrationStepRecords,
  writeMigration: writeMigrationRecord,
  writeStep: writeMigrationStepRecord,
};

export const migrationCatalogAccess: MigrationCatalogAccess = {
  inspect: inspectMigrationCatalog,
};

export const migrationAdoptionSupport: MigrationAdoptionSupport = {
  ledger: migrationLedgerAccess,
  catalog: migrationCatalogAccess,
};
