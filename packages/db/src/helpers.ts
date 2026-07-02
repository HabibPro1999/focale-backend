import { newId } from "@app/shared";
import { timestamp, uuid } from "drizzle-orm/pg-core";

/** Primary key: uuid, defaulted app-side with a UUIDv7. Column name derived from the key. */
export function idPk() {
  return uuid().primaryKey().$defaultFn(newId);
}

/**
 * Spread into every table: createdAt / updatedAt. Column names are derived from
 * the keys via the client's `casing: 'snake_case'` — schema stays camelCase only.
 */
export const timestamps = {
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
};
