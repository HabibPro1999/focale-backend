import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { idPk, timestamps } from "../helpers";
import { accessType, eventStatus } from "./enums";
import { clients } from "./users-clients";
import { registrations } from "./registrations";

export const events = pgTable(
  "events",
  {
    id: idPk(),
    clientId: text()
      .notNull()
      .references(() => clients.id, { onDelete: "restrict", onUpdate: "cascade" }),
    name: text().notNull(),
    slug: text().notNull(),
    description: text(),
    maxCapacity: integer(),
    registeredCount: integer().notNull().default(0),
    startDate: timestamp({ precision: 3 }).notNull(),
    endDate: timestamp({ precision: 3 }).notNull(),
    location: text(),
    status: eventStatus().notNull().default("CLOSED"),
    bannerUrl: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("events_slug_key").on(t.slug),
    index("events_client_id_status_idx").on(t.clientId, t.status),
  ],
);

export const eventAccess = pgTable(
  "event_access",
  {
    id: idPk(),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    type: accessType().notNull().default("OTHER"),
    name: text().notNull(),
    description: text(),
    location: text(),
    startsAt: timestamp({ precision: 3 }),
    endsAt: timestamp({ precision: 3 }),
    price: integer().notNull().default(0),
    currency: text().notNull().default("TND"),
    maxCapacity: integer(),
    registeredCount: integer().notNull().default(0),
    paidCount: integer().notNull().default(0),
    availableFrom: timestamp({ precision: 3 }),
    availableTo: timestamp({ precision: 3 }),
    conditions: jsonb(),
    conditionLogic: text().notNull().default("AND"),
    sortOrder: integer().notNull().default(0),
    active: boolean().notNull().default(true),
    groupLabel: text(),
    allowCompanion: boolean().notNull().default(false),
    includedInBase: boolean().notNull().default(false),
    // Production column is INT8 (bigint) — prisma migration 20260319000003 notes the
    // planned narrowing to INT4 was never applied (CRDB can't ALTER TYPE via that path).
    // mode:'number' coerces pg's int8-as-string on prod and passes int4 numbers on dev.
    companionPrice: bigint({ mode: "number" }).notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("event_access_event_id_starts_at_idx").on(t.eventId, t.startsAt),
    index("event_access_event_id_type_idx").on(t.eventId, t.type),
    index("event_access_event_id_active_idx").on(t.eventId, t.active),
    index("event_access_event_id_type_active_idx").on(t.eventId, t.type, t.active),
  ],
);

// Explicit join table for the implicit Prisma self-M2M "AccessPrerequisites".
// EXACT legacy table name and A/B column names; no PK, unique(A,B) + index(B).
export const accessPrerequisites = pgTable(
  "_AccessPrerequisites",
  {
    a: text("A")
      .notNull()
      .references(() => eventAccess.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    b: text("B")
      .notNull()
      .references(() => eventAccess.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (t) => [
    uniqueIndex("_AccessPrerequisites_AB_unique").on(t.a, t.b),
    index("_AccessPrerequisites_B_index").on(t.b),
  ],
);

export const accessCheckIns = pgTable(
  "access_check_ins",
  {
    id: idPk(),
    registrationId: text()
      .notNull()
      .references(() => registrations.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    accessId: text()
      .notNull()
      .references(() => eventAccess.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    checkedInAt: timestamp({ precision: 3 }).defaultNow().notNull(),
    checkedInBy: text().notNull(),
  },
  (t) => [
    index("access_check_ins_access_id_idx").on(t.accessId),
    uniqueIndex("access_check_ins_registration_id_access_id_key").on(
      t.registrationId,
      t.accessId,
    ),
  ],
);
