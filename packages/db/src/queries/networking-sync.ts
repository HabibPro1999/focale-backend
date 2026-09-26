import { and, asc, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { createLogger, newId } from "@app/shared";
import { getDb, type DbExecutor } from "../client";
import { enqueueOutboxEvent } from "../outbox";
import type { OutboxHandlerMeta, OutboxHandlerResult } from "../outbox/types";
import { networkingConfigs } from "../schema/networking";
import { registrations } from "../schema/registrations";
import { withLockingTxn } from "../txn";
import { syncNetworkingRegistration } from "./networking";

// Registration → networking projection off the registration transactions
// (plan 4.8). Registration, sponsorship and access writes only enqueue a
// `networking.registration.sync` outbox row (IDs only) in their own
// transaction; the worker re-projects the registration later, in its own
// serializable transaction, with the outbox's retries. A failing projection
// can no longer roll back a payment, and the payment transaction no longer
// holds networking rows.
//
// Re-projecting a whole event (POST /sync, or a config change that affects
// every profile) is a chunked continuation job: a chain of
// `networking.event.sync` outbox rows, each syncing one chunk of registrations
// in id order and enqueueing the next, with the run's progress on the event's
// networking_configs row (0035).

const logger = createLogger({ name: "db:networking-sync" });

export const NETWORKING_REGISTRATION_SYNC_OUTBOX_TYPE = "networking.registration.sync";
export const NETWORKING_EVENT_SYNC_OUTBOX_TYPE = "networking.event.sync";
/** Registrations per `networking.event.sync` row: a few seconds of work in one outbox run. */
export const NETWORKING_EVENT_SYNC_CHUNK_SIZE = 100;
const SYNC_MAX_ATTEMPTS = 10;
const SYNC_ERROR_MAX_LENGTH = 1_000;

/** The sync of one registration: `syncNetworkingRegistration` in production. */
export type NetworkingRegistrationSync = (registrationId: string) => Promise<{ created: number; updated: number }>;

export interface NetworkingRegistrationSyncPayload {
  registrationId: string;
}

export interface NetworkingEventSyncPayload {
  eventId: string;
  runId: string;
  /** Last registration id synced by this run before this chunk; null for the first chunk. */
  after: string | null;
}

export interface NetworkingRegistrationSyncTarget {
  registrationId: string;
  eventId: string;
}

/**
 * Enqueue the networking re-projection of these registrations (a change of
 * each), in the caller's transaction. Only events with a networking config
 * row get one: an event that never configured networking has no profile, and
 * its disabled default config creates none, so the sync would do nothing.
 * These rows are not keyed: a keyed outbox row is kept forever (retention
 * only compacts it), so a per-registration key would swallow every later
 * change. Returns the registration ids enqueued.
 */
export async function enqueueNetworkingRegistrationSyncs(
  tx: DbExecutor,
  targets: readonly NetworkingRegistrationSyncTarget[],
): Promise<string[]> {
  return enqueueConfigured(tx, targets);
}

/**
 * Enqueue the first projection of a registration just created, in the
 * caller's transaction (see enqueueNetworkingRegistrationSyncs). A
 * registration is created once, so this row is keyed per registration: at
 * most one ever exists. Returns whether a row was enqueued.
 */
export async function enqueueNetworkingRegistrationCreatedSync(
  tx: DbExecutor,
  target: NetworkingRegistrationSyncTarget,
): Promise<boolean> {
  const dedupeKey = `${NETWORKING_REGISTRATION_SYNC_OUTBOX_TYPE}:created:${target.registrationId}`;
  return (await enqueueConfigured(tx, [target], () => dedupeKey)).length > 0;
}

async function enqueueConfigured(
  tx: DbExecutor,
  targets: readonly NetworkingRegistrationSyncTarget[],
  dedupeKey?: (registrationId: string) => string,
): Promise<string[]> {
  const unique = new Map<string, string>();
  for (const target of targets) unique.set(target.registrationId, target.eventId);
  if (unique.size === 0) return [];
  const configured = new Set(
    (
      await tx
        .select({ eventId: networkingConfigs.eventId })
        .from(networkingConfigs)
        .where(inArray(networkingConfigs.eventId, [...new Set(unique.values())]))
    ).map((row) => row.eventId),
  );
  const enqueued: string[] = [];
  for (const [registrationId, eventId] of unique) {
    if (!configured.has(eventId)) continue;
    if (await enqueueRegistrationSync(tx, { registrationId, eventId }, dedupeKey?.(registrationId)))
      enqueued.push(registrationId);
  }
  return enqueued;
}

function enqueueRegistrationSync(
  exec: DbExecutor,
  target: NetworkingRegistrationSyncTarget,
  dedupeKey?: string,
): Promise<boolean> {
  const payload: NetworkingRegistrationSyncPayload = { registrationId: target.registrationId };
  return enqueueOutboxEvent(exec, {
    type: NETWORKING_REGISTRATION_SYNC_OUTBOX_TYPE,
    aggregateType: "Registration",
    aggregateId: target.registrationId,
    eventId: target.eventId,
    dedupeKey,
    payload,
    maxAttempts: SYNC_MAX_ATTEMPTS,
  });
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseRegistrationSync(payload: unknown): NetworkingRegistrationSyncPayload | null {
  const p = payload as Partial<NetworkingRegistrationSyncPayload> | null;
  return p && nonEmptyString(p.registrationId) ? { registrationId: p.registrationId } : null;
}

/**
 * Worker handler of `networking.registration.sync`: re-project the
 * registration as it is now (its own serializable transaction, retried on
 * serialization failures). The sync reads the current rows, so a delivery run
 * after several changes projects the latest, and running it again changes
 * nothing more; the 4.4b and 4.6 rules live in it (a withdrawn or erased
 * profile is never re-projected; activation follows the eligibility policy).
 * A throw is retried by the outbox with backoff, then dead-lettered.
 */
export async function handleNetworkingRegistrationSyncOutbox(
  payload: unknown,
  _meta?: OutboxHandlerMeta,
  sync: NetworkingRegistrationSync = syncNetworkingRegistration,
): Promise<OutboxHandlerResult> {
  const job = parseRegistrationSync(payload);
  if (!job) {
    logger.warn({ payload }, "networking.registration.sync skipped: malformed payload");
    return "skipped";
  }
  const result = await sync(job.registrationId);
  return result.created + result.updated > 0 ? "processed" : "skipped";
}

// ---------------------------------------------------------------------------
// Full-event sync
// ---------------------------------------------------------------------------

export type NetworkingEventSyncStatus = "IDLE" | "RUNNING" | "COMPLETED";

/** The event's latest full sync, as GET/POST /sync return it. */
export interface NetworkingEventSyncState {
  runId: string | null;
  /** IDLE: never requested (or networking was never configured). */
  status: NetworkingEventSyncStatus;
  /** Registrations of the event when the run was requested. */
  total: number;
  /** Registrations synced so far (including those that failed and were handed off). */
  processed: number;
  created: number;
  updated: number;
  /** Registrations whose sync failed in the run; each is retried on its own. */
  failed: number;
  requestedAt: Date | null;
  finishedAt: Date | null;
  /** The last chunk failure while the run is retried; cleared by progress. */
  lastError: string | null;
}

const c = networkingConfigs;
const stateColumns = {
  runId: c.syncRunId,
  status: c.syncStatus,
  total: c.syncTotal,
  processed: c.syncProcessed,
  created: c.syncCreated,
  updated: c.syncUpdated,
  failed: c.syncFailed,
  requestedAt: c.syncRequestedAt,
  finishedAt: c.syncFinishedAt,
  lastError: c.syncError,
};
type StateRow = { [K in keyof typeof stateColumns]: (typeof stateColumns)[K]["_"]["data"] | null };

// Sync progress is not a configuration change: keep the row's updated_at,
// which is the config revision the admin saves against.
const keepConfigRevision = { updatedAt: sql`${c.updatedAt}` };

const IDLE_STATE: NetworkingEventSyncState = {
  runId: null,
  status: "IDLE",
  total: 0,
  processed: 0,
  created: 0,
  updated: 0,
  failed: 0,
  requestedAt: null,
  finishedAt: null,
  lastError: null,
};

function toState(row: StateRow | undefined): NetworkingEventSyncState {
  if (!row?.status) return { ...IDLE_STATE };
  return {
    runId: row.runId ?? null,
    status: row.status,
    total: Number(row.total ?? 0),
    processed: Number(row.processed ?? 0),
    created: Number(row.created ?? 0),
    updated: Number(row.updated ?? 0),
    failed: Number(row.failed ?? 0),
    requestedAt: row.requestedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    lastError: row.lastError ?? null,
  };
}

/** The event's latest full sync (IDLE when none was requested). */
export async function getNetworkingEventSyncState(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<NetworkingEventSyncState> {
  const [row] = await db.select(stateColumns).from(c).where(eq(c.eventId, eventId));
  return toState(row);
}

/**
 * Start a full sync of the event's registrations: a new run replaces any run
 * in progress (its next chunk is then skipped), so every registration is
 * projected with the config as of this request. Returns the new run's state;
 * IDLE, with nothing enqueued, when the event has no networking config (no
 * profile exists and the default config creates none).
 */
export async function requestNetworkingEventSync(
  eventId: string,
  db?: DbExecutor,
): Promise<NetworkingEventSyncState> {
  if (!db) return withLockingTxn((tx) => requestNetworkingEventSync(eventId, tx));
  const [count] = await db
    .select({ total: sql<number | string>`count(*)` })
    .from(registrations)
    .where(eq(registrations.eventId, eventId));
  const runId = newId();
  const [row] = await db
    .update(c)
    .set({
      syncRunId: runId,
      syncStatus: "RUNNING",
      syncCursor: null,
      syncTotal: Number(count?.total ?? 0),
      syncProcessed: 0,
      syncCreated: 0,
      syncUpdated: 0,
      syncFailed: 0,
      syncRequestedAt: new Date(),
      syncFinishedAt: null,
      syncError: null,
      ...keepConfigRevision,
    })
    .where(eq(c.eventId, eventId))
    .returning(stateColumns);
  if (!row) return { ...IDLE_STATE };
  await enqueueEventSyncChunk(db, { eventId, runId, after: null });
  return toState(row);
}

function enqueueEventSyncChunk(exec: DbExecutor, payload: NetworkingEventSyncPayload): Promise<boolean> {
  return enqueueOutboxEvent(exec, {
    type: NETWORKING_EVENT_SYNC_OUTBOX_TYPE,
    aggregateType: "NetworkingEvent",
    aggregateId: payload.eventId,
    eventId: payload.eventId,
    payload,
    maxAttempts: SYNC_MAX_ATTEMPTS,
  });
}

function parseEventSync(payload: unknown): NetworkingEventSyncPayload | null {
  const p = payload as Partial<NetworkingEventSyncPayload> | null;
  if (!p || !nonEmptyString(p.eventId) || !nonEmptyString(p.runId)) return null;
  if (p.after !== null && !nonEmptyString(p.after)) return null;
  return { eventId: p.eventId, runId: p.runId, after: p.after };
}

/** The run's row, still at this chunk: same run, running, cursor where the chunk starts. */
function atChunk(job: NetworkingEventSyncPayload): SQL {
  return and(
    eq(c.eventId, job.eventId),
    eq(c.syncRunId, job.runId),
    eq(c.syncStatus, "RUNNING"),
    job.after === null ? isNull(c.syncCursor) : eq(c.syncCursor, job.after),
  )!;
}

export interface NetworkingEventSyncOptions {
  chunkSize?: number;
  sync?: NetworkingRegistrationSync;
}

/**
 * Worker handler of `networking.event.sync`: sync the next chunk of the
 * event's registrations (ascending id after the cursor), then, in one
 * transaction, advance the run (compare-and-set on run id and cursor) and
 * enqueue the next chunk, or mark the run COMPLETED after a short chunk.
 *
 * - A row of a superseded or finished run, or a redelivered chunk the cursor
 *   has already passed, is skipped.
 * - A registration whose sync throws is counted as failed and handed to its
 *   own `networking.registration.sync` row, so one bad registration never
 *   blocks the run.
 * - Anything else (the database) throws: the outbox retries the chunk, which
 *   is safe because syncing a registration twice changes nothing more; the
 *   error is recorded on the run meanwhile.
 * - On the job signal (timeout, shutdown) the chunk stops early and the next
 *   row resumes after the last registration synced.
 *
 * A registration created after the run passed its id is not missed: its
 * creation enqueued its own sync.
 */
export async function handleNetworkingEventSyncOutbox(
  payload: unknown,
  meta?: OutboxHandlerMeta,
  options: NetworkingEventSyncOptions = {},
): Promise<OutboxHandlerResult> {
  const job = parseEventSync(payload);
  if (!job) {
    logger.warn({ payload }, "networking.event.sync skipped: malformed payload");
    return "skipped";
  }
  const chunkSize = options.chunkSize ?? NETWORKING_EVENT_SYNC_CHUNK_SIZE;
  const sync = options.sync ?? syncNetworkingRegistration;
  const db = getDb();
  const [current] = await db.select({ eventId: c.eventId }).from(c).where(atChunk(job));
  if (!current) return "skipped";
  try {
    const ids = (
      await db
        .select({ id: registrations.id })
        .from(registrations)
        .where(
          and(
            eq(registrations.eventId, job.eventId),
            job.after === null ? undefined : gt(registrations.id, job.after),
          ),
        )
        .orderBy(asc(registrations.id))
        .limit(chunkSize)
    ).map((row) => row.id);
    const tally = { processed: 0, created: 0, updated: 0, failed: 0 };
    let last = job.after;
    let interrupted = false;
    for (const id of ids) {
      if (meta?.signal?.aborted) {
        interrupted = true;
        break;
      }
      try {
        const result = await sync(id);
        tally.created += result.created;
        tally.updated += result.updated;
      } catch (err) {
        tally.failed++;
        logger.warn(
          { err, eventId: job.eventId, registrationId: id },
          "networking sync of a registration failed in the event sync; retried on its own",
        );
        await enqueueRegistrationSync(db, { registrationId: id, eventId: job.eventId });
      }
      tally.processed++;
      last = id;
    }
    const done = !interrupted && ids.length < chunkSize;
    const advanced = await withLockingTxn(async (tx) => {
      const rows = await tx
        .update(c)
        .set({
          syncCursor: last,
          syncProcessed: sql`${c.syncProcessed} + ${tally.processed}`,
          syncCreated: sql`${c.syncCreated} + ${tally.created}`,
          syncUpdated: sql`${c.syncUpdated} + ${tally.updated}`,
          syncFailed: sql`${c.syncFailed} + ${tally.failed}`,
          syncError: null,
          ...(done ? { syncStatus: "COMPLETED" as const, syncFinishedAt: new Date() } : {}),
          ...keepConfigRevision,
        })
        .where(atChunk(job))
        .returning({ eventId: c.eventId });
      if (rows.length === 0) return false;
      if (!done) await enqueueEventSyncChunk(tx, { eventId: job.eventId, runId: job.runId, after: last });
      return true;
    });
    if (!advanced) return "skipped";
    if (done) logger.info({ eventId: job.eventId, runId: job.runId }, "networking event sync completed");
    return "processed";
  } catch (err) {
    await recordEventSyncError(job, err);
    throw err;
  }
}

async function recordEventSyncError(job: NetworkingEventSyncPayload, err: unknown): Promise<void> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, SYNC_ERROR_MAX_LENGTH);
  try {
    await getDb()
      .update(c)
      .set({ syncError: message, ...keepConfigRevision })
      .where(atChunk(job));
  } catch (recordErr) {
    logger.warn({ err: recordErr, eventId: job.eventId }, "could not record the networking event sync error");
  }
}
