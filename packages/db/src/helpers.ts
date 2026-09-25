import { newId } from "@app/shared";
import { text, timestamp } from "drizzle-orm/pg-core";

/**
 * Primary key: app-side identifier defaulted with a UUIDv7. Column name derived
 * from the key. Type is `text` — the live CockroachDB columns are STRING, and
 * Prisma's `@default(uuid())` is a client-side default, not a DB-native uuid
 * column. Matching `text` avoids a spurious `ALTER COLUMN ... TYPE uuid` diff.
 */
export function idPk() {
  return text().primaryKey().$defaultFn(newId);
}

/**
 * Spread into every table: createdAt / updatedAt. Column names are derived from
 * the keys via the client's `casing: 'snake_case'` — schema stays camelCase only.
 */
// Live DB columns are TIMESTAMP(3) with NO timezone (Prisma DateTime default on
// CockroachDB). Match that: naive timestamp, millisecond precision. Using tz here
// would also break the partial-index predicates in 0001 (timestamptz vs timestamp
// comparison is not IMMUTABLE on Postgres).
//
// updatedAt mirrors Prisma's `@updatedAt`: managed entirely app-side (on insert
// via $defaultFn, on update via $onUpdate). NO DB-level default — the live column
// is `TIMESTAMP(3) NOT NULL` with no DEFAULT, so `.defaultNow()` would drift.
export const timestamps = {
  createdAt: timestamp({ precision: 3 }).defaultNow().notNull(),
  updatedAt: timestamp({ precision: 3 })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
};

// ---------------------------------------------------------------------------
// Raw-result accessors — pg (node-postgres) returns { rowCount, rows }.
// Guard for other drivers. The one copy for every raw-SQL query module.
// ---------------------------------------------------------------------------

export function rowsOf<T = Record<string, unknown>>(res: unknown): T[] {
  const r = res as { rows?: unknown };
  return Array.isArray(r?.rows) ? (r.rows as T[]) : [];
}

export function rowCountOf(res: unknown): number {
  const r = res as { rowCount?: number | null; rows?: unknown[] };
  if (typeof r?.rowCount === "number") return r.rowCount;
  return Array.isArray(r?.rows) ? r.rows.length : 0;
}

/**
 * Shared queue retry backoff (email + abstract-book): 1min, 5min, then 15min,
 * keyed on the post-increment failed attempt count. The steps also feed
 * backoffInterval (the same backoff in SQL).
 */
export const STANDARD_RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000] as const;

export function standardRetryDelayMs(failedAttemptCount: number): number {
  const step = Math.min(Math.max(failedAttemptCount, 1), STANDARD_RETRY_DELAYS_MS.length);
  return STANDARD_RETRY_DELAYS_MS[step - 1]!;
}
