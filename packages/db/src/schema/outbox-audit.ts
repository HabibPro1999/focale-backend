import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { idPk, timestamps } from "../helpers";

// outbox_events is a fully decoupled table: NO foreign keys. Its id is app-side
// like every other table (live column is STRING with no DB default).
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: idPk(),
    type: text().notNull(),
    aggregateType: text(),
    aggregateId: text(),
    clientId: text(),
    eventId: text(),
    dedupeKey: text(),
    payload: jsonb().notNull(),
    status: text().notNull().default("PENDING"),
    attemptCount: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(5),
    lastAttemptAt: timestamp({ precision: 3 }),
    nextAttemptAt: timestamp({ precision: 3 }),
    lockedAt: timestamp({ precision: 3 }),
    lockedUntil: timestamp({ precision: 3 }),
    lockedBy: text(),
    errorMessage: text(),
    ...timestamps,
    processedAt: timestamp({ precision: 3 }),
  },
  (t) => [
    index("outbox_events_status_next_attempt_at_created_at_idx").on(
      t.status,
      t.nextAttemptAt,
      t.createdAt,
    ),
    index("outbox_events_status_locked_until_idx").on(t.status, t.lockedUntil),
    index("outbox_events_locked_by_idx").on(t.lockedBy),
    index("outbox_events_type_idx").on(t.type),
    index("outbox_events_aggregate_type_aggregate_id_idx").on(
      t.aggregateType,
      t.aggregateId,
    ),
    index("outbox_events_client_id_event_id_idx").on(t.clientId, t.eventId),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: idPk(),
    entityType: text().notNull(),
    entityId: text().notNull(),
    action: text().notNull(),
    changes: jsonb(),
    performedBy: text(),
    performedAt: timestamp({ precision: 3 }).defaultNow().notNull(),
    ipAddress: text(),
    userAgent: text(),
  },
  (t) => [
    index("audit_logs_entity_type_entity_id_idx").on(t.entityType, t.entityId),
    index("audit_logs_performed_by_idx").on(t.performedBy),
    index("audit_logs_performed_at_idx").on(t.performedAt),
  ],
);
