import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { networkingProfiles } from "./networking";
import { timestamps } from "../helpers";
export const networkingSecondFactors = pgTable("networking_second_factors", {
  profileId: text()
    .primaryKey()
    .references(() => networkingProfiles.id, { onDelete: "cascade" }),
  encryptedSecret: text(),
  pendingEncryptedSecret: text(),
  enabledAt: timestamp({ precision: 3, withTimezone: true }),
  recoveryHashes: jsonb().$type<string[]>().notNull().default([]),
  lastCounter: integer().notNull().default(-1),
  failedAttempts: integer().notNull().default(0),
  lastAttemptAt: timestamp({ precision: 3, withTimezone: true }),
  ...timestamps,
});
