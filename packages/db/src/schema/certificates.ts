import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { StoredCertificateZonesSchema } from "@app/contracts";
import { idPk, timestamps } from "../helpers";
import { jsonbOf } from "../jsonb";
import { registrationRole, abstractFinalType } from "./enums";
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
    // 3.8 (migration 0032): storage key and pixel size of the flattened JPEG
    // the renderer embeds. NULL until the image is uploaded (or backfilled);
    // the renderer then falls back to templateUrl.
    renderImageKey: text(),
    renderImageWidth: integer(),
    renderImageHeight: integer(),
    zones: jsonbOf(StoredCertificateZonesSchema).notNull().default([]),
    // Live column is nullable RegistrationRole[] with a default (no NOT NULL).
    applicableRoles: registrationRole().array().default([]),
    accessId: text().references(() => eventAccess.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    active: boolean().notNull().default(true),
    // H2: registration-vs-abstract scope. Plain text + CHECK constraint (migration
    // 0005), NOT a new pg enum — schema.migration.test.ts (owned by another agent)
    // asserts exactly 19 enum types across every migration file, and a genuine new
    // Postgres enum type would push that to 20. Default 'BOTH' preserves current
    // behavior for every existing row on both the registration and abstract send
    // paths (see isEligibleForCertificate / isAbstractEligibleForCertificate).
    scope: text()
      .notNull()
      .default("BOTH")
      .$type<"REGISTRATION" | "ABSTRACT" | "BOTH">(),
    // Nullable; reuses the existing AbstractFinalType enum (no new type). Null or
    // empty = no restriction, i.e. every final type is allowed (abstract path only).
    allowedAbstractFinalTypes: abstractFinalType().array(),
    ...timestamps,
  },
  (t) => [
    index("certificate_templates_event_id_idx").on(t.eventId),
    check("certificate_templates_scope_check", sql`${t.scope} IN ('REGISTRATION', 'ABSTRACT', 'BOTH')`),
  ],
);
