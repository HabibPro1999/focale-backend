import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { idPk, timestamps } from "../helpers";
import { paymentMethod, paymentStatus, registrationRole, transactionType } from "./enums";
import { events } from "./events-access";
import { forms } from "./forms";

export const registrations = pgTable(
  "registrations",
  {
    id: idPk(),
    formId: text()
      .notNull()
      .references(() => forms.id, { onDelete: "restrict", onUpdate: "cascade" }),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "restrict", onUpdate: "cascade" }),
    formData: jsonb().notNull(),
    submittedAt: timestamp({ precision: 3 }).defaultNow().notNull(),
    formSchemaVersion: integer().notNull().default(1),
    email: text().notNull(),
    firstName: text(),
    lastName: text(),
    phone: text(),
    referenceNumber: text(),
    paymentStatus: paymentStatus().notNull().default("PENDING"),
    totalAmount: integer().notNull(),
    paidAmount: integer().notNull().default(0),
    currency: text().notNull().default("TND"),
    paymentMethod: paymentMethod(),
    paymentReference: text(),
    paymentProofUrl: text(),
    priceBreakdown: jsonb().notNull(),
    baseAmount: integer().notNull().default(0),
    discountAmount: integer().notNull().default(0),
    accessAmount: integer().notNull().default(0),
    sponsorshipCode: text(),
    sponsorshipAmount: integer().notNull().default(0),
    labName: text(),
    paidAt: timestamp({ precision: 3 }),
    ...timestamps,
    lastEditedAt: timestamp({ precision: 3 }),
    editToken: text(),
    linkBaseUrl: text(),
    idempotencyKey: text(),
    note: text(),
    // Field is `role` but the column is `registration_role`.
    role: registrationRole("registration_role").notNull().default("PARTICIPANT"),
    // Arrays of EventAccess ids (no FK); a GIN index on access_type_ids lives in raw SQL.
    // Live columns are nullable STRING[] with a default (no NOT NULL) — Prisma
    // scalar-list quirk on CockroachDB. Keep default, no .notNull().
    accessTypeIds: text("access_type_ids").array().default([]),
    droppedAccessIds: text("dropped_access_ids").array().default([]),
    checkedInAt: timestamp({ precision: 3 }),
    checkedInBy: text(),
  },
  (t) => [
    uniqueIndex("registrations_reference_number_key").on(t.referenceNumber),
    uniqueIndex("registrations_edit_token_key").on(t.editToken),
    uniqueIndex("registrations_idempotency_key_key").on(t.idempotencyKey),
    index("registrations_event_id_payment_status_idx").on(t.eventId, t.paymentStatus),
    index("registrations_event_id_submitted_at_idx").on(t.eventId, t.submittedAt),
    index("registrations_form_id_idx").on(t.formId),
    index("registrations_email_idx").on(t.email),
    index("registrations_sponsorship_code_idx").on(t.sponsorshipCode),
    index("registrations_payment_status_updated_at_idx").on(t.paymentStatus, t.updatedAt),
    uniqueIndex("registrations_email_form_id_key").on(t.email, t.formId),
  ],
);

export const paymentTransaction = pgTable(
  "payment_transaction",
  {
    id: idPk(),
    registrationId: text()
      .notNull()
      .references(() => registrations.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    type: transactionType().notNull(),
    amount: integer().notNull(),
    method: paymentMethod(),
    reference: text(),
    note: text(),
    performedBy: text(),
    createdAt: timestamp({ precision: 3 }).defaultNow().notNull(),
  },
  (t) => [index("payment_transaction_registration_id_idx").on(t.registrationId)],
);
