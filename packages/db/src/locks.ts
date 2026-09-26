import { and, asc, eq, inArray } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { DbExecutor } from "./client";
import { abstracts } from "./schema/abstracts";
import { eventAccess, events } from "./schema/events-access";
import { registrations } from "./schema/registrations";
import { sponsorships } from "./schema/sponsorships";
import { isTransactionExecutor } from "./txn";

// Row locks for the lock-first pattern (docs/adr/0001-concurrency-control.md).
//
// Take the locks at the start of the transaction (withLockingTxn), then re-read
// the locked rows and decide from what was read after the lock, never from a
// read made before it. Lock order across tables: event → sponsorships →
// registrations → abstracts; counters are CAS updates after that. Access rows
// hold the paid/registered counters, so an explicit access-row lock sits in
// the counter position: nothing else is locked after it.
//
// Each lock is a bare `SELECT id … FOR UPDATE` on one table. Never lock inside
// a joined read: `FOR UPDATE` on a join also locks the joined event and client
// rows, which serializes unrelated work and breaks the lock order. Several
// rows of one table are locked in one statement in ascending id order, so two
// transactions locking overlapping sets queue instead of deadlocking.

type Lockable = { table: PgTable; id: PgColumn };

const REGISTRATION: Lockable = { table: registrations, id: registrations.id };
const SPONSORSHIP: Lockable = { table: sponsorships, id: sponsorships.id };
const ABSTRACT: Lockable = { table: abstracts, id: abstracts.id };
const EVENT: Lockable = { table: events, id: events.id };
const EVENT_ACCESS: Lockable = { table: eventAccess, id: eventAccess.id };

function assertInTransaction(tx: DbExecutor, lock: string): void {
  if (!isTransactionExecutor(tx)) {
    throw new Error(`${lock} must run inside a transaction; a row lock outside one is released at once`);
  }
}

async function lockRowsForUpdate(
  tx: DbExecutor,
  target: Lockable,
  ids: readonly string[],
  lock: string,
): Promise<string[]> {
  assertInTransaction(tx, lock);
  const ordered = [...new Set(ids)].sort();
  if (ordered.length === 0) return [];
  const rows = await tx
    .select({ id: target.id })
    .from(target.table)
    .where(inArray(target.id, ordered))
    .orderBy(asc(target.id))
    .for("update");
  return rows.map((row) => row.id as string);
}

/** Lock one registration row. False when it does not exist. */
export async function lockRegistrationForUpdate(tx: DbExecutor, id: string): Promise<boolean> {
  return (await lockRowsForUpdate(tx, REGISTRATION, [id], "lockRegistrationForUpdate")).length === 1;
}

/** Lock registration rows in ascending id order. Returns the ids that exist, ascending. */
export async function lockRegistrationsForUpdate(tx: DbExecutor, ids: readonly string[]): Promise<string[]> {
  return lockRowsForUpdate(tx, REGISTRATION, ids, "lockRegistrationsForUpdate");
}

/** Lock one sponsorship row. False when it does not exist. */
export async function lockSponsorshipForUpdate(tx: DbExecutor, id: string): Promise<boolean> {
  return (await lockRowsForUpdate(tx, SPONSORSHIP, [id], "lockSponsorshipForUpdate")).length === 1;
}

/** Lock sponsorship rows in ascending id order. Returns the ids that exist, ascending. */
export async function lockSponsorshipsForUpdate(tx: DbExecutor, ids: readonly string[]): Promise<string[]> {
  return lockRowsForUpdate(tx, SPONSORSHIP, ids, "lockSponsorshipsForUpdate");
}

/**
 * Lock the event's sponsorship with this code. Returns its id, or null when
 * the event has no such code. The code is matched exactly as stored; callers
 * normalize it first.
 */
export async function lockSponsorshipByCodeForUpdate(
  tx: DbExecutor,
  eventId: string,
  code: string,
): Promise<string | null> {
  assertInTransaction(tx, "lockSponsorshipByCodeForUpdate");
  const [row] = await tx
    .select({ id: sponsorships.id })
    .from(sponsorships)
    .where(and(eq(sponsorships.eventId, eventId), eq(sponsorships.code, code)))
    .limit(1)
    .for("update");
  return row?.id ?? null;
}

/** Lock one abstract row. False when it does not exist. */
export async function lockAbstractForUpdate(tx: DbExecutor, id: string): Promise<boolean> {
  return (await lockRowsForUpdate(tx, ABSTRACT, [id], "lockAbstractForUpdate")).length === 1;
}

/** Lock abstract rows in ascending id order. Returns the ids that exist, ascending. */
export async function lockAbstractsForUpdate(tx: DbExecutor, ids: readonly string[]): Promise<string[]> {
  return lockRowsForUpdate(tx, ABSTRACT, ids, "lockAbstractsForUpdate");
}

/** Lock one event row, to serialize whole-event work. False when it does not exist. */
export async function lockEventForUpdate(tx: DbExecutor, id: string): Promise<boolean> {
  return (await lockRowsForUpdate(tx, EVENT, [id], "lockEventForUpdate")).length === 1;
}

/**
 * Lock access item rows in ascending id order. Returns the ids that exist,
 * ascending. The paid-count CAS waits on these locks, so a transaction that
 * holds them decides capacity from counts no payment can move until it ends.
 */
export async function lockEventAccessRowsForUpdate(tx: DbExecutor, ids: readonly string[]): Promise<string[]> {
  return lockRowsForUpdate(tx, EVENT_ACCESS, ids, "lockEventAccessRowsForUpdate");
}
