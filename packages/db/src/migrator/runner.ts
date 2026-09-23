import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { defaultMigrationsDirectory, loadMigrations } from "./migration";
import { inspectMigrationCatalog } from "./catalog";
import type { DatabaseEngine, MigrationDefinition, MigrationVariant } from "./migration";
import { statementChecksum } from "./migration";
import type {
  MigrationAdoptionSupport,
  MigrationCatalogAccess,
  MigrationLedgerAccess,
  MigrationStatus,
  SchemaMigrationRecord,
  SchemaMigrationStepRecord,
} from "./types";

const LEASE_TTL_SECONDS = 90;
const LEASE_WAIT_MS = 2 * 60 * 1000;

export interface ApplyMigrationsOptions {
  through?: string;
  applyDeferred?: string;
  appliedBy?: string;
  dryRun?: boolean;
  /** The CLI passes this so another service process can refresh the lease. */
  leaseConnectionString?: string;
}

export interface ApplyMigrationsResult {
  engine: DatabaseEngine;
  applied: string[];
  deferred: string[];
  skipped: string[];
}

export interface VerifyMigrationsResult {
  engine: DatabaseEngine;
  errors: string[];
  warnings: string[];
}

export function detectDatabaseEngine(version: string): DatabaseEngine {
  return /CockroachDB/i.test(version) ? "cockroach" : "postgres";
}

export function normalizeAppliedBy(value?: string): string {
  const candidate = value?.trim();
  if (candidate && /^[a-zA-Z0-9._:-]{1,128}$/.test(candidate)) return candidate;
  return "migrator-cli";
}

export async function databaseEngine(client: Client): Promise<DatabaseEngine> {
  const result = await client.query<{ version: string }>("SELECT version() AS version");
  return detectDatabaseEngine(result.rows[0]?.version ?? "");
}

export async function setUtcSession(client: Client): Promise<void> {
  await client.query("SET TIME ZONE 'UTC'");
}

async function tableExists(client: Client, name: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS present`,
    [name],
  );
  return Boolean(result.rows[0]?.present);
}

async function schemaHasApplicationObjects(client: Client): Promise<boolean> {
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
  const result = await client.query<SchemaMigrationStepRecord>(
    `SELECT migration_id, variant, step_index, checksum, applied_at, applied_by
     FROM public.schema_migration_steps
     WHERE migration_id = $1 AND variant = $2
     ORDER BY step_index`,
    [migrationId, variant],
  );
  return result.rows;
}

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "40001";
}

async function waitForLeaseRetry(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function acquireMigrationLease(client: Client, owner: string): Promise<void> {
  const deadline = Date.now() + LEASE_WAIT_MS;
  let pauseMs = 200;
  while (Date.now() < deadline) {
    try {
      await client.query(
        `UPDATE public.schema_migration_lock
         SET owner = $1, lease_until = now() + interval '${LEASE_TTL_SECONDS} seconds'
         WHERE id = 1 AND (owner IS NULL OR lease_until < now() OR owner = $1)`,
        [owner],
      );
      const result = await client.query<{ owner: string }>(
        "SELECT owner FROM public.schema_migration_lock WHERE id = 1",
      );
      if (result.rows[0]?.owner === owner) return;
    } catch (error) {
      if (!isSerializationFailure(error)) throw error;
    }
    await waitForLeaseRetry(pauseMs);
    pauseMs = Math.min(2000, Math.ceil(pauseMs * 1.5));
  }
  throw new Error("Timed out waiting for the migration lease; another migrator may still be running");
}

export async function refreshMigrationLease(client: Client, owner: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const result = await client.query(
        `UPDATE public.schema_migration_lock
         SET lease_until = now() + interval '${LEASE_TTL_SECONDS} seconds'
         WHERE id = 1 AND owner = $1`,
        [owner],
      );
      if (result.rowCount !== 1) throw new Error("Migration lease was lost; stopping before the next SQL statement");
      return;
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === 3) throw error;
      await waitForLeaseRetry((attempt + 1) * 50);
    }
  }
}

export async function releaseMigrationLease(client: Client, owner: string): Promise<void> {
  await client.query(
    "UPDATE public.schema_migration_lock SET owner = NULL, lease_until = NULL WHERE id = 1 AND owner = $1",
    [owner],
  );
}

interface LeaseHeartbeat {
  assertAlive(): void;
  close(): Promise<void>;
}

async function startLeaseHeartbeat(connectionString: string, owner: string): Promise<LeaseHeartbeat> {
  const keeper = new Client({ connectionString, application_name: "focale-migration-lease" });
  await keeper.connect();
  let stopped = false;
  let failure: Error | undefined;
  let timer: NodeJS.Timeout;
  const intervalMs = Math.floor((LEASE_TTL_SECONDS * 1000) / 3);
  const beat = async (): Promise<void> => {
    if (stopped) return;
    try {
      await refreshMigrationLease(keeper, owner);
      failure = undefined;
    } catch (error) {
      failure = error instanceof Error ? error : new Error("Migration lease renewal failed");
    }
    if (!stopped) {
      timer = setTimeout(() => void beat(), failure ? 5000 : intervalMs);
      timer.unref();
    }
  };
  timer = setTimeout(() => void beat(), intervalMs);
  timer.unref();
  return {
    assertAlive() {
      if (failure) throw new Error(`Migration lease renewal failed: ${failure.message}`);
    },
    async close() {
      stopped = true;
      clearTimeout(timer);
      await keeper.end();
    },
  };
}

async function refreshLease(
  client: Client,
  owner: string,
  heartbeat?: LeaseHeartbeat,
): Promise<void> {
  heartbeat?.assertAlive();
  await refreshMigrationLease(client, owner);
}

async function unmetRequirement(
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

  if (engine === "cockroach" && migration.statements.some((statement) => /^\s*CREATE\s+VECTOR\s+INDEX\b/i.test(statement))) {
    const result = await client.query("SHOW CLUSTER SETTING feature.vector_index.enabled");
    const value = Object.values(result.rows[0] ?? {}).some((entry) => entry === true || entry === "true" || entry === "on");
    if (!value) return "CockroachDB vector indexes require feature.vector_index.enabled; ask the database administrator to enable it";
  }
  return undefined;
}

function mayDeferRequirement(engine: DatabaseEngine, migration: MigrationDefinition, options: ApplyMigrationsOptions): boolean {
  return engine === "cockroach" && migration.directives.deferrable && options.applyDeferred !== migration.id;
}

async function evaluateSafeCondition(client: Client, sql: string): Promise<boolean> {
  const result = await client.query(sql);
  if (!result.rows.length) return false;
  const firstRow = result.rows[0] as Record<string, unknown>;
  const firstValue = firstRow[Object.keys(firstRow)[0] ?? ""];
  return firstValue === true || firstValue === "true" || firstValue === 1;
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

async function assertStepHistory(client: Client, migration: MigrationDefinition): Promise<Map<number, string>> {
  const records = await listMigrationStepRecords(client, migration.id, migration.variant);
  const byStep = new Map<number, string>();
  for (const record of records) {
    const expected = migration.statements[record.step_index];
    if (!expected) throw new Error(`Migration ${migration.id} has an unknown recorded step ${record.step_index}`);
    const checksum = statementChecksum(expected);
    if (checksum !== record.checksum) {
      throw new Error(`Previously applied migration step changed: ${migration.id}:step:${record.step_index}`);
    }
    byStep.set(record.step_index, record.checksum);
  }
  return byStep;
}

async function executeStatement(
  client: Client,
  migration: MigrationDefinition,
  stepIndex: number,
  appliedBy: string,
  owner: string,
  heartbeat?: LeaseHeartbeat,
): Promise<void> {
  await refreshLease(client, owner, heartbeat);
  await client.query("BEGIN");
  try {
    await client.query(migration.statements[stepIndex]);
    await writeMigrationStepRecord(client, migration, stepIndex, appliedBy);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function executeMigration(
  client: Client,
  migration: MigrationDefinition,
  appliedBy: string,
  owner: string,
  previousSteps: Map<number, string>,
  heartbeat?: LeaseHeartbeat,
): Promise<void> {
  if (migration.directives.transaction === "per-file") {
    if (previousSteps.size) {
      throw new Error(`Migration ${migration.id} uses per-file transactions but has incomplete step history`);
    }
    await refreshLease(client, owner, heartbeat);
    await client.query("BEGIN");
    try {
      for (const [stepIndex, statement] of migration.statements.entries()) {
        await client.query(statement);
        await writeMigrationStepRecord(client, migration, stepIndex, appliedBy);
      }
      await writeMigrationRecord(client, migration, "applied", appliedBy, {});
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    return;
  }

  for (const [stepIndex, statement] of migration.statements.entries()) {
    if (previousSteps.has(stepIndex)) continue;
    if (migration.directives.transaction === "per-statement") {
      await executeStatement(client, migration, stepIndex, appliedBy, owner, heartbeat);
    } else {
      await refreshLease(client, owner, heartbeat);
      await client.query(statement);
      await writeMigrationStepRecord(client, migration, stepIndex, appliedBy);
    }
  }
  await refreshLease(client, owner, heartbeat);
  await writeMigrationRecord(client, migration, "applied", appliedBy, {});
}

function assertExistingRecord(record: SchemaMigrationRecord, migration: MigrationDefinition): void {
  if (record.variant !== migration.variant || record.checksum !== migration.checksum) {
    throw new Error(`Previously applied migration changed: ${migration.id}`);
  }
}

export async function applyMigrations(
  client: Client,
  migrations: MigrationDefinition[],
  options: ApplyMigrationsOptions = {},
): Promise<ApplyMigrationsResult> {
  await setUtcSession(client);
  const engine = await databaseEngine(client);
  const appliedBy = normalizeAppliedBy(options.appliedBy ?? process.env.MIGRATIONS_APPLIED_BY ?? process.env.RENDER_SERVICE_NAME);
  const selected = options.through ? migrations.filter((migration) => migration.id <= options.through!) : migrations;
  if (options.applyDeferred && !/^\d{4}$/.test(options.applyDeferred)) {
    throw new Error("Use --apply-deferred=NNNN");
  }

  const records = await listMigrationRecords(client);
  const byId = new Map(records.map((record) => [record.id, record]));
  const knownIds = new Set(migrations.map((migration) => migration.id));
  const unknownRecords = records.filter((record) => !knownIds.has(record.id));
  if (unknownRecords.length) {
    throw new Error(`Database contains migration ${unknownRecords[0].id} unknown to this runner; refusing to apply`);
  }
  if (options.applyDeferred) {
    const target = selected.find((migration) => migration.id === options.applyDeferred);
    if (!target) throw new Error(`Deferred migration ${options.applyDeferred} is not in the selected plan`);
    if (byId.get(options.applyDeferred)?.status !== "deferred") {
      throw new Error(`Migration ${options.applyDeferred} is not recorded as deferred`);
    }
  }
  const applied: string[] = [];
  const deferred: string[] = [];
  const skipped: string[] = [];

  if (options.dryRun) {
    await assertAdoptionRequiredIfNonEmpty(client);
    for (const migration of selected) {
      const record = byId.get(migration.id);
      if (record) assertExistingRecord(record, migration);
      if (record?.status === "applied" || record?.status === "baseline") skipped.push(migration.id);
      else if (record?.status === "deferred") deferred.push(migration.id);
      else if (migration.directives.deferUnless && !(await evaluateSafeCondition(client, migration.directives.deferUnless))) {
        if (!migration.directives.deferrable) {
          throw new Error(`Migration ${migration.id} precondition is false and it is not deferrable`);
        }
        deferred.push(migration.id);
      } else {
        const requirementFailure = await unmetRequirement(client, engine, migration);
        if (requirementFailure && mayDeferRequirement(engine, migration, options)) deferred.push(migration.id);
        else if (requirementFailure) throw new Error(requirementFailure);
        else applied.push(migration.id);
      }
    }
    return { engine, applied, deferred, skipped };
  }

  await assertAdoptionRequiredIfNonEmpty(client);
  await createMigrationLedger(client);
  const owner = `migrator:${process.pid}:${randomUUID()}`;
  await acquireMigrationLease(client, owner);
  let heartbeat: LeaseHeartbeat | undefined;
  try {
    if (options.leaseConnectionString) {
      heartbeat = await startLeaseHeartbeat(options.leaseConnectionString, owner);
    }
    const latestRecords = await listMigrationRecords(client);
    const latestById = new Map(latestRecords.map((record) => [record.id, record]));
    const latestUnknown = latestRecords.find((record) => !knownIds.has(record.id));
    if (latestUnknown) {
      throw new Error(`Database contains migration ${latestUnknown.id} unknown to this runner; refusing to apply`);
    }
    for (const migration of selected) {
      const previous = latestById.get(migration.id);
      if (previous) assertExistingRecord(previous, migration);
      if (previous?.status === "applied" || previous?.status === "baseline") {
        skipped.push(migration.id);
        continue;
      }

      if (previous?.status === "deferred" && options.applyDeferred !== migration.id) {
        deferred.push(migration.id);
        continue;
      }

      if (migration.directives.deferUnless && options.applyDeferred !== migration.id) {
        const safe = await evaluateSafeCondition(client, migration.directives.deferUnless);
        if (!safe) {
          if (!migration.directives.deferrable) {
            throw new Error(`Migration ${migration.id} precondition is false and it is not deferrable`);
          }
          await writeMigrationRecord(client, migration, "deferred", appliedBy, {
            reason: "defer-unless precondition returned false",
            condition: migration.directives.deferUnless,
          });
          deferred.push(migration.id);
          latestById.set(migration.id, {
            id: migration.id,
            variant: migration.variant,
            checksum: migration.checksum,
            status: "deferred",
            applied_at: new Date(),
            applied_by: appliedBy,
            evidence: { reason: "defer-unless precondition returned false" },
          });
          continue;
        }
      }

      const requirementFailure = await unmetRequirement(client, engine, migration);
      if (requirementFailure) {
        if (!mayDeferRequirement(engine, migration, options)) throw new Error(requirementFailure);
        await writeMigrationRecord(client, migration, "deferred", appliedBy, {
          reason: requirementFailure,
        });
        deferred.push(migration.id);
        latestById.set(migration.id, {
          id: migration.id,
          variant: migration.variant,
          checksum: migration.checksum,
          status: "deferred",
          applied_at: new Date(),
          applied_by: appliedBy,
          evidence: { reason: requirementFailure },
        });
        continue;
      }
      const steps = await assertStepHistory(client, migration);
      await executeMigration(client, migration, appliedBy, owner, steps, heartbeat);
      applied.push(migration.id);
      latestById.set(migration.id, {
        id: migration.id,
        variant: migration.variant,
        checksum: migration.checksum,
        status: "applied",
        applied_at: new Date(),
        applied_by: appliedBy,
        evidence: {},
      });
    }
  } finally {
    await heartbeat?.close().catch(() => undefined);
    await releaseMigrationLease(client, owner).catch(() => undefined);
  }
  return { engine, applied, deferred, skipped };
}

/** Engine-aware entry point for the disposable-database helper in plan item 1.3. */
export async function applyMigrationsForEngine(
  client: Client,
  engine: DatabaseEngine,
  options: ApplyMigrationsOptions = {},
): Promise<ApplyMigrationsResult> {
  const actualEngine = await databaseEngine(client);
  if (actualEngine !== engine) {
    throw new Error(`Requested ${engine} migrations for a ${actualEngine} database`);
  }
  const migrations = await loadMigrations(defaultMigrationsDirectory(), engine);
  return applyMigrations(client, migrations, options);
}

export async function verifyMigrations(
  client: Client,
  engine: DatabaseEngine,
  migrations: MigrationDefinition[],
  options: { schema?: boolean } = {},
): Promise<VerifyMigrationsResult> {
  await setUtcSession(client);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!(await migrationLedgerExists(client))) {
    return { engine, errors: ["Migration ledger is missing; run migrate adopt for an existing database or apply on an empty database"], warnings };
  }
  const records = await listMigrationRecords(client);
  const byId = new Map(records.map((record) => [record.id, record]));
  const knownIds = new Set(migrations.map((migration) => migration.id));

  for (const migration of migrations) {
    const record = byId.get(migration.id);
    if (!record) {
      errors.push(`Migration ${migration.id} is pending`);
      continue;
    }
    if (record.variant !== migration.variant || record.checksum !== migration.checksum) {
      errors.push(`Migration ${migration.id} ledger does not match the current ${migration.variant} file`);
      continue;
    }
    if (record.status === "deferred") {
      warnings.push(`Migration ${migration.id} is deferred`);
      continue;
    }
    if (options.schema) {
      const catalog = await inspectMigrationCatalog(client, engine, migration);
      if (catalog.state === "partial" || catalog.state === "none") {
        errors.push(`Migration ${migration.id} schema probes passed ${catalog.matched}/${catalog.total}`);
      } else if (catalog.state === "unverifiable") {
        warnings.push(`Migration ${migration.id} has no catalog probes`);
      }
    }
  }
  for (const record of records) {
    if (!knownIds.has(record.id)) warnings.push(`Database has migration ${record.id} unknown to this runner`);
  }

  const timezone = await client.query("SHOW TIME ZONE");
  const zone = Object.values(timezone.rows[0] ?? {})[0];
  if (typeof zone === "string" && zone.toUpperCase() !== "UTC") errors.push(`Session time zone is ${zone}, expected UTC`);
  return { engine, errors, warnings };
}
