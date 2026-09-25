import { and, asc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "../client";
import { rowCountOf } from "../helpers";
import { DB_NOW } from "../lease-queue";
import { outboxEvents } from "../schema";
import { REALTIME_EMIT_TYPE } from "./types";

export interface DeadLetterFilter {
  /** Only these rows. */
  ids?: string[];
  /** Only this outbox type. */
  type?: string;
  /** Only rows dead-lettered at or after this time. */
  since?: Date;
  limit: number;
}

export interface DeadLetteredOutboxEvent {
  id: string;
  type: string;
  aggregateType: string | null;
  aggregateId: string | null;
  attemptCount: number;
  maxAttempts: number;
  errorMessage: string | null;
  createdAt: Date;
  /** Last write to the row: when it was dead-lettered. */
  deadLetteredAt: Date;
}

// Realtime rows are never requeued: replaying a stale UI event is useless and
// retention deletes them after 24 h anyway.
const requeueable = and(
  eq(outboxEvents.status, "DEAD_LETTERED"),
  ne(outboxEvents.type, REALTIME_EMIT_TYPE),
);

/** Dead-lettered outbox rows (realtime excluded), oldest dead letter first. */
export async function findDeadLetteredOutboxEvents(
  filter: DeadLetterFilter,
): Promise<DeadLetteredOutboxEvent[]> {
  if (filter.ids && filter.ids.length === 0) return [];
  return getDb()
    .select({
      id: outboxEvents.id,
      type: outboxEvents.type,
      aggregateType: outboxEvents.aggregateType,
      aggregateId: outboxEvents.aggregateId,
      attemptCount: outboxEvents.attemptCount,
      maxAttempts: outboxEvents.maxAttempts,
      errorMessage: outboxEvents.errorMessage,
      createdAt: outboxEvents.createdAt,
      deadLetteredAt: outboxEvents.updatedAt,
    })
    .from(outboxEvents)
    .where(
      and(
        requeueable,
        filter.ids ? inArray(outboxEvents.id, filter.ids) : undefined,
        filter.type ? eq(outboxEvents.type, filter.type) : undefined,
        filter.since ? gte(outboxEvents.updatedAt, filter.since) : undefined,
      ),
    )
    .orderBy(asc(outboxEvents.updatedAt), asc(outboxEvents.id))
    .limit(filter.limit);
}

/**
 * Put dead-lettered rows back in the queue as new: PENDING, attempts reset,
 * due now. Only rows still dead-lettered (and not realtime) change; returns
 * how many did. The error message stays until the next claim clears it.
 */
export async function requeueDeadLetteredOutboxEvents(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const res = await getDb().execute(sql`
    UPDATE "outbox_events"
    SET "status" = 'PENDING', "attempt_count" = 0, "next_attempt_at" = NULL,
        "updated_at" = ${DB_NOW}
    WHERE "id" IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      AND "status" = 'DEAD_LETTERED' AND "type" <> ${REALTIME_EMIT_TYPE}
  `);
  return rowCountOf(res);
}
