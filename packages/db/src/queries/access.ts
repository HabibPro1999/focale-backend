import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, type DbExecutor } from "../client";
import {
  accessPrerequisites,
  auditLogs,
  eventAccess,
  events,
  outboxEvents,
  registrations,
  sponsorshipUsages,
  sponsorships,
} from "../schema";

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type EventAccessRow = typeof eventAccess.$inferSelect;
export type NewEventAccessValues = typeof eventAccess.$inferInsert;

export type EventAccessWithPrereqs = EventAccessRow & {
  requiredAccess: { id: string; name: string }[];
};
export type EventAccessWithPrereqIds = EventAccessRow & {
  requiredAccess: { id: string }[];
};

// Registration projection used by the capacity/deactivation drop paths.
export type RegistrationForAccessDrop = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  accessTypeIds: string[] | null;
  droppedAccessIds: string[] | null;
  totalAmount: number;
  accessAmount: number;
  sponsorshipAmount: number;
  priceBreakdown: unknown;
};

// ---------------------------------------------------------------------------
// Prerequisite (_AccessPrerequisites) direction.
// Prisma implicit self-M2M: relation fields sort alphabetically → column A is
// the `prerequisiteFor` side, column B the `requiredAccess` side. Therefore a
// row (a, b) means "a is a prerequisite for b" ⇔ "b requires a".
//   • things X requires   = SELECT a WHERE b = X
//   • things that need X   = SELECT b WHERE a = X   (X's dependents)
//   • connect "X requires Y" = INSERT (a = Y, b = X)
// ---------------------------------------------------------------------------

/** Fetch requiredAccess {id,name} for a set of owner ids, grouped by owner. */
async function loadRequiredAccessByOwners(
  ownerIds: string[],
  exec: DbExecutor,
): Promise<Map<string, { id: string; name: string }[]>> {
  const map = new Map<string, { id: string; name: string }[]>();
  if (ownerIds.length === 0) return map;
  const rows = await exec
    .select({
      owner: accessPrerequisites.b,
      id: eventAccess.id,
      name: eventAccess.name,
    })
    .from(accessPrerequisites)
    .innerJoin(eventAccess, eq(eventAccess.id, accessPrerequisites.a))
    .where(inArray(accessPrerequisites.b, ownerIds));
  for (const r of rows) {
    const list = map.get(r.owner) ?? [];
    list.push({ id: r.id, name: r.name });
    map.set(r.owner, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Event id + date bounds (create-time validation). */
export async function getEventDatesForAccess(
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<{ id: string; startDate: Date; endDate: Date } | null> {
  const rows = await exec
    .select({ id: events.id, startDate: events.startDate, endDate: events.endDate })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return rows[0] ?? null;
}

/** Single access + its requiredAccess {id,name}, or null. */
export async function getEventAccessById(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<EventAccessWithPrereqs | null> {
  const rows = await exec.select().from(eventAccess).where(eq(eventAccess.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const required = (await loadRequiredAccessByOwners([id], exec)).get(id) ?? [];
  return { ...row, requiredAccess: required };
}

/** Access row + its event's date bounds (update-time validation), or null. */
export async function getEventAccessForUpdate(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<(EventAccessRow & { event: { startDate: Date; endDate: Date } }) | null> {
  const rows = await exec
    .select({
      access: eventAccess,
      startDate: events.startDate,
      endDate: events.endDate,
    })
    .from(eventAccess)
    .innerJoin(events, eq(events.id, eventAccess.eventId))
    .where(eq(eventAccess.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row.access, event: { startDate: row.startDate, endDate: row.endDate } };
}

/** List access for an event, ordered [sortOrder, startsAt, createdAt] asc. */
export async function listEventAccessRows(
  eventId: string,
  options: { active?: boolean; type?: string } | undefined,
  exec: DbExecutor = getDb(),
): Promise<EventAccessWithPrereqs[]> {
  const conds = [eq(eventAccess.eventId, eventId)];
  if (options?.active !== undefined) conds.push(eq(eventAccess.active, options.active));
  if (options?.type) conds.push(eq(eventAccess.type, options.type as EventAccessRow["type"]));

  const rows = await exec
    .select()
    .from(eventAccess)
    .where(and(...conds))
    .orderBy(
      sql`${eventAccess.sortOrder} asc`,
      sql`${eventAccess.startsAt} asc nulls last`,
      sql`${eventAccess.createdAt} asc`,
    );

  const byOwner = await loadRequiredAccessByOwners(
    rows.map((r) => r.id),
    exec,
  );
  return rows.map((r) => ({ ...r, requiredAccess: byOwner.get(r.id) ?? [] }));
}

/** clientId for an access (via its event), or null if the access is missing. */
export async function getAccessClientId(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<string | null> {
  const rows = await exec
    .select({ clientId: events.clientId })
    .from(eventAccess)
    .innerJoin(events, eq(events.id, eventAccess.eventId))
    .where(eq(eventAccess.id, id))
    .limit(1);
  return rows[0]?.clientId ?? null;
}

/** Of `ids`, which exist as access rows in `eventId` (prerequisite existence check). */
export async function findExistingAccessIdsInEvent(
  ids: string[],
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await exec
    .select({ id: eventAccess.id })
    .from(eventAccess)
    .where(and(inArray(eventAccess.id, ids), eq(eventAccess.eventId, eventId)));
  return rows.map((r) => r.id);
}

/** All prerequisite edges for an event's accesses: {owner, required} pairs. */
export async function getEventPrereqEdges(
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<{ owner: string; required: string }[]> {
  const rows = await exec
    .select({ owner: accessPrerequisites.b, required: accessPrerequisites.a })
    .from(accessPrerequisites)
    .innerJoin(eventAccess, eq(eventAccess.id, accessPrerequisites.b))
    .where(eq(eventAccess.eventId, eventId));
  return rows;
}

/** Active access for grouping, ordered [type, sortOrder, startsAt] asc, with prereq ids. */
export async function getActiveAccessForGrouping(
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<EventAccessWithPrereqIds[]> {
  const rows = await exec
    .select()
    .from(eventAccess)
    .where(and(eq(eventAccess.eventId, eventId), eq(eventAccess.active, true)))
    .orderBy(
      sql`${eventAccess.type} asc`,
      sql`${eventAccess.sortOrder} asc`,
      sql`${eventAccess.startsAt} asc nulls last`,
    );
  const byOwner = await loadRequiredAccessByOwners(
    rows.map((r) => r.id),
    exec,
  );
  return rows.map((r) => ({
    ...r,
    requiredAccess: (byOwner.get(r.id) ?? []).map((p) => ({ id: p.id })),
  }));
}

/** Selected access (by id, in event) with prereq ids — for selection validation. */
export async function getAccessByIdsForValidation(
  ids: string[],
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<EventAccessWithPrereqIds[]> {
  if (ids.length === 0) return [];
  const rows = await exec
    .select()
    .from(eventAccess)
    .where(and(inArray(eventAccess.id, ids), eq(eventAccess.eventId, eventId)));
  const byOwner = await loadRequiredAccessByOwners(
    rows.map((r) => r.id),
    exec,
  );
  return rows.map((r) => ({
    ...r,
    requiredAccess: (byOwner.get(r.id) ?? []).map((p) => ({ id: p.id })),
  }));
}

/** Active, includedInBase access for an event (mandatory-selection check). */
export async function getIncludedInBaseAccess(
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<
  { id: string; name: string; conditions: unknown; conditionLogic: string }[]
> {
  return exec
    .select({
      id: eventAccess.id,
      name: eventAccess.name,
      conditions: eventAccess.conditions,
      conditionLogic: eventAccess.conditionLogic,
    })
    .from(eventAccess)
    .where(
      and(
        eq(eventAccess.eventId, eventId),
        eq(eventAccess.active, true),
        eq(eventAccess.includedInBase, true),
      ),
    );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Insert an access row + connect its prerequisites; return it with {id,name} prereqs. */
export async function insertEventAccess(
  values: NewEventAccessValues,
  requiredAccessIds: string[],
  exec: DbExecutor = getDb(),
): Promise<EventAccessWithPrereqs> {
  const [row] = await exec.insert(eventAccess).values(values).returning();
  if (requiredAccessIds.length > 0) {
    await exec
      .insert(accessPrerequisites)
      .values(requiredAccessIds.map((reqId) => ({ a: reqId, b: row.id })));
  }
  const required = (await loadRequiredAccessByOwners([row.id], exec)).get(row.id) ?? [];
  return { ...row, requiredAccess: required };
}

/** Update access columns; return the updated row (no prereq changes). */
export async function updateEventAccessRow(
  id: string,
  data: Partial<NewEventAccessValues>,
  exec: DbExecutor = getDb(),
): Promise<EventAccessRow> {
  const [row] = await exec.update(eventAccess).set(data).where(eq(eventAccess.id, id)).returning();
  return row;
}

/** Full-replace an access item's prerequisites (Prisma `set` semantics). */
export async function setAccessPrerequisites(
  ownerId: string,
  requiredIds: string[],
  exec: DbExecutor = getDb(),
): Promise<void> {
  await exec.delete(accessPrerequisites).where(eq(accessPrerequisites.b, ownerId));
  if (requiredIds.length > 0) {
    await exec
      .insert(accessPrerequisites)
      .values(requiredIds.map((reqId) => ({ a: reqId, b: ownerId })));
  }
}

/** Return an access row + {id,name} prereqs (used to shape update responses). */
export async function getEventAccessWithPrereqs(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<EventAccessWithPrereqs | null> {
  return getEventAccessById(id, exec);
}

export async function countRegistrationsWithAccess(
  accessId: string,
  exec: DbExecutor = getDb(),
): Promise<number> {
  const rows = await exec
    .select({ value: sql<number>`count(*)::int` })
    .from(registrations)
    .where(sql`${accessId} = ANY(${registrations.accessTypeIds})`);
  return rows[0]?.value ?? 0;
}

export async function countActiveSponsorshipsWithAccess(
  accessId: string,
  exec: DbExecutor = getDb(),
): Promise<number> {
  const rows = await exec
    .select({ value: sql<number>`count(*)::int` })
    .from(sponsorships)
    .where(
      and(
        sql`${accessId} = ANY(${sponsorships.coveredAccessIds})`,
        sql`${sponsorships.status} <> 'CANCELLED'`,
      ),
    );
  return rows[0]?.value ?? 0;
}

/** Ids of accesses that require `accessId` (its dependents). */
export async function getAccessDependentIds(
  accessId: string,
  exec: DbExecutor = getDb(),
): Promise<string[]> {
  const rows = await exec
    .select({ owner: accessPrerequisites.b })
    .from(accessPrerequisites)
    .where(eq(accessPrerequisites.a, accessId));
  return rows.map((r) => r.owner);
}

/** Remove `requiredId` from `ownerId`'s prerequisite list. */
export async function removePrerequisiteEdge(
  ownerId: string,
  requiredId: string,
  exec: DbExecutor = getDb(),
): Promise<void> {
  await exec
    .delete(accessPrerequisites)
    .where(and(eq(accessPrerequisites.a, requiredId), eq(accessPrerequisites.b, ownerId)));
}

export async function deleteEventAccessById(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<void> {
  await exec.delete(eventAccess).where(eq(eventAccess.id, id));
}

// ---------------------------------------------------------------------------
// Capacity CAS — single-statement guarded UPDATEs (raw SQL, RETURNING).
// Return whether a row was affected; callers diagnose misses via the reads below.
// ---------------------------------------------------------------------------

function rowCount(res: unknown): number {
  const r = res as { rowCount?: number | null; rows?: unknown[] };
  if (typeof r?.rowCount === "number") return r.rowCount;
  return Array.isArray(r?.rows) ? r.rows.length : 0;
}

/** registered_count += qty, but only while paid_count + qty stays within capacity. */
export async function casIncrementAccessRegisteredCount(
  accessId: string,
  quantity: number,
  exec: DbExecutor = getDb(),
): Promise<boolean> {
  const res = await exec.execute(sql`
    UPDATE event_access
    SET registered_count = registered_count + ${quantity}
    WHERE id = ${accessId}
    AND (max_capacity IS NULL OR paid_count + ${quantity} <= max_capacity)
    RETURNING id
  `);
  return rowCount(res) > 0;
}

/** registered_count -= qty, guarded at floor (registered_count >= qty). */
export async function casDecrementAccessRegisteredCount(
  accessId: string,
  quantity: number,
  exec: DbExecutor = getDb(),
): Promise<boolean> {
  const res = await exec.execute(sql`
    UPDATE event_access
    SET registered_count = registered_count - ${quantity}
    WHERE id = ${accessId}
    AND registered_count >= ${quantity}
    RETURNING id
  `);
  return rowCount(res) > 0;
}

/** paid_count += qty within capacity — authoritative occupancy gate. */
export async function casIncrementAccessPaidCount(
  accessId: string,
  quantity: number,
  exec: DbExecutor = getDb(),
): Promise<boolean> {
  const res = await exec.execute(sql`
    UPDATE event_access
    SET paid_count = paid_count + ${quantity}
    WHERE id = ${accessId}
    AND (max_capacity IS NULL OR paid_count + ${quantity} <= max_capacity)
    RETURNING id
  `);
  return rowCount(res) > 0;
}

/** paid_count -= qty, guarded at floor (paid_count >= qty). */
export async function casDecrementAccessPaidCount(
  accessId: string,
  quantity: number,
  exec: DbExecutor = getDb(),
): Promise<boolean> {
  const res = await exec.execute(sql`
    UPDATE event_access
    SET paid_count = paid_count - ${quantity}
    WHERE id = ${accessId}
    AND paid_count >= ${quantity}
    RETURNING id
  `);
  return rowCount(res) > 0;
}

export async function getAccessCapacityInfo(
  accessId: string,
  exec: DbExecutor = getDb(),
): Promise<{ name: string; maxCapacity: number | null; paidCount: number } | null> {
  const rows = await exec
    .select({
      name: eventAccess.name,
      maxCapacity: eventAccess.maxCapacity,
      paidCount: eventAccess.paidCount,
    })
    .from(eventAccess)
    .where(eq(eventAccess.id, accessId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAccessRegisteredCount(
  accessId: string,
  exec: DbExecutor = getDb(),
): Promise<{ registeredCount: number } | null> {
  const rows = await exec
    .select({ registeredCount: eventAccess.registeredCount })
    .from(eventAccess)
    .where(eq(eventAccess.id, accessId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAccessPaidCount(
  accessId: string,
  exec: DbExecutor = getDb(),
): Promise<{ paidCount: number } | null> {
  const rows = await exec
    .select({ paidCount: eventAccess.paidCount })
    .from(eventAccess)
    .where(eq(eventAccess.id, accessId))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Capacity-reached / deactivation drop support
// ---------------------------------------------------------------------------

export async function getAccessCapacityRowsByIds(
  ids: string[],
  exec: DbExecutor = getDb(),
): Promise<{ id: string; name: string; maxCapacity: number | null; paidCount: number }[]> {
  if (ids.length === 0) return [];
  return exec
    .select({
      id: eventAccess.id,
      name: eventAccess.name,
      maxCapacity: eventAccess.maxCapacity,
      paidCount: eventAccess.paidCount,
    })
    .from(eventAccess)
    .where(inArray(eventAccess.id, ids));
}

/** Unsettled (not PAID/SPONSORED/WAIVED/REFUNDED) registrations holding `accessId`. */
export async function getUnsettledRegistrationsWithAccess(
  eventId: string,
  accessId: string,
  exec: DbExecutor = getDb(),
): Promise<RegistrationForAccessDrop[]> {
  const rows = await exec
    .select({
      id: registrations.id,
      email: registrations.email,
      firstName: registrations.firstName,
      lastName: registrations.lastName,
      accessTypeIds: registrations.accessTypeIds,
      droppedAccessIds: registrations.droppedAccessIds,
      totalAmount: registrations.totalAmount,
      accessAmount: registrations.accessAmount,
      sponsorshipAmount: registrations.sponsorshipAmount,
      priceBreakdown: registrations.priceBreakdown,
    })
    .from(registrations)
    .where(
      and(
        eq(registrations.eventId, eventId),
        sql`${registrations.paymentStatus} NOT IN ('PAID', 'SPONSORED', 'WAIVED', 'REFUNDED')`,
        sql`${accessId} = ANY(${registrations.accessTypeIds})`,
      ),
    );
  return rows;
}

/** All accessIds covered by sponsorships linked to a registration (optionally excluding one). */
export async function getRegistrationCoveredAccessIds(
  registrationId: string,
  exec: DbExecutor = getDb(),
  excludeSponsorshipId?: string,
): Promise<string[]> {
  const conds = [eq(sponsorshipUsages.registrationId, registrationId)];
  if (excludeSponsorshipId) {
    conds.push(sql`${sponsorshipUsages.sponsorshipId} <> ${excludeSponsorshipId}`);
  }
  const rows = await exec
    .select({ coveredAccessIds: sponsorships.coveredAccessIds })
    .from(sponsorshipUsages)
    .innerJoin(sponsorships, eq(sponsorships.id, sponsorshipUsages.sponsorshipId))
    .where(and(...conds));
  return rows.flatMap((r) => r.coveredAccessIds ?? []);
}

export async function updateRegistrationForAccessDrop(
  registrationId: string,
  data: Partial<typeof registrations.$inferInsert>,
  exec: DbExecutor = getDb(),
): Promise<void> {
  await exec.update(registrations).set(data).where(eq(registrations.id, registrationId));
}

export async function insertAccessAuditLog(
  values: typeof auditLogs.$inferInsert,
  exec: DbExecutor = getDb(),
): Promise<void> {
  await exec.insert(auditLogs).values(values);
}

// ---------------------------------------------------------------------------
// Outbox enqueue (triggered email).
// ponytail: minimal, self-contained enqueue for the PAYMENT_CONFIRMED trigger —
// the full outbox core (SAVEPOINT dedupe, claim/lease) is a separate wave
// (packages/db/src/outbox/). Dedupe here = a pre-insert lookup + a 23505 catch,
// which is behaviourally identical for this single call site. Swap for the outbox
// core's enqueueTriggeredEmailOutboxEvent when it lands.
// ---------------------------------------------------------------------------

export type TriggeredEmailOutboxPayload = {
  trigger: string;
  eventId: string;
  registration: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  };
};

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown })?.code === "23505";
}

/** Enqueue an `email.triggered` outbox event; idempotent per dedupeKey. Returns false if skipped. */
export async function enqueueTriggeredEmailOutbox(
  exec: DbExecutor,
  payload: TriggeredEmailOutboxPayload,
  dedupeKey: string,
): Promise<boolean> {
  const existing = await exec
    .select({ id: outboxEvents.id })
    .from(outboxEvents)
    .where(eq(outboxEvents.dedupeKey, dedupeKey))
    .limit(1);
  if (existing.length > 0) return false;

  try {
    await exec.insert(outboxEvents).values({
      type: "email.triggered",
      aggregateType: "Registration",
      aggregateId: payload.registration.id,
      eventId: payload.eventId,
      dedupeKey,
      payload: payload as unknown as Record<string, unknown>,
      maxAttempts: 5,
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}
