import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { FULLY_SETTLED_STATUSES } from "@app/shared";
import { getDb, type DbExecutor } from "../client";
import { withLockingTxn } from "../txn";
import { enqueueRealtimeOutboxEvent, insertAuditLog } from "../outbox";
import {
  accessCheckIns,
  eventAccess,
  events,
  registrations,
} from "../schema";

// Check-in is open to fully settled registrations only (PAID, SPONSORED,
// WAIVED): FULLY_SETTLED_STATUSES from @app/shared, used by every read and
// write in this module.

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

// Shared by live scans and offline preload. Ordinary event/access scanning is
// unaffected unless this access item is configured as the networking entrance.
function networkingAdmission(accessId: string) {
  return sql`NOT EXISTS (
    SELECT 1 FROM networking_configs c
    WHERE c.event_id=${registrations.eventId} AND c.config->>'enabled'='true'
      AND c.config->>'requiredAccessId'=${accessId}
      AND NOT EXISTS (
        SELECT 1 FROM networking_profiles p
        WHERE p.registration_id=${registrations.id} AND p.event_id=c.event_id
          AND p.status='ACTIVE' AND p.consent AND p.withdrawn_at IS NULL
          AND ${registrations.networkingOptIn} IS DISTINCT FROM false
          AND c.config->'eligiblePaymentStatuses' ? ${registrations.paymentStatus}::text
          AND EXISTS (
            SELECT 1 FROM networking_meetings m
            WHERE m.event_id=p.event_id AND m.status='CONFIRMED'
              AND (m.requester_id=p.id OR m.recipient_id=p.id)
          )
      )
  )`;
}

export async function isNetworkingAccessAllowed(eventId: string, registrationId: string, accessId: string) {
  const rows = await getDb().select({ id: registrations.id }).from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.id, registrationId), networkingAdmission(accessId)))
    .limit(1);
  return rows.length > 0;
}

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

/** getRegistrationForCheckIn for many ids at once (missing ids are absent). */
export async function getRegistrationsForCheckIn(
  registrationIds: readonly string[],
  exec: DbExecutor = getDb(),
): Promise<Map<string, CheckInRegistration>> {
  if (registrationIds.length === 0) return new Map();
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
    .where(inArray(registrations.id, [...new Set(registrationIds)]));
  return new Map(
    rows.map((row) => [row.id, { ...row, accessTypeIds: row.accessTypeIds ?? [] }]),
  );
}

/** Which of `registrationIds` pass the networking entrance rule for `accessId`. */
export async function getNetworkingAdmittedRegistrationIds(
  eventId: string,
  accessId: string,
  registrationIds: readonly string[],
  exec: DbExecutor = getDb(),
): Promise<Set<string>> {
  if (registrationIds.length === 0) return new Set();
  const rows = await exec
    .select({ id: registrations.id })
    .from(registrations)
    .where(
      and(
        eq(registrations.eventId, eventId),
        inArray(registrations.id, [...new Set(registrationIds)]),
        networkingAdmission(accessId),
      ),
    );
  return new Set(rows.map((row) => row.id));
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
    inArray(registrations.paymentStatus, [...FULLY_SETTLED_STATUSES]),
  ];
  if (accessId) {
    conds.push(sql`${accessId}::text = ANY(${registrations.accessTypeIds})`);
    conds.push(networkingAdmission(accessId));
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
        inArray(registrations.paymentStatus, [...FULLY_SETTLED_STATUSES]),
      ),
    );
  return rows.map((r) => ({ accessTypeIds: r.accessTypeIds ?? [] }));
}

// ---------------------------------------------------------------------------
// Writes. A check-in changes a row only when it is not checked in yet: the
// event-level write is a CAS on registrations (checked_in_at IS NULL and a
// fully settled payment status), the access-level write an insert that does
// nothing on the (registration, access) unique key. Audit log and realtime
// outbox are written in the same transaction, and only when a row changed, so
// parallel scans of one badge produce one audit row and one realtime event.
// Transactions retry on 40001/40P01 (withLockingTxn); every write is safe to
// re-run.
// ---------------------------------------------------------------------------

export type CheckInWriteResult =
  | { outcome: "CHECKED_IN"; checkedInAt: Date }
  | { outcome: "ALREADY_CHECKED_IN"; checkedInAt: Date }
  /** Event level only: the registration is no longer fully settled (or gone). */
  | { outcome: "NOT_ELIGIBLE" };

export interface CheckInWriteInput {
  registrationId: string;
  eventId: string;
  clientId: string | null;
  checkedInBy: string;
  checkedInAt: Date;
}

async function checkInRegistrationTx(
  tx: DbExecutor,
  input: CheckInWriteInput,
): Promise<CheckInWriteResult> {
  const [updated] = await tx
    .update(registrations)
    .set({ checkedInAt: input.checkedInAt, checkedInBy: input.checkedInBy })
    .where(
      and(
        eq(registrations.id, input.registrationId),
        eq(registrations.eventId, input.eventId),
        isNull(registrations.checkedInAt),
        inArray(registrations.paymentStatus, [...FULLY_SETTLED_STATUSES]),
      ),
    )
    .returning({ id: registrations.id });

  if (!updated) {
    const [current] = await tx
      .select({ checkedInAt: registrations.checkedInAt })
      .from(registrations)
      .where(
        and(
          eq(registrations.id, input.registrationId),
          eq(registrations.eventId, input.eventId),
        ),
      )
      .limit(1);
    return current?.checkedInAt
      ? { outcome: "ALREADY_CHECKED_IN", checkedInAt: current.checkedInAt }
      : { outcome: "NOT_ELIGIBLE" };
  }

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

  return { outcome: "CHECKED_IN", checkedInAt: input.checkedInAt };
}

async function createAccessCheckInTx(
  tx: DbExecutor,
  input: CheckInWriteInput & { accessId: string },
): Promise<CheckInWriteResult> {
  const [created] = await tx
    .insert(accessCheckIns)
    .values({
      registrationId: input.registrationId,
      accessId: input.accessId,
      checkedInBy: input.checkedInBy,
      checkedInAt: input.checkedInAt,
    })
    .onConflictDoNothing({
      target: [accessCheckIns.registrationId, accessCheckIns.accessId],
    })
    .returning();

  if (!created) {
    const existing = await getAccessCheckIn(input.registrationId, input.accessId, tx);
    if (!existing) {
      throw new Error("Access check-in conflicted but no existing row was found");
    }
    return { outcome: "ALREADY_CHECKED_IN", checkedInAt: existing.checkedInAt };
  }

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

  return { outcome: "CHECKED_IN", checkedInAt: created.checkedInAt };
}

/** Event-level check-in (CAS). */
export function checkInRegistration(
  input: CheckInWriteInput,
): Promise<CheckInWriteResult> {
  return withLockingTxn((tx) => checkInRegistrationTx(tx, input));
}

/** Access-level check-in (insert unless one exists). */
export function createAccessCheckIn(
  input: CheckInWriteInput & { accessId: string },
): Promise<CheckInWriteResult> {
  return withLockingTxn((tx) => createAccessCheckInTx(tx, input));
}

/** Most items `batchCheckIn` writes in one transaction. */
export const CHECK_IN_BATCH_TX_SIZE = 100;

export type BatchCheckInItem = CheckInWriteInput & { accessId?: string };

export type BatchCheckInResult =
  | CheckInWriteResult
  /** The item's own write failed (e.g. its access item was deleted). */
  | { outcome: "FAILED"; error: unknown };

function checkInItemTx(tx: DbExecutor, item: BatchCheckInItem) {
  return item.accessId
    ? createAccessCheckInTx(tx, { ...item, accessId: item.accessId })
    : checkInRegistrationTx(tx, item);
}

/**
 * Check in up to CHECK_IN_BATCH_TX_SIZE validated items in one transaction and
 * return one result per item, in input order. Items are written in
 * (registrationId, accessId) order so overlapping batches lock rows in the same
 * order. If the transaction fails, each item is retried in its own transaction
 * so one bad item (FAILED) does not fail the others.
 */
export async function batchCheckIn(
  items: readonly BatchCheckInItem[],
): Promise<BatchCheckInResult[]> {
  if (items.length > CHECK_IN_BATCH_TX_SIZE) {
    throw new RangeError(
      `batchCheckIn takes at most ${CHECK_IN_BATCH_TX_SIZE} items per transaction`,
    );
  }
  if (items.length === 0) return [];
  const compare = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const order = items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        compare(a.item.registrationId, b.item.registrationId) ||
        compare(a.item.accessId ?? "", b.item.accessId ?? ""),
    );
  try {
    return await withLockingTxn(async (tx) => {
      const results = new Array<BatchCheckInResult>(items.length);
      for (const { item, index } of order) {
        results[index] = await checkInItemTx(tx, item);
      }
      return results;
    });
  } catch {
    const results = new Array<BatchCheckInResult>(items.length);
    for (const { item, index } of order) {
      try {
        results[index] = await withLockingTxn((tx) => checkInItemTx(tx, item));
      } catch (error) {
        results[index] = { outcome: "FAILED", error };
      }
    }
    return results;
  }
}
