import { z } from "zod";

// Database pool/session settings. One definition serves both the app-config
// schema (fail fast at boot) and the db client, which reads process.env
// directly when it lazily builds the pool.

/** Upper bound for every DB_*_MS setting (one hour). */
export const DB_TIMEOUT_MAX_MS = 3_600_000;
/** Smallest non-zero timeout; guards against seconds typed as milliseconds. */
export const DB_TIMEOUT_MIN_MS = 1_000;
export const DB_POOL_MAX_LIMIT = 100;

export const DB_SETTING_DEFAULTS = Object.freeze({
  poolMaxProduction: 20,
  poolMaxOther: 5,
  // 2x the 30 s interactive-transaction cap the legacy Prisma client enforced in
  // production; no request or job path issues a single statement near it.
  statementTimeoutMs: 60_000,
  // Transactions never await external I/O (outbox/lease pattern), so a
  // minute idle inside one means a stuck caller holding row locks.
  idleInTransactionTimeoutMs: 60_000,
  // Report/registration exports scan a whole event in one statement.
  exportStatementTimeoutMs: 300_000,
});

// Env values are strings; accept only plain decimal digits so "", "1e3" or
// "30s" fail instead of coercing to something unintended.
function envInteger(min: number, max: number, message: string) {
  return z.preprocess(
    (value) => {
      if (value === undefined) return undefined;
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      if (trimmed === "") return undefined;
      return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
    },
    z
      .number({ error: message })
      .int({ error: message })
      .min(min, { error: message })
      .max(max, { error: message })
      .optional(),
  );
}

function envTimeoutMs(name: string) {
  const message = `${name} must be 0 (disabled) or an integer from ${DB_TIMEOUT_MIN_MS} to ${DB_TIMEOUT_MAX_MS} milliseconds`;
  return envInteger(0, DB_TIMEOUT_MAX_MS, message).refine(
    (value) => value === undefined || value === 0 || value >= DB_TIMEOUT_MIN_MS,
    { error: message },
  );
}

/** Zod shape for the DB_* environment keys (spread into the app-config schema). */
export const dbEnvShape = {
  DB_POOL_MAX: envInteger(
    1,
    DB_POOL_MAX_LIMIT,
    `DB_POOL_MAX must be an integer from 1 to ${DB_POOL_MAX_LIMIT}`,
  ),
  DB_STATEMENT_TIMEOUT_MS: envTimeoutMs("DB_STATEMENT_TIMEOUT_MS"),
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: envTimeoutMs("DB_IDLE_IN_TRANSACTION_TIMEOUT_MS"),
  DB_EXPORT_STATEMENT_TIMEOUT_MS: envTimeoutMs("DB_EXPORT_STATEMENT_TIMEOUT_MS"),
};

const dbEnvSchema = z.object(dbEnvShape);

export type DbEnv = z.infer<typeof dbEnvSchema>;

export interface DbRuntimeSettings {
  poolMax: number;
  /** 0 disables the server-side limit. */
  statementTimeoutMs: number;
  /** 0 disables the server-side limit. */
  idleInTransactionTimeoutMs: number;
  /** Per-transaction override used by exports; 0 disables it. */
  exportStatementTimeoutMs: number;
}

/** Apply defaults to already-validated DB_* values. */
export function dbRuntimeSettingsFrom(
  env: DbEnv,
  nodeEnv: string | undefined,
): DbRuntimeSettings {
  return {
    poolMax:
      env.DB_POOL_MAX ??
      (nodeEnv === "production"
        ? DB_SETTING_DEFAULTS.poolMaxProduction
        : DB_SETTING_DEFAULTS.poolMaxOther),
    statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS ?? DB_SETTING_DEFAULTS.statementTimeoutMs,
    idleInTransactionTimeoutMs:
      env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS ?? DB_SETTING_DEFAULTS.idleInTransactionTimeoutMs,
    exportStatementTimeoutMs:
      env.DB_EXPORT_STATEMENT_TIMEOUT_MS ?? DB_SETTING_DEFAULTS.exportStatementTimeoutMs,
  };
}

/**
 * Validate the DB_* keys of an environment and apply defaults. Throws with
 * every offending key listed (values are not echoed).
 */
export function resolveDbRuntimeSettings(source: NodeJS.ProcessEnv): DbRuntimeSettings {
  const result = dbEnvSchema.safeParse({
    DB_POOL_MAX: source.DB_POOL_MAX,
    DB_STATEMENT_TIMEOUT_MS: source.DB_STATEMENT_TIMEOUT_MS,
    DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: source.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    DB_EXPORT_STATEMENT_TIMEOUT_MS: source.DB_EXPORT_STATEMENT_TIMEOUT_MS,
  });
  if (!result.success) {
    const details = result.error.issues.map((issue) => `  - ${issue.message}`).join("\n");
    throw new Error(`Invalid database settings:\n${details}`);
  }
  return dbRuntimeSettingsFrom(result.data, source.NODE_ENV);
}
