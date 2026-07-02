import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { idPk, timestamps } from "../helpers";
import { registrationRole } from "./enums";
import { eventAccess, events } from "./events-access";

export const certificateTemplates = pgTable(
  "certificate_templates",
  {
    id: idPk(),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text().notNull(),
    templateUrl: text().notNull(),
    templateWidth: integer().notNull(),
    templateHeight: integer().notNull(),
    zones: jsonb().notNull().default([]),
    // Live column is nullable RegistrationRole[] with a default (no NOT NULL).
    applicableRoles: registrationRole().array().default([]),
    accessId: text().references(() => eventAccess.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    active: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [index("certificate_templates_event_id_idx").on(t.eventId)],
);
