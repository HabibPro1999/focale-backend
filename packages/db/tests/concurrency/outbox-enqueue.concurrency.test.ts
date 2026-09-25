import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { enqueueOutboxEvent, getDb, outboxEvents, withLockingTxn } from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { makeBarrier } from "../helpers/barrier";

// 3.5: two transactions enqueue the same dedupe key at once. ON CONFLICT on
// the partial unique index makes the later one wait for the first and insert
// nothing: one row, one `true`, no unique violation surfaced.

describe.runIf(dbTestsEnabled())("concurrency: outbox enqueue dedupe", () => {
  beforeEach(async () => {
    await getDb().delete(outboxEvents);
  });
  afterEach(async () => {
    await getDb().delete(outboxEvents);
  });

  it("inserts one row when concurrent transactions enqueue the same key", async () => {
    const parties = 4;
    const arrive = makeBarrier(parties);
    // withLockingTxn re-runs a transaction on a CockroachDB restart (40001);
    // each attempt reports its own result, the last one counts.
    const results = await Promise.all(
      Array.from({ length: parties }, (_, i) => {
        let arrived = false;
        return withLockingTxn(async (tx) => {
          await tx.select({ id: outboxEvents.id }).from(outboxEvents).limit(1);
          if (!arrived) {
            arrived = true;
            await arrive();
          }
          const inserted = await enqueueOutboxEvent(tx, {
            type: "email.triggered",
            dedupeKey: "race-key",
            payload: { writer: i },
          });
          // Keep the other writers waiting on this uncommitted row for a moment.
          await new Promise((resolve) => setTimeout(resolve, 50));
          return inserted;
        });
      }),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await getDb().select().from(outboxEvents).where(eq(outboxEvents.dedupeKey, "race-key"));
    expect(rows).toHaveLength(1);
  });
});
