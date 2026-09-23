#!/usr/bin/env node
/* eslint no-console: "off" */
import { readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { lintMigrationDirectory, loadMigrations } from "./migration";
import { redactCredentials } from "./security";
import {
  applyDeferredOption,
  parseArguments,
  requireKnownOptions,
  requireNoPositionals,
  requirePositionalCount,
  throughOption,
} from "./cli-arguments";
import {
  applyMigrations,
  databaseEngine,
  listMigrationRecords,
  migrationLedgerExists,
  normalizeAppliedBy,
  setUtcSession,
  verifyMigrations,
} from "./runner";

const MIGRATIONS_DIRECTORY = resolve(__dirname, "../../migrations");

import type { Arguments } from "./cli-arguments";

function databaseConnectionString(): string {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for this command");
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL is not a valid PostgreSQL connection URL");
  }
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  }
  return parsed.toString();
}

function printMigrationLine(migration: Awaited<ReturnType<typeof loadMigrations>>[number]): void {
  const flags = [
    migration.directives.idempotent ? "idempotent" : undefined,
    migration.directives.requiresExtensions.length
      ? `requires ${migration.directives.requiresExtensions.join(",")}`
      : undefined,
    migration.directives.deferrable ? "deferrable" : undefined,
  ].filter(Boolean);
  console.log(
    `  ${migration.id} ${migration.name} [${migration.variant}; ${migration.directives.transaction}${flags.length ? `; ${flags.join("; ")}` : ""}]`,
  );
}

async function plan(through?: string): Promise<void> {
  const errors = await lintMigrationDirectory(MIGRATIONS_DIRECTORY);
  if (errors.length) {
    console.error("Migration plan failed:");
    for (const error of errors) console.error(`  ${error}`);
    process.exitCode = 1;
    return;
  }

  const postgres = await loadMigrations(MIGRATIONS_DIRECTORY, "postgres", { through });
  const cockroach = await loadMigrations(MIGRATIONS_DIRECTORY, "cockroach", { through });
  console.log("Migration plan (no database changes):");
  console.log("PostgreSQL:");
  for (const migration of postgres) printMigrationLine(migration);
  console.log("CockroachDB overrides or engine-only migrations:");
  for (const migration of cockroach) {
    const postgresVariant = postgres.find((candidate) => candidate.id === migration.id);
    if (migration.variant === "cockroach") {
      printMigrationLine(migration);
    } else if (!postgresVariant) {
      printMigrationLine(migration);
    }
  }
}

async function withDatabase<T>(operation: (client: Client, connectionString: string) => Promise<T>): Promise<T> {
  const connectionString = databaseConnectionString();
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await operation(client, connectionString);
  } finally {
    await client.end();
  }
}

async function status(): Promise<void> {
  await withDatabase(async (client) => {
    await setUtcSession(client);
    const engine = await databaseEngine(client);
    const migrations = await loadMigrations(MIGRATIONS_DIRECTORY, engine);
    if (!(await migrationLedgerExists(client))) {
      console.log(`Migration status (${engine}): ledger missing; run adopt for an existing database or apply on an empty database.`);
      return;
    }
    const records = await listMigrationRecords(client);
    const byId = new Map(records.map((record) => [record.id, record]));
    console.log(`Migration status (${engine}):`);
    for (const migration of migrations) {
      const record = byId.get(migration.id);
      const state = record?.status ?? "pending";
      console.log(`  ${migration.id} ${state}${record ? ` (${record.variant})` : ""}`);
    }
    for (const record of records) {
      if (!migrations.some((migration) => migration.id === record.id)) {
        console.log(`  ${record.id} ${record.status} (${record.variant}; unknown to this runner)`);
      }
    }
  });
}

async function apply(args: Arguments, dryRun: boolean): Promise<void> {
  const through = throughOption(args);
  const applyDeferred = applyDeferredOption(args);
  if (!dryRun && !args.flags.has("--yes")) throw new Error("Apply requires explicit confirmation: pass --yes");
  if (dryRun && args.values.has("--apply-deferred")) throw new Error("--apply-deferred cannot be combined with --dry-run");
  if (applyDeferred && !args.flags.has("--yes")) throw new Error("Applying a deferred migration requires explicit confirmation: pass --yes");

  await withDatabase(async (client, connectionString) => {
    const engine = await databaseEngine(client);
    const migrations = await loadMigrations(MIGRATIONS_DIRECTORY, engine);
    const result = await applyMigrations(client, migrations, {
      through,
      applyDeferred,
      appliedBy: normalizeAppliedBy(process.env.MIGRATIONS_APPLIED_BY ?? process.env.RENDER_SERVICE_NAME),
      dryRun,
      leaseConnectionString: connectionString,
    });
    const verb = dryRun ? "Would apply" : "Applied";
    console.log(`${verb} on ${result.engine}: ${result.applied.length ? result.applied.join(", ") : "none"}`);
    if (result.deferred.length) console.log(`Deferred: ${result.deferred.join(", ")}`);
    if (result.unknownPreconditions.length) console.log(`Preconditions unknown until earlier migrations apply: ${result.unknownPreconditions.join(", ")}`);
    if (result.skipped.length) console.log(`Already applied: ${result.skipped.join(", ")}`);
  });
}

async function verify(args: Arguments): Promise<void> {
  const through = throughOption(args);
  await withDatabase(async (client) => {
    const engine = await databaseEngine(client);
    const migrations = await loadMigrations(MIGRATIONS_DIRECTORY, engine, { through });
    const result = await verifyMigrations(client, engine, migrations, { schema: args.flags.has("--schema") });
    console.log(`Migration verification (${result.engine}):`);
    for (const warning of result.warnings) console.warn(`  warning: ${warning}`);
    for (const error of result.errors) console.error(`  error: ${error}`);
    if (!result.errors.length) console.log("  ledger and requested schema checks passed");
    if (result.errors.length) process.exitCode = 1;
  });
}

async function createMigration(name: string): Promise<void> {
  const slug = name.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(slug)) {
    throw new Error("Migration name must contain lowercase letters, digits, and underscores only");
  }
  const files = await readdir(MIGRATIONS_DIRECTORY, { withFileTypes: true });
  const cockroachDirectory = resolve(MIGRATIONS_DIRECTORY, "cockroach");
  let cockroachFiles: typeof files = [];
  try {
    cockroachFiles = await readdir(cockroachDirectory, { withFileTypes: true });
  } catch {
    // The shared directory alone is enough to select the next migration number.
  }
  const ids = [...files, ...cockroachFiles]
    .filter((entry) => entry.isFile() && /^\d{4}_.+\.sql$/i.test(entry.name))
    .map((entry) => Number(entry.name.slice(0, 4)));
  const next = Math.max(0, ...ids) + 1;
  if (next > 9999) throw new Error("Migration number space is exhausted");
  const filename = `${String(next).padStart(4, "0")}_${slug}.sql`;
  const target = resolve(MIGRATIONS_DIRECTORY, filename);
  await writeFile(target, "-- migrate: transaction per-file\n\n", { flag: "wx" });
  console.log(`Created ${filename}`);
}

async function run(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  switch (args.command) {
    case "plan":
      requireNoPositionals(args, "plan");
      requireKnownOptions(args, [], ["--through"]);
      await plan(throughOption(args));
      return;
    case "status":
      requireNoPositionals(args, "status");
      requireKnownOptions(args, [], []);
      await status();
      return;
    case "apply":
      requireNoPositionals(args, "apply");
      requireKnownOptions(args, ["--yes", "--dry-run"], ["--through", "--apply-deferred"]);
      await apply(args, args.flags.has("--dry-run"));
      return;
    case "adopt":
      requireNoPositionals(args, "adopt");
      requireKnownOptions(args, [], []);
      throw new Error("migrate adopt is intentionally deferred to plan item 1.4; no ledger rows were written");
    case "verify":
      requireNoPositionals(args, "verify");
      requireKnownOptions(args, ["--schema"], ["--through"]);
      await verify(args);
      return;
    case "new":
      requireKnownOptions(args, [], []);
      requirePositionalCount(args, "new", 1);
      await createMigration(args.positional[0]);
      return;
    default:
      throw new Error("Usage: migrator <plan|status|apply|adopt|verify|new> [options]");
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(redactCredentials(message));
  process.exitCode = 1;
});
