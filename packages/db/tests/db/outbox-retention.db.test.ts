import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, inArray } from "drizzle-orm";
import {
  enqueueOutboxEvent,
  findDeadLetteredOutboxEvents,
  getDb,
  getOutboxHealth,
  outboxEvents,
  requeueDeadLetteredOutboxEvents,
  runOutboxRetention,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";

// 3.5: outbox retention, dead-letter health and requeue against a migrated
// database (both engines in CI).

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface SeedRow {
  key: string;
  type?: string;
  status: string;
  ageMs: number;
  dedupeKey?: string;
  /** updated_at age (defaults to the created_at age). */
  updatedAgeMs?: number;
}

async function seed(rows: SeedRow[]): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const row of rows) {
    const createdAt = new Date(Date.now() - row.ageMs);
    const [inserted] = await getDb()
      .insert(outboxEvents)
      .values({
        type: row.type ?? "email.triggered",
        status: row.status,
        dedupeKey: row.dedupeKey ?? null,
        payload: { seed: row.key },
        createdAt,
        updatedAt: new Date(Date.now() - (row.updatedAgeMs ?? row.ageMs)),
        processedAt: row.status === "PROCESSED" || row.status === "SKIPPED" ? createdAt : null,
        attemptCount: row.status === "DEAD_LETTERED" ? 5 : 1,
      })
      .returning({ id: outboxEvents.id });
    ids[row.key] = inserted!.id;
  }
  return ids;
}

async function remaining(): Promise<Array<{ id: string; payload: unknown }>> {
  return getDb()
    .select({ id: outboxEvents.id, payload: outboxEvents.payload })
    .from(outboxEvents)
    .orderBy(asc(outboxEvents.id));
}

/**
 * Run retention until the expected rows are gone. On CockroachDB, SKIP LOCKED
 * can transiently skip rows just written by a committed transaction
 * (cockroachdb/cockroach#167582); a later pass gets them, as the next hourly
 * run would in production.
 */
async function retainUntil(done: () => Promise<boolean>, batchSize: number) {
  const totals = { realtimeDeleted: 0, backgroundDeleted: 0, compacted: 0 };
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await runOutboxRetention({ batchSize });
    totals.realtimeDeleted += result.realtimeDeleted;
    totals.backgroundDeleted += result.backgroundDeleted;
    totals.compacted += result.compacted;
    if (await done()) return totals;
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  throw new Error("retention did not converge");
}

describe.runIf(dbTestsEnabled())("db tier: outbox retention", () => {
  beforeEach(async () => {
    await getDb().delete(outboxEvents);
  });
  afterEach(async () => {
    await getDb().delete(outboxEvents);
  });

  it("deletes old realtime and finished unkeyed background rows, compacts keyed rows, keeps the rest", async () => {
    const ids = await seed([
      { key: "rtOldDone", type: "realtime.emit", status: "PROCESSED", ageMs: 25 * HOUR },
      { key: "rtOldPending", type: "realtime.emit", status: "PENDING", ageMs: 25 * HOUR },
      { key: "rtOldDead", type: "realtime.emit", status: "DEAD_LETTERED", ageMs: 30 * HOUR },
      { key: "rtOldLeased", type: "realtime.emit", status: "PROCESSING", ageMs: 25 * HOUR },
      { key: "rtRecent", type: "realtime.emit", status: "PROCESSED", ageMs: 23 * HOUR },
      // 4.3: networking participant notices (IDs only) expire like realtime events.
      { key: "nnOldDone", type: "networking.notify", status: "PROCESSED", ageMs: 25 * HOUR },
      { key: "nnOldPending", type: "networking.notify", status: "PENDING", ageMs: 26 * HOUR },
      { key: "nnRecent", type: "networking.notify", status: "PENDING", ageMs: 1 * HOUR },
      { key: "bgOldDone", status: "PROCESSED", ageMs: 31 * DAY },
      { key: "bgOldSkipped", status: "SKIPPED", ageMs: 31 * DAY },
      { key: "bgOldDone2", type: "email.abstract", status: "PROCESSED", ageMs: 40 * DAY },
      { key: "bgOldDead", status: "DEAD_LETTERED", ageMs: 31 * DAY },
      { key: "bgOldFailed", status: "FAILED", ageMs: 31 * DAY },
      { key: "bgRecent", status: "PROCESSED", ageMs: 29 * DAY },
      { key: "keyedOld", status: "PROCESSED", ageMs: 31 * DAY, dedupeKey: "keyed-old" },
      { key: "keyedOldSkipped", status: "SKIPPED", ageMs: 45 * DAY, dedupeKey: "keyed-old-skipped" },
      { key: "keyedOldDead", status: "DEAD_LETTERED", ageMs: 31 * DAY, dedupeKey: "keyed-old-dead" },
      { key: "keyedRecent", status: "PROCESSED", ageMs: 1 * DAY, dedupeKey: "keyed-recent" },
    ]);
    const deleted = ["rtOldDone", "rtOldPending", "rtOldDead", "nnOldDone", "nnOldPending", "bgOldDone", "bgOldSkipped", "bgOldDone2"];
    const compacted = ["keyedOld", "keyedOldSkipped"];

    const expectedIds = Object.entries(ids)
      .filter(([key]) => !deleted.includes(key))
      .map(([, id]) => id)
      .sort();
    const compactedIds = new Set(compacted.map((key) => ids[key]));
    const settled = async () => {
      const rows = await remaining();
      if (JSON.stringify(rows.map((r) => r.id).sort()) !== JSON.stringify(expectedIds)) return false;
      return rows.every((r) => !compactedIds.has(r.id) || JSON.stringify(r.payload) === "{}");
    };
    // Batches of 2 so every step runs more than one batch.
    const totals = await retainUntil(settled, 2);
    expect(totals).toEqual({ realtimeDeleted: 5, backgroundDeleted: 3, compacted: 2 });

    const byId = new Map((await remaining()).map((r) => [r.id, r.payload]));
    for (const key of ["rtOldLeased", "rtRecent", "nnRecent", "bgOldDead", "bgOldFailed", "bgRecent", "keyedOldDead", "keyedRecent"]) {
      expect(byId.get(ids[key]!), key).toEqual({ seed: key });
    }
    for (const key of compacted) expect(byId.get(ids[key]!), key).toEqual({});

    // A compacted key still rejects a duplicate enqueue.
    await expect(
      enqueueOutboxEvent(getDb(), { type: "email.triggered", dedupeKey: "keyed-old", payload: {} }),
    ).resolves.toBe(false);
    // A second pass has nothing left to do.
    await expect(runOutboxRetention({ batchSize: 2 })).resolves.toEqual({
      realtimeDeleted: 0,
      backgroundDeleted: 0,
      compacted: 0,
    });
  });

  it("flags only dead letters written in the last 24 h", async () => {
    await seed([{ key: "old", status: "DEAD_LETTERED", ageMs: 3 * DAY, updatedAgeMs: 2 * DAY }]);
    let health = await getOutboxHealth();
    expect(health.counts).toMatchObject({ deadLettered: 1, deadLetteredLast24h: 0 });
    expect(health.isHealthy).toBe(true);

    await seed([{ key: "recent", status: "DEAD_LETTERED", ageMs: 2 * DAY, updatedAgeMs: 1 * HOUR }]);
    health = await getOutboxHealth();
    expect(health.counts).toMatchObject({ deadLettered: 2, deadLetteredLast24h: 1 });
    expect(health.isHealthy).toBe(false);
  });

  it("lists and requeues dead letters, never realtime ones", async () => {
    const ids = await seed([
      { key: "a", status: "DEAD_LETTERED", ageMs: 3 * DAY, updatedAgeMs: 2 * DAY },
      { key: "b", type: "email.abstract", status: "DEAD_LETTERED", ageMs: 2 * DAY, updatedAgeMs: 1 * HOUR },
      { key: "rt", type: "realtime.emit", status: "DEAD_LETTERED", ageMs: 2 * HOUR },
      { key: "nn", type: "networking.notify", status: "DEAD_LETTERED", ageMs: 2 * HOUR },
      { key: "done", status: "PROCESSED", ageMs: 2 * HOUR },
    ]);

    const all = await findDeadLetteredOutboxEvents({ limit: 10 });
    expect(all.map((row) => row.id)).toEqual([ids.a, ids.b]);
    expect(all[0]!.deadLetteredAt.getTime()).toBeLessThan(all[1]!.deadLetteredAt.getTime());
    expect((await findDeadLetteredOutboxEvents({ limit: 10, type: "email.abstract" })).map((r) => r.id)).toEqual([ids.b]);
    expect(
      (await findDeadLetteredOutboxEvents({ limit: 10, since: new Date(Date.now() - DAY) })).map((r) => r.id),
    ).toEqual([ids.b]);
    expect((await findDeadLetteredOutboxEvents({ limit: 1 })).map((r) => r.id)).toEqual([ids.a]);

    await expect(requeueDeadLetteredOutboxEvents([ids.a!, ids.rt!, ids.nn!, ids.done!])).resolves.toBe(1);
    const rows = await getDb()
      .select({ id: outboxEvents.id, status: outboxEvents.status, attemptCount: outboxEvents.attemptCount, nextAttemptAt: outboxEvents.nextAttemptAt })
      .from(outboxEvents)
      .where(inArray(outboxEvents.id, [ids.a!, ids.rt!, ids.nn!, ids.done!]));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(ids.a!)).toMatchObject({ status: "PENDING", attemptCount: 0, nextAttemptAt: null });
    expect(byId.get(ids.rt!)).toMatchObject({ status: "DEAD_LETTERED" });
    expect(byId.get(ids.nn!)).toMatchObject({ status: "DEAD_LETTERED" });
    expect(byId.get(ids.done!)).toMatchObject({ status: "PROCESSED" });

    // Already requeued: nothing changes the second time.
    await expect(requeueDeadLetteredOutboxEvents([ids.a!])).resolves.toBe(0);
    const [b] = await getDb().select().from(outboxEvents).where(eq(outboxEvents.id, ids.b!));
    expect(b!.status).toBe("DEAD_LETTERED");
  });
});
