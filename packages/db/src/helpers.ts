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
