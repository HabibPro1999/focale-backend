import { AppError } from "@shared/errors/app-error.js";
import type { ErrorCode } from "@shared/errors/error-codes.js";

/**
 * Execute a Prisma query and throw AppError if result is null.
 * The query lambda captures tx context via closure, so this works
 * for both direct prisma calls and transaction (tx) calls.
 */
export async function findOrThrow<T>(
  query: () => Promise<T | null>,
  options: { message: string; code: ErrorCode; statusCode?: number },
): Promise<T> {
  const result = await query();
  if (result === null || result === undefined) {
    throw new AppError(
      options.message,
      options.statusCode ?? 404,
      true,
      options.code,
    );
  }
  return result;
}
