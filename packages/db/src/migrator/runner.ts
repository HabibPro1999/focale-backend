import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import {
  defaultMigrationsDirectory,
  loadMigrations,
  statementChecksum,
  type DatabaseEngine,
  type MigrationDefinition,
} from "./migration";
import { deriveCatalogProbes, deriveEffectiveCatalogProbes, inspectCatalogProbes } from "./catalog";
import {
  assertAdoptionRequiredIfNonEmpty,
  createMigrationLedger,
  listMigrationRecords,
  listMigrationStepRecords,
  migrationLedgerExists,
  writeMigrationRecord,
  writeMigrationStepRecord,
} from "./ledger";
import {
  acquireMigrationLease,
  assertLeaseAlive,
  refreshLease,
  releaseMigrationLease,
  runLeaseFencedTransaction,
  startLeaseHeartbeat,
  type LeaseHeartbeat,
} from "./lease";
import {
  evaluateSafeCondition,
  mayDeferRequirement,
  missingRelationFrom,
  pendingMigrationCreatingRelation,
  unmetRequirement,
} from "./preconditions";
import { databaseEngine, normalizeAppliedBy, setUtcSession } from "./session";
import type {
  ApplyMigrationsOptions,
  ApplyMigrationsResult,
  SchemaMigrationRecord,
  VerifyMigrationsResult,
} from "./types";

/** Preserve the runner entry point for existing direct imports. */
export {
  detectDatabaseEngine,
  normalizeAppliedBy,
  databaseEngine,
  setUtcSession,
} from "./session";
export {
  schemaHasApplicationObjects,
  migrationLedgerExists,
  createMigrationLedger,
  assertAdoptionRequiredIfNonEmpty,
  listMigrationRecords,
  listMigrationStepRecords,
  writeMigrationRecord,
  writeMigrationStepRecord,
  migrationLedgerAccess,
  migrationCatalogAccess,
  migrationAdoptionSupport,
} from "./ledger";
export {
  acquireMigrationLease,
  refreshMigrationLease,
  releaseMigrationLease,
  type LeaseHeartbeat,
  startLeaseHeartbeat,
  assertLeaseAlive,
  commitWithLeaseFence,
  LEASE_FENCED_TRANSACTION_ATTEMPTS,
  runLeaseFencedTransaction,
} from "./lease";
export {
  type ApplyMigrationsOptions,
  type ApplyMigrationsResult,
  type VerifyMigrationsResult,
} from "./types";

async function writeDeferredMigrationRecordWithLeaseFence(
  client: Client,
  migration: MigrationDefinition,
  appliedBy: string,
  evidence: Record<string, unknown>,
  owner: string,
  heartbeat?: LeaseHeartbeat,
): Promise<void> {
  await runLeaseFencedTransaction(client, owner, heartbeat, async () => {
    await assertLeaseAlive(client, owner, heartbeat);
    await writeMigrationRecord(client, migration, "deferred", appliedBy, evidence);
  });
}

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
  // The statement commits with its step record, so a retry re-runs only work that was rolled back.
  await runLeaseFencedTransaction(client, owner, heartbeat, async () => {
    await assertLeaseAlive(client, owner, heartbeat);
    await client.query(migration.statements[stepIndex]);
    await assertLeaseAlive(client, owner, heartbeat);
    await writeMigrationStepRecord(client, migration, stepIndex, appliedBy);
  });
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
    // The whole file commits in one transaction, so a retry re-runs only work that was rolled back.
    await runLeaseFencedTransaction(client, owner, heartbeat, async () => {
      for (const [stepIndex, statement] of migration.statements.entries()) {
        await assertLeaseAlive(client, owner, heartbeat);
        await client.query(statement);
        await assertLeaseAlive(client, owner, heartbeat);
        await writeMigrationStepRecord(client, migration, stepIndex, appliedBy);
      }
      await writeMigrationRecord(client, migration, "applied", appliedBy, {});
    });
    return;
  }

  for (const [stepIndex, statement] of migration.statements.entries()) {
    if (previousSteps.has(stepIndex)) continue;
    if (migration.directives.transaction === "per-statement") {
      await executeStatement(client, migration, stepIndex, appliedBy, owner, heartbeat);
    } else {
      await refreshLease(client, owner, heartbeat);
      await client.query(statement);
      await assertLeaseAlive(client, owner, heartbeat);
      // The statement has committed on its own; only its step record is retried.
      await runLeaseFencedTransaction(client, owner, heartbeat, async () => {
        await writeMigrationStepRecord(client, migration, stepIndex, appliedBy);
      });
    }
  }
  await refreshLease(client, owner, heartbeat);
  await runLeaseFencedTransaction(client, owner, heartbeat, async () => {
    await writeMigrationRecord(client, migration, "applied", appliedBy, {});
  });
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
    const unknownPreconditions: string[] = [];
    for (const [index, migration] of selected.entries()) {
      const record = byId.get(migration.id);
      if (record) assertExistingRecord(record, migration);
      if (record?.status === "applied" || record?.status === "baseline") {
        skipped.push(migration.id);
        continue;
      }
      if (record?.status === "deferred") {
        deferred.push(migration.id);
        continue;
      }
      if (migration.directives.deferUnless) {
        let safe: boolean;
        try {
          safe = await evaluateSafeCondition(client, migration.directives.deferUnless);
        } catch (error) {
          const missingRelation = missingRelationFrom(error);
          const prerequisite = missingRelation
            ? pendingMigrationCreatingRelation(missingRelation, selected.slice(0, index), byId)
            : undefined;
          if (!prerequisite) throw error;
          unknownPreconditions.push(`${migration.id} (${missingRelation} will be created by pending ${prerequisite.id})`);
          continue;
        }
        if (!safe) {
          if (!migration.directives.deferrable) {
            throw new Error(`Migration ${migration.id} precondition is false and it is not deferrable`);
          }
          deferred.push(migration.id);
          continue;
        }
      }
      const requirementFailure = await unmetRequirement(client, engine, migration);
      if (requirementFailure && mayDeferRequirement(engine, migration, options)) deferred.push(migration.id);
      else if (requirementFailure) throw new Error(requirementFailure);
      else applied.push(migration.id);
    }
    return { engine, applied, deferred, skipped, unknownPreconditions };
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
          await writeDeferredMigrationRecordWithLeaseFence(client, migration, appliedBy, {
            reason: "defer-unless precondition returned false",
            condition: migration.directives.deferUnless,
          }, owner, heartbeat);
          deferred.push(migration.id);
          continue;
        }
      }

      const requirementFailure = await unmetRequirement(client, engine, migration);
      if (requirementFailure) {
        if (!mayDeferRequirement(engine, migration, options)) throw new Error(requirementFailure);
        await writeDeferredMigrationRecordWithLeaseFence(client, migration, appliedBy, {
          reason: requirementFailure,
        }, owner, heartbeat);
        deferred.push(migration.id);
        continue;
      }
      const steps = await assertStepHistory(client, migration);
      await executeMigration(client, migration, appliedBy, owner, steps, heartbeat);
      applied.push(migration.id);
    }
  } finally {
    await heartbeat?.close().catch(() => undefined);
    await releaseMigrationLease(client, owner).catch(() => undefined);
  }
  return { engine, applied, deferred, skipped, unknownPreconditions: [] };
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
  const effectiveCatalogProbes = options.schema
    ? deriveEffectiveCatalogProbes(migrations.filter((migration) => {
        const status = byId.get(migration.id)?.status;
        return status === "applied" || status === "baseline";
      }))
    : new Map();

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
      const probes = effectiveCatalogProbes.get(migration.id) ?? [];
      if (probes.length) {
        const catalog = await inspectCatalogProbes(client, engine, migration, probes);
        if (catalog.state === "partial" || catalog.state === "none") {
          errors.push(`Migration ${migration.id} final schema probes passed ${catalog.matched}/${catalog.total}`);
        }
      } else if (deriveCatalogProbes(migration).length === 0) {
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
