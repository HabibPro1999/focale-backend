import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { applyMigrationsForEngine, databaseEngine } from "../migrator";
import type { ApplyMigrationsResult, DatabaseEngine } from "../migrator";
import { assertDisposableDatabaseUrl, loadDbTestAdminUrl } from "./safety";

export interface ScratchDatabaseOptions {
  label: string;
  /** Apply through this four-digit migration ID, inclusive. */
  to?: string;
}

export interface ScratchDatabase {
  name: string;
  url: string;
  engine: DatabaseEngine;
  client: Client;
  applyMigrations(options?: { to?: string }): Promise<ApplyMigrationsResult>;
  disconnect(): Promise<void>;
  close(): Promise<void>;
}

function identifier(name: string): string {
  if (!/^focale_test_[a-z0-9_]{1,48}$/.test(name)) {
    throw new Error("[test-db] Refusing to use an unmanaged scratch database name.");
  }
  return `"${name}"`;
}

function scratchName(label: string): string {
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 18) || "scratch";
  const suffix = `${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  return `focale_test_${suffix.split("_")[0]}_${safeLabel}_${suffix.split("_")[1]}`;
}

function withDatabase(url: URL, name: string): string {
  const copy = new URL(url.toString());
  copy.pathname = `/${name}`;
  return copy.toString();
}

async function openAdmin(adminUrl: string): Promise<{ client: Client; engine: DatabaseEngine }> {
  assertDisposableDatabaseUrl(adminUrl);
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return { client, engine: await databaseEngine(client) };
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

/** Return the configured disposable service's engine without creating a database. */
export async function testDatabaseEngine(): Promise<DatabaseEngine> {
  const { client, engine } = await openAdmin(loadDbTestAdminUrl());
  await client.end();
  return engine;
}

async function provisionVectorExtension(client: Client, engine: DatabaseEngine): Promise<void> {
  // The production migrator only checks extension requirements. Test bootstrap
  // owns this explicit provision step on its newly-created PostgreSQL database.
  if (engine === "postgres") await client.query("CREATE EXTENSION IF NOT EXISTS vector");
}

async function dropScratchDatabase(name: string, adminUrl: string, engine: DatabaseEngine): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    if (engine === "postgres") {
      await admin.query(`DROP DATABASE IF EXISTS ${identifier(name)} WITH (FORCE)`);
    } else {
      await admin.query(`DROP DATABASE IF EXISTS ${identifier(name)} CASCADE`);
    }
  } finally {
    await admin.end();
  }
}

/**
 * Remove stale databases in the helper's reserved namespace after the requested age.
 */
export async function janitorScratchDatabases(options: { olderThanMs?: number } = {}): Promise<string[]> {
  const olderThanMs = options.olderThanMs ?? 24 * 60 * 60 * 1000;
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
    throw new Error("[test-db] Janitor age must be a non-negative number of milliseconds.");
  }
  const adminUrl = loadDbTestAdminUrl();
  const { client: admin, engine } = await openAdmin(adminUrl);
  const adminDatabaseName = decodeURIComponent(assertDisposableDatabaseUrl(adminUrl).pathname.replace(/^\//, ""));
  const stale: string[] = [];
  try {
    const result = engine === "postgres"
      ? await admin.query<{ datname: string }>(
          "SELECT datname FROM pg_database WHERE datistemplate = false",
        )
      : await admin.query<{ database_name: string }>("SHOW DATABASES");
    const names = result.rows.map((row) => "datname" in row ? row.datname : row.database_name);
    const now = Date.now();
    for (const name of names) {
      if (name === adminDatabaseName) continue;
      const match = /^focale_test_([a-z0-9]+)_[a-z0-9_]+_[0-9a-f]{10}$/.exec(name);
      if (!match) continue;
      const createdAt = Number.parseInt(match[1], 36);
      if (!Number.isSafeInteger(createdAt) || now - createdAt < olderThanMs) continue;
      await dropScratchDatabase(name, adminUrl, engine);
      stale.push(name);
    }
  } finally {
    await admin.end();
  }
  return stale;
}

async function connectScratch(
  name: string,
  baseUrl: URL,
  engine: DatabaseEngine,
  adminUrl: string,
  apply: boolean,
  to?: string,
): Promise<ScratchDatabase> {
  const url = withDatabase(baseUrl, name);
  assertDisposableDatabaseUrl(url);
  const client = new Client({ connectionString: url });
  let connected = false;
  let disposed = false;
  try {
    await client.connect();
    connected = true;
    await client.query("SET TIME ZONE 'UTC'");
    if (apply) {
      await provisionVectorExtension(client, engine);
      await applyMigrationsForEngine(client, engine, {
        through: to,
        leaseConnectionString: url,
        appliedBy: "db-test-helper",
      });
    }
  } catch (error) {
    if (connected) await client.end().catch(() => undefined);
    await dropScratchDatabase(name, adminUrl, engine).catch(() => undefined);
    throw error;
  }

  async function disconnect(): Promise<void> {
    if (!connected) return;
    connected = false;
    await client.end();
  }

  async function close(): Promise<void> {
    if (disposed) return;
    disposed = true;
    await disconnect();
    await dropScratchDatabase(name, adminUrl, engine);
  }

  return {
    name,
    url,
    engine,
    client,
    async applyMigrations(options = {}) {
      return applyMigrationsForEngine(client, engine, {
        through: options.to,
        leaseConnectionString: url,
        appliedBy: "db-test-helper",
      });
    },
    disconnect,
    close,
  };
}

/** Create a uniquely named test database, explicitly bootstrap it, and migrate it. */
export async function createScratchDatabase(
  options: ScratchDatabaseOptions,
): Promise<ScratchDatabase> {
  if (options.to && !/^\d{4}$/.test(options.to)) {
    throw new Error("[test-db] `to` must be a four-digit migration ID.");
  }
  const adminUrl = loadDbTestAdminUrl();
  const { client: admin, engine } = await openAdmin(adminUrl);
  const adminParsed = assertDisposableDatabaseUrl(adminUrl);
  const name = scratchName(options.label);
  try {
    await admin.query(`CREATE DATABASE ${identifier(name)}`);
  } finally {
    await admin.end();
  }
  return connectScratch(name, adminParsed, engine, adminUrl, true, options.to);
}

/** Reapply the unified runner to a scratch database; applied migrations are skipped. */
export async function applyMigrations(
  database: ScratchDatabase,
  options: { to?: string } = {},
): Promise<ApplyMigrationsResult> {
  return database.applyMigrations(options);
}

/**
 * Clone the per-run migrated PostgreSQL template. CockroachDB 26.2.5 does not
 * implement CREATE DATABASE ... TEMPLATE, so it gets a fresh migrated DB/file.
 */
export async function createTestDatabase(
  options: { label: string; templateName?: string; engine?: DatabaseEngine },
): Promise<ScratchDatabase> {
  const adminUrl = loadDbTestAdminUrl();
  const { client: admin, engine } = await openAdmin(adminUrl);
  const adminParsed = assertDisposableDatabaseUrl(adminUrl);
  const targetEngine = options.engine ?? engine;
  if (targetEngine !== engine) {
    await admin.end();
    throw new Error("[test-db] Template engine does not match TEST_DB_ADMIN_URL.");
  }
  const name = scratchName(options.label);
  try {
    if (engine === "postgres" && options.templateName) {
      await admin.query(`CREATE DATABASE ${identifier(name)} TEMPLATE ${identifier(options.templateName)}`);
    } else {
      await admin.query(`CREATE DATABASE ${identifier(name)}`);
    }
  } finally {
    await admin.end();
  }
  const cloned = engine === "postgres" && Boolean(options.templateName);
  return connectScratch(name, adminParsed, engine, adminUrl, !cloned);
}
