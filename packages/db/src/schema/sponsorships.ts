import {
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
import { sponsorshipStatus } from "./enums";
import { events } from "./events-access";
import { forms } from "./forms";
import { registrations } from "./registrations";

export const sponsorshipBatches = pgTable(
  "sponsorship_batches",
  {
    id: idPk(),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    formId: text()
      .notNull()
      .references(() => forms.id, { onDelete: "cascade", onUpdate: "cascade" }),
    labName: text().notNull(),
    contactName: text().notNull(),
    email: text().notNull(),
    phone: text(),
    formData: jsonb().notNull(),
    createdAt: timestamp({ precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    index("sponsorship_batches_event_id_idx").on(t.eventId),
    index("sponsorship_batches_email_idx").on(t.email),
  ],
);

export const sponsorships = pgTable(
  "sponsorships",
  {
    id: idPk(),
    batchId: text()
      .notNull()
      .references(() => sponsorshipBatches.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    code: text().notNull(),
    status: sponsorshipStatus().notNull().default("PENDING"),
    beneficiaryName: text().notNull(),
    beneficiaryEmail: text().notNull(),
    beneficiaryPhone: text(),
    beneficiaryAddress: text(),
    coversBasePrice: boolean().notNull().default(true),
    // Live column is nullable STRING[] with a default (no NOT NULL).
    coveredAccessIds: text("covered_access_ids").array().default([]),
    totalAmount: integer().notNull(),
    targetRegistrationId: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("sponsorships_code_key").on(t.code),
    index("sponsorships_event_id_idx").on(t.eventId),
    index("sponsorships_batch_id_idx").on(t.batchId),
    index("sponsorships_event_id_status_idx").on(t.eventId, t.status),
    index("sponsorships_status_idx").on(t.status),
    index("sponsorships_batch_id_status_idx").on(t.batchId, t.status),
  ],
);

export const sponsorshipUsages = pgTable(
  "sponsorship_usages",
  {
    id: idPk(),
    sponsorshipId: text()
      .notNull()
      .references(() => sponsorships.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    registrationId: text().references(() => registrations.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    amountApplied: integer().notNull(),
    appliedAt: timestamp({ precision: 3 }).defaultNow().notNull(),
    appliedBy: text().notNull(),
  },
  (t) => [
    index("sponsorship_usages_registration_id_idx").on(t.registrationId),
    uniqueIndex("sponsorship_usages_sponsorship_id_registration_id_key").on(
      t.sponsorshipId,
      t.registrationId,
    ),
  ],
);
