import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb, type DbExecutor } from "../client";
import { withTxn } from "../txn";
import { enqueueRealtimeOutboxEvent, insertAuditLog } from "../outbox";
import {
  accessCheckIns,
  eventAccess,
  events,
  registrations,
} from "../schema";

// The only payment statuses eligible for check-in anywhere in this module.
export const CHECKIN_ELIGIBLE_STATUSES = [
  "PAID",
  "SPONSORED",
  "WAIVED",
] as const;

export type AccessCheckInRow = typeof accessCheckIns.$inferSelect;

// Registration projection consumed by the check-in flow (mirrors the legacy
// Prisma select; clientId flattened from the joined event — outbox is skipped
// when it is falsy).
export type CheckInRegistration = {
  id: string;
  eventId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  referenceNumber: string | null;
  paymentStatus: string;
  checkedInAt: Date | null;
  checkedInBy: string | null;
  accessTypeIds: string[];
  clientId: string | null;
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Registration + its event's clientId, or null. */
export async function getRegistrationForCheckIn(
  registrationId: string,
  exec: DbExecutor = getDb(),
): Promise<CheckInRegistration | null> {
  const rows = await exec
    .select({
      id: registrations.id,
      eventId: registrations.eventId,
      firstName: registrations.firstName,
      lastName: registrations.lastName,
      email: registrations.email,
      referenceNumber: registrations.referenceNumber,
      paymentStatus: registrations.paymentStatus,
      checkedInAt: registrations.checkedInAt,
      checkedInBy: registrations.checkedInBy,
      accessTypeIds: registrations.accessTypeIds,
      clientId: events.clientId,
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .where(eq(registrations.id, registrationId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row, accessTypeIds: row.accessTypeIds ?? [] };
}

/** Existing access check-in for a (registration, access) pair, or null. */
export async function getAccessCheckIn(
  registrationId: string,
  accessId: string,
  exec: DbExecutor = getDb(),
): Promise<AccessCheckInRow | null> {
  const rows = await exec
    .select()
    .from(accessCheckIns)
    .where(
      and(
        eq(accessCheckIns.registrationId, registrationId),
        eq(accessCheckIns.accessId, accessId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** id of an ACTIVE access item scoped to the event, or null. */
export async function getActiveEventAccessId(
  accessId: string,
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<string | null> {
  const rows = await exec
    .select({ id: eventAccess.id })
    .from(eventAccess)
    .where(
      and(
        eq(eventAccess.id, accessId),
        eq(eventAccess.eventId, eventId),
        eq(eventAccess.active, true),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Eligible registration ids for scanner preload. UNBOUNDED (no pagination) by
 * design — the scanner preloads the whole eligible set for offline use.
 */
export async function getEligibleRegistrationIds(
  eventId: string,
  accessId?: string,
  exec: DbExecutor = getDb(),
): Promise<string[]> {
  const conds = [
    eq(registrations.eventId, eventId),
    inArray(registrations.paymentStatus, [...CHECKIN_ELIGIBLE_STATUSES]),
  ];
  if (accessId) {
    conds.push(sql`${accessId} = ANY(${registrations.accessTypeIds})`);
  }
  const rows = await exec
    .select({ id: registrations.id })
    .from(registrations)
    .where(and(...conds));
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Stats reads (aggregated in the service layer)
// ---------------------------------------------------------------------------

async function countRegistrations(
  where: ReturnType<typeof and>,
  exec: DbExecutor,
): Promise<number> {
  const rows = await exec
    .select({ value: sql<number>`count(*)::int` })
    .from(registrations)
    .where(where);
  return rows[0]?.value ?? 0;
}

export function countEventRegistrations(
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<number> {
  return countRegistrations(eq(registrations.eventId, eventId), exec);
}

export function countCheckedInRegistrations(
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<number> {
  return countRegistrations(
    and(eq(registrations.eventId, eventId), isNotNull(registrations.checkedInAt)),
    exec,
  );
}

/**
 * Per-access checked-in counts, limited to ACTIVE access items belonging to the
 * event and registrations belonging to the event (mirrors the legacy groupBy).
 */
export async function getAccessCheckInCounts(
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<{ accessId: string; count: number }[]> {
  return exec
    .select({
      accessId: accessCheckIns.accessId,
      count: sql<number>`count(${accessCheckIns.id})::int`,
    })
    .from(accessCheckIns)
    .innerJoin(registrations, eq(registrations.id, accessCheckIns.registrationId))
    .innerJoin(eventAccess, eq(eventAccess.id, accessCheckIns.accessId))
    .where(
      and(
        eq(registrations.eventId, eventId),
        eq(eventAccess.eventId, eventId),
        eq(eventAccess.active, true),
      ),
    )
    .groupBy(accessCheckIns.accessId);
}

/** Active access catalogue for an event (id, name, type). */
export function getActiveAccessItems(
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<{ id: string; name: string; type: string }[]> {
  return exec
    .select({ id: eventAccess.id, name: eventAccess.name, type: eventAccess.type })
    .from(eventAccess)
    .where(and(eq(eventAccess.eventId, eventId), eq(eventAccess.active, true)));
}

/** accessTypeIds of eligible registrations (per-access totals, computed in memory). */
export async function getEligibleRegistrationAccessTypeIds(
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<{ accessTypeIds: string[] }[]> {
  const rows = await exec
    .select({ accessTypeIds: registrations.accessTypeIds })
    .from(registrations)
    .where(
      and(
        eq(registrations.eventId, eventId),
        inArray(registrations.paymentStatus, [...CHECKIN_ELIGIBLE_STATUSES]),
      ),
    );
  return rows.map((r) => ({ accessTypeIds: r.accessTypeIds ?? [] }));
}

// ---------------------------------------------------------------------------
// Writes — each owns a READ COMMITTED transaction; audit log + realtime outbox
// enqueue ride the SAME transaction as the domain write (outbox pattern).
// ---------------------------------------------------------------------------

/** Event-level check-in: set checkedInAt/checkedInBy + audit + realtime outbox. */
export async function checkInRegistration(input: {
  registrationId: string;
  eventId: string;
  clientId: string | null;
  checkedInBy: string;
  checkedInAt: Date;
}): Promise<void> {
  await withTxn(async (tx) => {
    await tx
      .update(registrations)
      .set({ checkedInAt: input.checkedInAt, checkedInBy: input.checkedInBy })
      .where(eq(registrations.id, input.registrationId));

    await insertAuditLog(
      {
        entityType: "Registration",
        entityId: input.registrationId,
        action: "CHECK_IN",
        changes: {
          checkedInAt: { old: null, new: input.checkedInAt.toISOString() },
        },
        performedBy: input.checkedInBy,
      },
      tx,
    );

    if (input.clientId) {
      await enqueueRealtimeOutboxEvent(tx, {
        type: "registration.checkedIn",
        clientId: input.clientId,
        eventId: input.eventId,
        payload: { id: input.registrationId },
        ts: Date.now(),
      });
    }
  });
}

/** Access-level check-in: create the row + audit + realtime outbox. */
export async function createAccessCheckIn(input: {
  registrationId: string;
  eventId: string;
  accessId: string;
  clientId: string | null;
  checkedInBy: string;
  checkedInAt: Date;
}): Promise<AccessCheckInRow> {
  return withTxn(async (tx) => {
    const [created] = await tx
      .insert(accessCheckIns)
      .values({
        registrationId: input.registrationId,
        accessId: input.accessId,
        checkedInBy: input.checkedInBy,
        checkedInAt: input.checkedInAt,
      })
      .returning();

    await insertAuditLog(
      {
        entityType: "AccessCheckIn",
        entityId: created.id,
        action: "CHECK_IN",
        changes: {
          accessId: { old: null, new: input.accessId },
          checkedInAt: { old: null, new: input.checkedInAt.toISOString() },
        },
        performedBy: input.checkedInBy,
      },
      tx,
    );

    if (input.clientId) {
      await enqueueRealtimeOutboxEvent(tx, {
        type: "registration.checkedIn",
        clientId: input.clientId,
        eventId: input.eventId,
        payload: { id: input.registrationId, accessId: input.accessId },
        ts: Date.now(),
      });
    }

    return created;
  });
}
