import type { Client, PoolClient } from "pg";
import { getDb } from "./client";
import {
  databaseEngine,
  defaultMigrationsDirectory,
  loadMigrations,
  redactCredentials,
  verifyMigrations,
} from "./migrator";

export type MigrationsCheckMode = "enforce" | "warn" | "off";

export interface SchemaCheckLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

/** The subset of a checked-out pg client the check needs. */
export type SchemaCheckClient = Pick<PoolClient, "query" | "release">;

export interface SchemaCheckOptions {
  mode: MigrationsCheckMode;
  logger: SchemaCheckLogger;
  /** Bound for connecting plus every check query (default 15 s). */
  timeoutMs?: number;
  /**
   * Session source; defaults to a connection checked out of the application
   * pool, so the time-zone assertion sees exactly what application queries get.
   */
  connect?: () => Promise<SchemaCheckClient>;
}

export interface SchemaInspection {
  /** Pending, checksum-mismatch, missing-ledger, non-UTC or unreachable. */
  errors: string[];
  /** Deferred and newer-unknown migrations. */
  warnings: string[];
}

export interface SchemaCheckResult extends SchemaInspection {
  mode: MigrationsCheckMode;
  skipped: boolean;
}

export class SchemaNotCurrentError extends Error {
  constructor(readonly errors: string[]) {
    super(`Database schema check failed (MIGRATIONS_CHECK=enforce):\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    this.name = "SchemaNotCurrentError";
  }
}

export const DEFAULT_SCHEMA_CHECK_TIMEOUT_MS = 15_000;

function zoneOf(row: Record<string, unknown> | undefined): string {
  return String(Object.values(row ?? {})[0] ?? "");
}

/** The pool pins `TimeZone=UTC`; `Etc/UTC` is the same zone under its tz name. */
function isUtc(zone: string): boolean {
  return /^(?:Etc\/)?UTC$/i.test(zone.trim());
}

/**
 * Read-only inspection of one session: its time zone (before anything changes
 * it), then the unified ledger against the migrations shipped in this build.
 */
export async function inspectSchema(client: SchemaCheckClient): Promise<SchemaInspection> {
  const errors: string[] = [];
  const zone = zoneOf((await client.query("SHOW TIME ZONE")).rows[0]);
  if (!isUtc(zone)) {
    errors.push(`Application database sessions use time zone ${zone || "(unknown)"}, expected UTC`);
  }
  // A checked-out pool client is a pg Client at runtime; the ledger helpers
  // only issue queries. verifyMigrations pins UTC on this session, which is
  // why the caller destroys the connection afterwards.
  const session = client as unknown as Client;
  const engine = await databaseEngine(session);
  const migrations = await loadMigrations(defaultMigrationsDirectory(), engine);
  const verification = await verifyMigrations(session, engine, migrations);
  return { errors: [...errors, ...verification.errors], warnings: verification.warnings };
}

async function inspectWithDeadline(
  connect: () => Promise<SchemaCheckClient>,
  timeoutMs: number,
): Promise<SchemaInspection> {
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  let client: SchemaCheckClient | undefined;
  const work = (async () => {
    const connected = await connect();
    if (timedOut) {
      connected.release(true);
      throw new Error("schema check connection arrived after the deadline");
    }
    client = connected;
    return inspectSchema(connected);
  })();
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Schema check did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  // A late failure after the deadline must not become an unhandled rejection.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { errors: [`Schema check could not complete: ${redactCredentials(message)}`], warnings: [] };
  } finally {
    clearTimeout(timer);
    // Never return this session to the pool: its settings were touched and a
    // timed-out query may still be running on it.
    client?.release(true);
  }
}

function applicationPoolClient(): Promise<SchemaCheckClient> {
  return getDb().$client.connect();
}

/**
 * Boot-time schema check (MIGRATIONS_CHECK). `enforce` throws
 * SchemaNotCurrentError on pending, checksum-mismatched or missing-ledger
 * state, a non-UTC session, or an unreachable database; `warn` logs the same
 * findings and continues; `off` skips the check. Deferred and newer-unknown
 * migrations only warn. Bounded by `timeoutMs`, so boot never hangs.
 */
export async function assertSchemaCurrent(options: SchemaCheckOptions): Promise<SchemaCheckResult> {
  const { mode, logger } = options;
  if (mode === "off") {
    logger.info({ migrationsCheck: mode }, "Database schema check skipped");
    return { mode, skipped: true, errors: [], warnings: [] };
  }
  const inspection = await inspectWithDeadline(
    options.connect ?? applicationPoolClient,
    options.timeoutMs ?? DEFAULT_SCHEMA_CHECK_TIMEOUT_MS,
  );
  const errors = inspection.errors.map(redactCredentials);
  const warnings = inspection.warnings.map(redactCredentials);
  for (const warning of warnings) logger.warn({ migrationsCheck: mode }, `Database schema: ${warning}`);
  if (errors.length && mode === "enforce") {
    logger.error({ migrationsCheck: mode, errors }, "Database schema is not current; refusing to start");
    throw new SchemaNotCurrentError(errors);
  }
  for (const error of errors) {
    logger.warn({ migrationsCheck: mode }, `Database schema not current (continuing because MIGRATIONS_CHECK=warn): ${error}`);
  }
  if (!errors.length) logger.info({ migrationsCheck: mode, warnings: warnings.length }, "Database schema is current");
  return { mode, skipped: false, errors, warnings };
}
