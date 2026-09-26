import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
import {
  NETWORKING_EVENT_SYNC_OUTBOX_TYPE,
  NETWORKING_REGISTRATION_SYNC_OUTBOX_TYPE,
  enqueueNetworkingRegistrationCreatedSync,
  enqueueNetworkingRegistrationSyncs,
  getDb,
  getNetworkingEventSyncState,
  handleNetworkingEventSyncOutbox,
  handleNetworkingRegistrationSyncOutbox,
  networkingConfigs,
  networkingNotifications,
  networkingProfiles,
  outboxEvents,
  processOutboxEvents,
  registrations,
  requestNetworkingEventSync,
  syncNetworkingRegistration,
  withTxn,
  type NetworkingEventSyncPayload,
  type NetworkingRegistrationSync,
  type OutboxHandlerRegistry,
} from "../../../src";
import { cleanupDatabase } from "../../helpers/cleanup";
import { seedEvent, seedForm, seedRegistration } from "../../helpers/factories";
import { dbTestsEnabled } from "../../helpers/test-env";

// Plan 4.8: registration writes enqueue `networking.registration.sync` rows
// instead of projecting in their transaction; the worker runs the sync with
// the outbox's retries. A full-event sync is a chain of `networking.event.sync`
// rows, one chunk of registrations each, with its progress on the config row.

async function scenario(options: { configured?: boolean; registrations?: number } = {}) {
  const event = await seedEvent();
  const form = await seedForm({ eventId: event.id });
  if (options.configured !== false)
    await getDb()
      .insert(networkingConfigs)
      .values({
        eventId: event.id,
        config: NetworkingConfigSchema.parse({ enabled: true, approvalMode: "AUTOMATIC", meetingsEnabled: false }),
      });
  const regs = [];
  for (let i = 0; i < (options.registrations ?? 1); i++)
    regs.push(
      await seedRegistration({
        eventId: event.id,
        formId: form.id,
        paymentStatus: "PAID",
        networkingOptIn: true,
        firstName: `First ${i}`,
      }),
    );
  return { event, form, registrations: regs };
}

function registry(options: { sync?: NetworkingRegistrationSync; chunkSize?: number } = {}): OutboxHandlerRegistry {
  return {
    [NETWORKING_REGISTRATION_SYNC_OUTBOX_TYPE]: (payload, meta) =>
      handleNetworkingRegistrationSyncOutbox(payload, meta, options.sync),
    [NETWORKING_EVENT_SYNC_OUTBOX_TYPE]: (payload, meta) =>
      handleNetworkingEventSyncOutbox(payload, meta, { chunkSize: options.chunkSize, sync: options.sync }),
  };
}

async function outboxOfType(type: string) {
  return getDb().select().from(outboxEvents).where(eq(outboxEvents.type, type)).orderBy(outboxEvents.createdAt);
}

const SYNC_TYPES: string[] = [NETWORKING_REGISTRATION_SYNC_OUTBOX_TYPE, NETWORKING_EVENT_SYNC_OUTBOX_TYPE];

/** Sync rows the worker would claim now (networking.notify rows belong to the api's realtime pump). */
async function dueRows() {
  const rows = await getDb().select().from(outboxEvents);
  return rows.filter(
    (row) =>
      SYNC_TYPES.includes(row.type) &&
      (row.status === "PENDING" || row.status === "FAILED") &&
      (row.nextAttemptAt === null || row.nextAttemptAt.getTime() <= Date.now()),
  );
}

/**
 * Worker passes until no row is due. On CockroachDB the claim's SKIP LOCKED
 * can transiently miss rows just committed (cockroachdb/cockroach#167582); a
 * later pass gets them, as the next worker tick would.
 */
async function drain(handlers: OutboxHandlerRegistry, batchSize = 20) {
  const totals = { processed: 0, skipped: 0, failed: 0 };
  await vi.waitFor(
    async () => {
      const result = await processOutboxEvents(batchSize, { workerId: "networking-sync-test", scope: "background", handlers });
      totals.processed += result.processed;
      totals.skipped += result.skipped;
      totals.failed += result.failed;
      expect(await dueRows()).toEqual([]);
    },
    { timeout: 15_000, interval: 50 },
  );
  return totals;
}

/** Exactly one worker claim of the oldest due row. */
async function step(handlers: OutboxHandlerRegistry) {
  let result = { processed: 0, skipped: 0, failed: 0 };
  await vi.waitFor(
    async () => {
      const r = await processOutboxEvents(1, { workerId: "networking-sync-test", scope: "background", handlers });
      result = { processed: r.processed, skipped: r.skipped, failed: r.failed };
      expect(r.processed + r.skipped + r.failed).toBe(1);
    },
    { timeout: 10_000, interval: 50 },
  );
  return result;
}

async function profileOf(registrationId: string) {
  const rows = await getDb()
    .select()
    .from(networkingProfiles)
    .where(eq(networkingProfiles.registrationId, registrationId));
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0] ?? null;
}

async function profileCount(eventId: string) {
  const rows = await getDb().select({ id: networkingProfiles.id }).from(networkingProfiles).where(eq(networkingProfiles.eventId, eventId));
  return rows.length;
}

/** A registration change as a registration write makes it: the row, and its sync enqueued in the same transaction. */
async function editRegistration(registration: { id: string; eventId: string }, firstName: string) {
  await withTxn(async (tx) => {
    await tx.update(registrations).set({ firstName }).where(eq(registrations.id, registration.id));
    await enqueueNetworkingRegistrationSyncs(tx, [{ registrationId: registration.id, eventId: registration.eventId }]);
  });
}

async function configRevision(eventId: string) {
  const [row] = await getDb().select({ updatedAt: networkingConfigs.updatedAt }).from(networkingConfigs).where(eq(networkingConfigs.eventId, eventId));
  return row?.updatedAt.toISOString();
}

describe.runIf(dbTestsEnabled())("db tier: networking registration sync through the outbox (4.8)", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("enqueues IDs only, only for events with a networking config; the creation's row at most once", async () => {
    const configured = await scenario();
    const bare = await scenario({ configured: false });
    const reg = configured.registrations[0]!;
    const other = bare.registrations[0]!;

    const result = await withTxn(async (tx) => ({
      changes: await enqueueNetworkingRegistrationSyncs(tx, [
        { registrationId: reg.id, eventId: reg.eventId },
        { registrationId: reg.id, eventId: reg.eventId },
        { registrationId: other.id, eventId: other.eventId },
      ]),
      created: await enqueueNetworkingRegistrationCreatedSync(tx, { registrationId: reg.id, eventId: reg.eventId }),
      createdAgain: await enqueueNetworkingRegistrationCreatedSync(tx, { registrationId: reg.id, eventId: reg.eventId }),
      bareCreated: await enqueueNetworkingRegistrationCreatedSync(tx, { registrationId: other.id, eventId: other.eventId }),
    }));

    expect(result).toEqual({ changes: [reg.id], created: true, createdAgain: false, bareCreated: false });
    const rows = await outboxOfType(NETWORKING_REGISTRATION_SYNC_OUTBOX_TYPE);
    expect(rows.map((row) => row.dedupeKey).sort()).toEqual([null, `networking.registration.sync:created:${reg.id}`].sort());
    for (const row of rows) {
      expect(row.payload).toEqual({ registrationId: reg.id });
      expect(row).toMatchObject({ eventId: reg.eventId, aggregateId: reg.id, status: "PENDING", maxAttempts: 10 });
    }
  });

  it("retries a failed sync with backoff, then projects once; delivering it again changes nothing", async () => {
    const s = await scenario();
    const reg = s.registrations[0]!;
    await editRegistration(reg, "Ada");

    let calls = 0;
    const flaky: NetworkingRegistrationSync = async (id) => {
      calls++;
      if (calls === 1) throw new Error("networking projection unavailable");
      return syncNetworkingRegistration(id);
    };

    expect(await step(registry({ sync: flaky }))).toEqual({ processed: 0, skipped: 0, failed: 1 });
    let [row] = await outboxOfType(NETWORKING_REGISTRATION_SYNC_OUTBOX_TYPE);
    expect(row).toMatchObject({ status: "FAILED", attemptCount: 1, errorMessage: "networking projection unavailable" });
    expect(row!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await profileOf(reg.id)).toBeNull();

    // The backoff elapses.
    await getDb().update(outboxEvents).set({ nextAttemptAt: null }).where(eq(outboxEvents.id, row!.id));
    expect(await step(registry({ sync: flaky }))).toEqual({ processed: 1, skipped: 0, failed: 0 });
    [row] = await outboxOfType(NETWORKING_REGISTRATION_SYNC_OUTBOX_TYPE);
    expect(row).toMatchObject({ status: "PROCESSED", attemptCount: 2 });
    const profile = await profileOf(reg.id);
    expect(profile).toMatchObject({ firstName: "Ada", status: "ACTIVE", consent: true });

    // A redelivery (or a second row for the same state) is idempotent.
    await handleNetworkingRegistrationSyncOutbox({ registrationId: reg.id }, { id: row!.id });
    await editRegistration(reg, "Ada");
    await drain(registry());
    expect(await profileOf(reg.id)).toMatchObject({ id: profile!.id, firstName: "Ada", status: "ACTIVE" });
    expect(await profileCount(s.event.id)).toBe(1);
    const approvals = await getDb()
      .select({ id: networkingNotifications.id })
      .from(networkingNotifications)
      .where(and(eq(networkingNotifications.profileId, profile!.id), eq(networkingNotifications.type, "APPROVAL")));
    expect(approvals).toHaveLength(1);
  });

  it("ends with the latest data after a quick second edit, whichever way the deliveries fall", async () => {
    const s = await scenario({ registrations: 2 });
    const [a, b] = s.registrations as [(typeof s.registrations)[0], (typeof s.registrations)[0]];

    // Both edits commit before the worker runs: each delivery reads the registration as it is now.
    await editRegistration(a, "First edit");
    await editRegistration(a, "Second edit");
    expect((await outboxOfType(NETWORKING_REGISTRATION_SYNC_OUTBOX_TYPE)).length).toBe(2);
    await drain(registry());
    expect(await profileOf(a.id)).toMatchObject({ firstName: "Second edit" });

    // The first delivery runs between the edits: the second edit's own row re-projects it.
    await editRegistration(b, "First edit");
    await drain(registry());
    expect(await profileOf(b.id)).toMatchObject({ firstName: "First edit" });
    await editRegistration(b, "Second edit");
    await drain(registry());
    expect(await profileOf(b.id)).toMatchObject({ firstName: "Second edit" });
  });

  it("never re-projects a withdrawn profile (4.4b)", async () => {
    const s = await scenario();
    const reg = s.registrations[0]!;
    await syncNetworkingRegistration(reg.id);
    await getDb()
      .update(networkingProfiles)
      .set({ withdrawnAt: new Date() })
      .where(eq(networkingProfiles.registrationId, reg.id));
    await editRegistration(reg, "Changed after withdrawal");
    expect(await drain(registry())).toMatchObject({ processed: 0, skipped: 1, failed: 0 });
    expect(await profileOf(reg.id)).toMatchObject({ firstName: "First 0" });
  });

  it("syncs a whole event in chunks, resuming from the cursor; a stale redelivery is skipped", async () => {
    const s = await scenario({ registrations: 5 });
    const handlers = registry({ chunkSize: 2 });
    const revision = await configRevision(s.event.id);

    const requested = await requestNetworkingEventSync(s.event.id);
    expect(requested).toMatchObject({ status: "RUNNING", total: 5, processed: 0, finishedAt: null });
    const [first] = await outboxOfType(NETWORKING_EVENT_SYNC_OUTBOX_TYPE);
    expect(first!.payload).toEqual({ eventId: s.event.id, runId: requested.runId, after: null });

    expect(await step(handlers)).toMatchObject({ processed: 1 });
    expect(await getNetworkingEventSyncState(s.event.id)).toMatchObject({ status: "RUNNING", processed: 2, created: 2 });
    expect(await profileCount(s.event.id)).toBe(2);

    // The first chunk delivered again (a lost lease) finds the cursor moved on.
    expect(await handleNetworkingEventSyncOutbox(first!.payload, { id: first!.id }, { chunkSize: 2 })).toBe("skipped");
    expect(await getNetworkingEventSyncState(s.event.id)).toMatchObject({ processed: 2 });

    // Each chunk enqueued the next one, resuming after the last registration synced.
    const chain = await outboxOfType(NETWORKING_EVENT_SYNC_OUTBOX_TYPE);
    expect(chain).toHaveLength(2);
    const second = chain[1]!.payload as NetworkingEventSyncPayload;
    expect(second.runId).toBe(requested.runId);
    expect(second.after).not.toBeNull();

    expect(await step(handlers)).toMatchObject({ processed: 1 });
    expect(await getNetworkingEventSyncState(s.event.id)).toMatchObject({ status: "RUNNING", processed: 4 });
    expect(await step(handlers)).toMatchObject({ processed: 1 });
    const done = await getNetworkingEventSyncState(s.event.id);
    expect(done).toMatchObject({ status: "COMPLETED", total: 5, processed: 5, created: 5, updated: 0, failed: 0, lastError: null });
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(await dueRows()).toEqual([]);
    expect(await profileCount(s.event.id)).toBe(5);
    // Progress never moves the config revision the admin saves against.
    expect(await configRevision(s.event.id)).toBe(revision);

    // A second run updates the same profiles.
    await requestNetworkingEventSync(s.event.id);
    await drain(handlers);
    expect(await getNetworkingEventSyncState(s.event.id)).toMatchObject({ status: "COMPLETED", processed: 5, created: 0, updated: 5 });
  });

  it("a new request supersedes the run in progress; a failing registration is handed to its own row", async () => {
    const s = await scenario({ registrations: 3 });
    let failedId: string | null = null;
    const failsOnce: NetworkingRegistrationSync = async (id) => {
      if (failedId === null) {
        failedId = id;
        throw new Error("one registration failed");
      }
      return syncNetworkingRegistration(id);
    };

    const run1 = await requestNetworkingEventSync(s.event.id);
    expect(await step(registry({ chunkSize: 2, sync: failsOnce }))).toMatchObject({ processed: 1 });
    expect(await getNetworkingEventSyncState(s.event.id)).toMatchObject({ runId: run1.runId, processed: 2, created: 1, failed: 1 });
    const handedOff = await outboxOfType(NETWORKING_REGISTRATION_SYNC_OUTBOX_TYPE);
    expect(handedOff.map((row) => row.payload)).toEqual([{ registrationId: failedId }]);

    const run2 = await requestNetworkingEventSync(s.event.id);
    expect(run2.runId).not.toBe(run1.runId);
    expect(run2).toMatchObject({ status: "RUNNING", total: 3, processed: 0, failed: 0 });

    const totals = await drain(registry({ chunkSize: 2 }));
    // run1's pending chunk is skipped; run2's two chunks and the handed-off registration run.
    expect(totals.skipped).toBeGreaterThanOrEqual(1);
    expect(await getNetworkingEventSyncState(s.event.id)).toMatchObject({
      runId: run2.runId,
      status: "COMPLETED",
      processed: 3,
      failed: 0,
    });
    expect(await profileCount(s.event.id)).toBe(3);
  });

  it("reports IDLE and enqueues nothing for an event without a networking config", async () => {
    const s = await scenario({ configured: false });
    expect(await getNetworkingEventSyncState(s.event.id)).toMatchObject({ status: "IDLE", runId: null });
    expect(await requestNetworkingEventSync(s.event.id)).toMatchObject({ status: "IDLE", runId: null, total: 0 });
    expect(await outboxOfType(NETWORKING_EVENT_SYNC_OUTBOX_TYPE)).toEqual([]);
    // No config row is created for it.
    expect(await getDb().select().from(networkingConfigs).where(eq(networkingConfigs.eventId, s.event.id))).toEqual([]);
  });
});
