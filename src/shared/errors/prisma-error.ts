import { Prisma } from "@/generated/prisma/client.js";

export interface PrismaUniqueTarget {
  fields: string[];
  names: string[];
}

export function getPrismaUniqueTarget(
  error: Prisma.PrismaClientKnownRequestError,
): PrismaUniqueTarget {
  const fields: string[] = [];
  const names: string[] = [];
  const target = error.meta?.target;

  if (Array.isArray(target)) {
    fields.push(
      ...target.filter((field): field is string => typeof field === "string"),
    );
  } else if (typeof target === "string") {
    names.push(target);
  }

  const adapterConstraint = (
    error.meta?.driverAdapterError as
      | { cause?: { constraint?: { fields?: unknown; name?: unknown } } }
      | undefined
  )?.cause?.constraint;

  if (Array.isArray(adapterConstraint?.fields)) {
    fields.push(
      ...adapterConstraint.fields.filter(
        (field): field is string => typeof field === "string",
      ),
    );
  }
  if (typeof adapterConstraint?.name === "string") {
    names.push(adapterConstraint.name);
  }

  return { fields, names };
}

// Retryable transaction-conflict SQLSTATEs: 40001 = serialization_failure
// (CockroachDB's "restart transaction"), 40P01 = deadlock_detected.
const RETRYABLE_SQL_STATES = new Set(["40001", "40P01"]);

/** Collect any SQLSTATE-like code carried by the error or its driver-adapter cause. */
function extractSqlStates(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const e = error as {
    code?: unknown;
    meta?: {
      code?: unknown;
      driverAdapterError?: { cause?: { code?: unknown } };
    };
  };
  return [
    e.code, // pg driver errors expose the SQLSTATE on `.code`
    e.meta?.code,
    e.meta?.driverAdapterError?.cause?.code,
  ].filter((code): code is string => typeof code === "string");
}

/**
 * Whether `error` is a retryable transaction serialization failure / deadlock.
 * CockroachDB requires clients to retry these (SQLSTATE 40001); Prisma also
 * surfaces write-conflicts/deadlocks via the portable code P2034. Used by
 * `withTxnRetry` to decide whether to re-run the whole unit of work.
 */
export function isSerializationFailure(error: unknown): boolean {
  // Prisma's portable code for a write conflict / deadlock.
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2034"
  ) {
    return true;
  }

  // Raw SQLSTATE (e.g. from $queryRawUnsafe paths that bypass Prisma mapping).
  if (extractSqlStates(error).some((code) => RETRYABLE_SQL_STATES.has(code))) {
    return true;
  }

  // Fallback: some adapters only expose the failure in the message text.
  const message = error instanceof Error ? error.message : "";
  return /\b40001\b|serialization failure|restart transaction|write conflict|deadlock detected/i.test(
    message,
  );
}
