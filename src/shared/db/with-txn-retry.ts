import { logger } from "@shared/utils/logger.js";
import { isSerializationFailure } from "@shared/errors/prisma-error.js";

export interface TxnRetryOptions {
  /** Total attempts including the first. Default 5. */
  maxAttempts?: number;
  /** Base backoff in ms; grows exponentially with jitter. Default 25. */
  baseDelayMs?: number;
  /** Label for logs. */
  label?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` and retry it on retryable serialization failures / deadlocks
 * (SQLSTATE 40001 / Prisma P2034). CockroachDB requires clients to retry these;
 * non-serialization errors propagate immediately.
 *
 * `fn` MUST be the whole unit of work — it re-runs from scratch on retry, so it
 * should open its own `prisma.$transaction(..., { isolationLevel: Serializable })`
 * and perform no side effects outside the database. See ADR 0001.
 *
 *   return withTxnRetry(
 *     () => prisma.$transaction(fn, { isolationLevel: Serializable }),
 *     { label: "updateEventPricing" },
 *   );
 */
export async function withTxnRetry<T>(
  fn: () => Promise<T>,
  options: TxnRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 25;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isSerializationFailure(error) || attempt >= maxAttempts) {
        throw error;
      }
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const delay = backoff + Math.floor(Math.random() * backoff * 0.5);
      logger.warn(
        { attempt, maxAttempts, delay, label: options.label },
        "Serialization failure; retrying transaction",
      );
      await sleep(delay);
    }
  }
}
