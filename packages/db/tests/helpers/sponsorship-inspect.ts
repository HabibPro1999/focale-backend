import { and, asc, eq } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  outboxEvents,
  registrations,
  sponsorshipUsages,
  sponsorships,
} from "@app/db";

// Read-only lookups for the sponsorship-code tests (plan 2.7), so suites
// outside packages/db need no drizzle-orm import of their own.

export async function readSponsorshipRow(id: string) {
  const [row] = await getDb().select().from(sponsorships).where(eq(sponsorships.id, id));
  return row;
}

export async function sponsorshipUsagesOf(sponsorshipId: string) {
  return getDb()
    .select()
    .from(sponsorshipUsages)
    .where(eq(sponsorshipUsages.sponsorshipId, sponsorshipId))
    .orderBy(asc(sponsorshipUsages.appliedAt));
}

export async function registrationIdsOfEvent(eventId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ id: registrations.id })
    .from(registrations)
    .where(eq(registrations.eventId, eventId))
    .orderBy(asc(registrations.id));
  return rows.map((row) => row.id);
}

export async function auditRowsOf(entityType: string, entityId: string) {
  return getDb()
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, entityType), eq(auditLogs.entityId, entityId)));
}

/** Realtime outbox rows of one AppEvent type for one aggregate id. */
export async function realtimeRowsOf(eventType: string, aggregateId: string) {
  return getDb()
    .select()
    .from(outboxEvents)
    .where(and(eq(outboxEvents.aggregateType, eventType), eq(outboxEvents.aggregateId, aggregateId)));
}
