import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { idPk, timestamps } from "../helpers";

export const clients = pgTable("clients", {
  id: idPk(),
  name: text().notNull(),
  logo: text(),
  primaryColor: text(),
  email: text(),
  phone: text(),
  active: boolean().notNull().default(true),
  // Live column is nullable STRING[] with a default (Prisma scalar-list quirk on
  // CockroachDB): no NOT NULL. Keep the default; do not add .notNull().
  enabledModules: text()
    .array()
    .default([
      "pricing",
      "registrations",
      "sponsorships",
      "emails",
      "certificates",
      "abstracts",
    ]),
  ...timestamps,
});

// users.id is the Firebase UID (app-supplied text, NO default) — not a uuid.
export const users = pgTable(
  "users",
  {
    id: text().primaryKey(),
    email: text().notNull(),
    name: text().notNull(),
    role: integer().notNull().default(1),
    clientId: text().references(() => clients.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    active: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("users_email_key").on(t.email),
    index("users_client_id_idx").on(t.clientId),
    index("users_active_role_idx").on(t.active, t.role),
    index("users_client_id_role_idx").on(t.clientId, t.role),
  ],
);
