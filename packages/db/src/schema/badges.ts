import { index, integer, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { StoredBadgeZonesSchema } from "@app/contracts";
import { idPk, timestamps } from "../helpers";
import { jsonbOf } from "../jsonb";
import { events } from "./events-access";

// 0042: an event's registrant badge designs. A separate table from
// certificate_templates: certificate eligibility, sends and dedupe do not apply.
export const badgeTemplates = pgTable(
  "badge_templates",
  {
    id: idPk(),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text().notNull(),
    // Page size in millimetres (the admin's size presets are not stored).
    widthMm: numeric({ precision: 6, scale: 2, mode: "number" }).notNull(),
    heightMm: numeric({ precision: 6, scale: 2, mode: "number" }).notNull(),
    // The optional background: the public original and its pixel size, and
    // the flattened JPEG copy the renderer embeds (private). All NULL until
    // an image is uploaded.
    backgroundUrl: text(),
    backgroundWidth: integer(),
    backgroundHeight: integer(),
    renderImageKey: text(),
    renderImageWidth: integer(),
    renderImageHeight: integer(),
    zones: jsonbOf(StoredBadgeZonesSchema).notNull().default([]),
    deletedAt: timestamp({ precision: 3, withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("badge_templates_event_id_idx").on(t.eventId)],
);
