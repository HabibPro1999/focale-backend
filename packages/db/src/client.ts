import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { resolveDbRuntimeSettings, type DbRuntimeSettings } from "@app/contracts";
import { createLogger } from "@app/shared";
import {
  DEFAULT_DB_APPLICATION_NAME,
  assertApplicationName,
  buildPoolConfig,
} from "./connection-config";

// Pin the session to UTC. Our timestamp columns are `without time zone`
// holding naive-UTC wall time (helpers.ts): drizzle writes via toISOString
// (always UTC wall), so DEFAULT now() must match. On a non-UTC DB server,
// coercing now() (timestamptz) into a naive column uses the session TimeZone
// — pinning UTC keeps now() rows and $defaultFn rows on the same clock.
// (Reads: the drizzle ORM path parses naive timestamps as UTC; the raw
// db.execute path returns them as unparsed strings, so any time math on
// db.execute results is done in SQL — see the *Health fns. Proven in
// timezone.db.test.ts.) connection-config.ts makes the pin impossible to
// override from DATABASE_URL.

const log = createLogger({ name: "db:pool" });

let applicationName = DEFAULT_DB_APPLICATION_NAME;
let settings: DbRuntimeSettings | undefined;
let pool: Pool | undefined;
let db: ReturnType<typeof drizzle> | undefined;
let closing: Promise<void> | undefined;

/**
 * Name this process's database sessions (`application_name`). Call once at
 * startup, before the first query; the default is `focale`.
 */
export function configureDb(options: { applicationName: string }): void {
  const name = assertApplicationName(options.applicationName);
  if (pool && name !== applicationName) {
    throw new Error("configureDb must run before the database pool is first used");
  }
  applicationName = name;
}

/** Validated DB_* settings (pool size, timeouts) for this process. */
export function getDbSettings(): DbRuntimeSettings {
  settings ??= resolveDbRuntimeSettings(process.env);
  return settings;
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

/**
 * Pool 'error' fires for idle clients; pg-pool removes its listener while a
 * client is checked out, so a server-side termination then (for example the
 * idle-in-transaction timeout) would be an unhandled 'error' event and crash
 * the process. Every client therefore keeps its own listener. The failed
 * client is discarded; the caller sees its query or transaction fail.
 */
export function attachPoolErrorHandlers(
  target: Pool,
  logger: { error: (details: object, message: string) => void } = log,
): void {
  // An idle client's error reaches both listeners; log it once.
  const reported = new WeakSet<object>();
  const report = (error: unknown) => {
    if (typeof error === "object" && error !== null) {
      if (reported.has(error)) return;
      reported.add(error);
    }
    logger.error({ err: error }, "Database connection error; client discarded");
  };
  target.on("error", report);
  target.on("connect", (client) => {
    client.on("error", report);
  });
}

function getPool(): Pool {
  if (!pool) {
    const created = new Pool(
      buildPoolConfig(databaseUrl(), getDbSettings(), applicationName),
    );
    attachPoolErrorHandlers(created);
    pool = created;
  }
  return pool;
}

/** Lazy singleton drizzle client. Throws if DATABASE_URL unset. */
export function getDb() {
  if (!db) {
    db = drizzle(getPool(), { casing: "snake_case" });
  }
  return db;
}

export type Db = ReturnType<typeof getDb>;
/** A db handle or an open transaction — helpers ride the caller's txn. */
export type DbExecutor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * End the pool and forget the singletons. Idempotent: concurrent callers share
 * one close, and a later getDb() builds a fresh pool.
 */
export function closeDb(): Promise<void> {
  settings = undefined;
  if (pool) {
    const current = pool;
    pool = undefined;
    db = undefined;
    const ending: Promise<void> = current.end().finally(() => {
      if (closing === ending) closing = undefined;
    });
    closing = ending;
  }
  return closing ?? Promise.resolve();
}

/** Bounded readiness check. Returns false on timeout/error; never throws. */
export async function pingDb(timeoutMs = 2000): Promise<boolean> {
  let client: PoolClient | undefined;
  let timer: NodeJS.Timeout | undefined;
  // Destroy (not recycle) a client whose ping failed or may still be running.
  let discard: Error | boolean = false;
  try {
    client = await getPool().connect();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        discard = true;
        reject(new Error("pingDb timeout"));
      }, timeoutMs);
    });
    await Promise.race([client.query("select 1"), timeout]);
    return true;
  } catch (error) {
    if (discard === false) discard = error instanceof Error ? error : true;
    return false;
  } finally {
    clearTimeout(timer);
    client?.release(discard);
  }
}
