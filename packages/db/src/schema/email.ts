import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { idPk, timestamps } from "../helpers";
import {
  abstractEmailTrigger,
  automaticEmailTrigger,
  emailStatus,
  emailTemplateCategory,
} from "./enums";
import { events } from "./events-access";
import { clients } from "./users-clients";
import { registrations } from "./registrations";
import { abstracts } from "./abstracts";

export const emailTemplates = pgTable(
  "email_templates",
  {
    id: idPk(),
    clientId: text()
      .notNull()
      .references(() => clients.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text().notNull(),
    description: text(),
    subject: text().notNull(),
    content: jsonb().notNull(),
    mjmlContent: text(),
    htmlContent: text(),
    plainContent: text(),
    category: emailTemplateCategory().notNull(),
    trigger: automaticEmailTrigger(),
    abstractTrigger: abstractEmailTrigger(),
    eventId: text().references(() => events.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    isDefault: boolean().notNull().default(false),
    isActive: boolean().notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("email_templates_client_id_category_idx").on(t.clientId, t.category),
    index("email_templates_client_id_trigger_idx").on(t.clientId, t.trigger),
    index("email_templates_event_id_idx").on(t.eventId),
  ],
);

export const emailLogs = pgTable(
  "email_logs",
  {
    id: idPk(),
    trigger: automaticEmailTrigger(),
    templateId: text().references(() => emailTemplates.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    registrationId: text().references(() => registrations.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    abstractId: text().references(() => abstracts.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    recipientEmail: text().notNull(),
    recipientName: text(),
    abstractTrigger: abstractEmailTrigger(),
    subject: text().notNull(),
    status: emailStatus().notNull().default("QUEUED"),
    // Provider-neutral field; column kept as sendgrid_message_id for back-compat.
    providerMessageId: text("sendgrid_message_id"),
    errorMessage: text(),
    retryCount: integer().notNull().default(0),
    maxRetries: integer().notNull().default(3),
    attemptCount: integer().notNull().default(0),
    lastAttemptAt: timestamp({ precision: 3 }),
    nextAttemptAt: timestamp({ precision: 3 }),
    lockedAt: timestamp({ precision: 3 }),
    lockedUntil: timestamp({ precision: 3 }),
    lockedBy: text(),
    contextSnapshot: jsonb(),
    // Per-outbox-delivery idempotency key (H6): the outbox event id that
    // produced this row, or a requeue-script-derived key. Partial unique index
    // over active statuses lives in migrations/0003_email_fixes.sql (drizzle
    // can't express partial indexes) — a redelivered outbox event conflicts
    // instead of inserting a duplicate row.
    dedupeKey: text(),
    queuedAt: timestamp({ precision: 3 }).defaultNow().notNull(),
    // App-managed (Prisma @updatedAt): no DB default, matches live column.
    updatedAt: timestamp({ precision: 3 })
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdate(() => new Date()),
    sentAt: timestamp({ precision: 3 }),
    deliveredAt: timestamp({ precision: 3 }),
    openedAt: timestamp({ precision: 3 }),
    clickedAt: timestamp({ precision: 3 }),
    bouncedAt: timestamp({ precision: 3 }),
    failedAt: timestamp({ precision: 3 }),
  },
  (t) => [
    index("email_logs_registration_id_idx").on(t.registrationId),
    index("email_logs_abstract_id_idx").on(t.abstractId),
    index("email_logs_abstract_id_abstract_trigger_queued_at_idx").on(
      t.abstractId,
      t.abstractTrigger,
      t.queuedAt,
    ),
    index("email_logs_status_queued_at_idx").on(t.status, t.queuedAt),
    index("email_logs_status_retry_count_idx").on(t.status, t.retryCount),
    index("email_logs_status_next_attempt_at_queued_at_idx").on(
      t.status,
      t.nextAttemptAt,
      t.queuedAt,
    ),
    index("email_logs_status_locked_until_idx").on(t.status, t.lockedUntil),
    index("email_logs_locked_by_idx").on(t.lockedBy),
    index("email_logs_recipient_email_idx").on(t.recipientEmail),
    index("email_logs_sendgrid_message_id_idx").on(t.providerMessageId),
    index("email_logs_trigger_queued_at_idx").on(t.trigger, t.queuedAt),
  ],
);
