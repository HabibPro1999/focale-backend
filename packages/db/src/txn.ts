import { setTimeout as sleep } from "node:timers/promises";
import { getDb, type Db } from "./client";

type TxnFn<T> = (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<T>;

/**
 * Walk an error's `cause` chain until a pg error carrying `code` is found.
 * drizzle-orm wraps every driver error in DrizzleQueryError, which exposes the
 * pg error only on `.cause` (no `code` on the wrapper itself).
 */
function unwrapPgError(
  err: unknown,
): { code?: unknown; constraint?: unknown } | null {
  let current = err as
    | { code?: unknown; constraint?: unknown; cause?: unknown }
    | null
    | undefined;
  for (let depth = 0; current && depth < 10; depth++) {
    if (typeof current.code === "string") return current;
    current = current.cause as typeof current;
  }
  return null;
}

/**
 * True for the pg SQLSTATEs worth retrying: 40001 serialization_failure
 * (CockroachDB "restart transaction") and 40P01 deadlock_detected.
 */
export function isSerializationFailure(err: unknown): boolean {
  const code = unwrapPgError(err)?.code;
  return code === "40001" || code === "40P01";
}

/**
 * SQLSTATE of the pg error buried in `err`'s cause chain, or null when none.
 * Restricted to 5-char SQLSTATE shape so Node errno codes (ENOENT, …) that
 * also live on `.code` are not mistaken for database errors.
 */
export function pgErrorCode(err: unknown): string | null {
  const code = unwrapPgError(err)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/**
 * pg unique_violation (SQLSTATE 23505) detector. Returns the offending index
 * name in `constraint` (empty string when the driver did not surface one), or
 * null when the error is not a unique violation. CockroachDB reports the index
 * in error.constraint; callers map constraint names to domain errors.
 */
export function pgUniqueViolation(
  err: unknown,
): { constraint: string } | null {
  const e = unwrapPgError(err);
  if (e?.code !== "23505") return null;
  return { constraint: typeof e.constraint === "string" ? e.constraint : "" };
}

/**
 * Retry a serializable transaction on CockroachDB/Postgres serialization
 * failures. 5 attempts total; delay = 25ms * 2^(attempt-1) + up to 50% jitter;
 * retries only on SQLSTATE 40001/40P01; rethrows the original error otherwise
 * or once attempts are exhausted. Ported from legacy withTxnRetry.
 */
export async function withTxnRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || !isSerializationFailure(err)) throw err;
      const base = 25 * 2 ** (attempt - 1);
      const delay = base + Math.random() * (base * 0.5);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * READ COMMITTED transaction. Set explicitly because CockroachDB's session
 * default is SERIALIZABLE.
 */
export function withTxn<T>(fn: TxnFn<T>): Promise<T> {
  return getDb().transaction(fn, { isolationLevel: "read committed" });
}

/** SERIALIZABLE transaction wrapped in withTxnRetry. */
export function withSerializableTxn<T>(fn: TxnFn<T>): Promise<T> {
  return withTxnRetry(() =>
    getDb().transaction(fn, { isolationLevel: "serializable" }),
  );
}
