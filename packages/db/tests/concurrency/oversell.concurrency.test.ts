import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  casIncrementAccessPaidCount,
  casIncrementRegisteredTx,
  eventAccess,
  events,
  getAccessPaidCount,
  getDb,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedEventAccess } from "../helpers/factories";

// Oversell / capacity-gate race. The capacity guards are single-statement atomic
// CAS (UPDATE ... WHERE guard RETURNING). Under genuine parallelism exactly
// `maxCapacity` increments must win and the counter must never exceed capacity.
// Atomic CAS is correct under any isolation level, so this is green on vanilla
// Postgres and CockroachDB alike.
describe.runIf(dbTestsEnabled())("concurrency: capacity oversell gates", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("event registered_count never oversells under parallel increments", async () => {
    const capacity = 10;
    const contenders = 50;
    const event = await seedEvent({ status: "OPEN", maxCapacity: capacity });

    const results = await Promise.all(
      Array.from({ length: contenders }, () =>
        casIncrementRegisteredTx(getDb(), event.id),
      ),
    );

    const wins = results.filter(Boolean).length;
    const [row] = await getDb()
      .select({ registeredCount: events.registeredCount })
      .from(events)
      .where(eq(events.id, event.id));

    expect(wins).toBe(capacity);
    expect(row.registeredCount).toBe(capacity);
  });

  it("event with no capacity accepts every parallel increment", async () => {
    const contenders = 30;
    const event = await seedEvent({ status: "OPEN", maxCapacity: null });

    const results = await Promise.all(
      Array.from({ length: contenders }, () =>
        casIncrementRegisteredTx(getDb(), event.id),
      ),
    );

    expect(results.filter(Boolean).length).toBe(contenders);
  });

  it("access paid_count never oversells under parallel claims", async () => {
    const capacity = 8;
    const contenders = 40;
    const event = await seedEvent({ status: "OPEN" });
    const access = await seedEventAccess({
      eventId: event.id,
      maxCapacity: capacity,
    });

    const results = await Promise.all(
      Array.from({ length: contenders }, () =>
        casIncrementAccessPaidCount(access.id, 1, getDb()),
      ),
    );

    const wins = results.filter(Boolean).length;
    const paid = await getAccessPaidCount(access.id);

    expect(wins).toBe(capacity);
    expect(paid?.paidCount).toBe(capacity);
    expect(paid?.paidCount).toBeLessThanOrEqual(capacity);
  });
});
