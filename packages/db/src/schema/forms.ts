import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { idPk, timestamps } from "../helpers";
import { formType } from "./enums";
import { events } from "./events-access";

export const forms = pgTable(
  "forms",
  {
    id: idPk(),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    type: formType().notNull().default("REGISTRATION"),
    name: text().notNull(),
    schema: jsonb().notNull(),
    schemaVersion: integer().notNull().default(1),
    successTitle: text(),
    successMessage: text(),
    active: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("forms_event_id_idx").on(t.eventId),
    uniqueIndex("forms_event_id_type_key").on(t.eventId, t.type),
  ],
);
