import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { StoredFormSchemaJsonSchema } from "@app/contracts";
import { idPk, timestamps } from "../helpers";
import { jsonbOf } from "../jsonb";
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
    schema: jsonbOf(StoredFormSchemaJsonSchema).notNull(),
    schemaVersion: integer().notNull().default(1),
    successTitle: text(),
    successMessage: text(),
    successTranslations: jsonb(),
    active: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("forms_event_id_idx").on(t.eventId),
    uniqueIndex("forms_event_id_type_key").on(t.eventId, t.type),
  ],
);
