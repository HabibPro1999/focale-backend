import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { enqueueOutboxEvent, getDb, outboxEvents, withTxn } from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";

// 3.5: enqueue dedupes with ON CONFLICT on the partial unique index
// `outbox_events_dedupe_key_key` (predicate repeated) against a migrated
// database, both engines in CI.

async function rowsWithKey(key: string) {
  return getDb().select().from(outboxEvents).where(eq(outboxEvents.dedupeKey, key));
}

describe.runIf(dbTestsEnabled())("db tier: outbox enqueue dedupe", () => {
  beforeEach(async () => {
    await getDb().delete(outboxEvents);
  });
  afterEach(async () => {
    await getDb().delete(outboxEvents);
  });

  it("inserts a keyed event once and skips the duplicate outside a transaction", async () => {
    const input = { type: "email.triggered", dedupeKey: "k-1", payload: { n: 1 } };
    await expect(enqueueOutboxEvent(getDb(), input)).resolves.toBe(true);
    await expect(enqueueOutboxEvent(getDb(), { ...input, payload: { n: 2 } })).resolves.toBe(false);

    const rows = await rowsWithKey("k-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ n: 1 });
    expect(rows[0]!.status).toBe("PENDING");
  });

  it("keeps the caller's transaction usable after a duplicate (no aborted transaction)", async () => {
    await enqueueOutboxEvent(getDb(), { type: "email.triggered", dedupeKey: "k-2", payload: {} });

    const results = await withTxn(async (tx) => {
      const duplicate = await enqueueOutboxEvent(tx, { type: "email.triggered", dedupeKey: "k-2", payload: {} });
      // The same transaction keeps working: a duplicate raised nothing.
      const next = await enqueueOutboxEvent(tx, { type: "email.triggered", dedupeKey: "k-3", payload: {} });
      const again = await enqueueOutboxEvent(tx, { type: "email.triggered", dedupeKey: "k-3", payload: {} });
      const unkeyed = await enqueueOutboxEvent(tx, { type: "email.triggered", payload: {} });
      return { duplicate, next, again, unkeyed };
    });

    expect(results).toEqual({ duplicate: false, next: true, again: false, unkeyed: true });
    expect(await rowsWithKey("k-2")).toHaveLength(1);
    expect(await rowsWithKey("k-3")).toHaveLength(1);
  });

  it("rolls a keyed insert back with its transaction, so the key can be enqueued again", async () => {
    await expect(
      withTxn(async (tx) => {
        await enqueueOutboxEvent(tx, { type: "email.triggered", dedupeKey: "k-4", payload: {} });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await rowsWithKey("k-4")).toHaveLength(0);
    await expect(
      enqueueOutboxEvent(getDb(), { type: "email.triggered", dedupeKey: "k-4", payload: {} }),
    ).resolves.toBe(true);
  });

  it("never dedupes unkeyed events", async () => {
    for (let i = 0; i < 3; i++) {
      await expect(enqueueOutboxEvent(getDb(), { type: "realtime.emit", payload: { i } })).resolves.toBe(true);
    }
    const [row] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(outboxEvents)
      .where(sql`${outboxEvents.dedupeKey} IS NULL`);
    expect(Number(row!.n)).toBe(3);
  });
});
