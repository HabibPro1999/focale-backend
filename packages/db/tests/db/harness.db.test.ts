import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, getEventAccessById, listEventAccessRows, events } from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedEventAccess } from "../helpers/factories";

// General real-DB tier: proves the ported harness (env gate, factories, FK-ordered
// cleanup) works against the live schema and that @app/db query fns round-trip.
describe.runIf(dbTestsEnabled())("db tier: harness", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  it("runs against an explicitly allowed disposable database", () => {
    expect(process.env.ALLOW_DB_TESTS).toBe("1");
    expect(process.env.TEST_DATABASE_URL).toBeTruthy();
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
  });

  it("factories seed and query fns read them back", async () => {
    const event = await seedEvent({ status: "OPEN" });
    const access = await seedEventAccess({ eventId: event.id, name: "Gala Dinner" });

    const one = await getEventAccessById(access.id);
    expect(one?.name).toBe("Gala Dinner");
    expect(one?.requiredAccess).toEqual([]);

    const list = await listEventAccessRows(event.id, undefined);
    expect(list.map((r) => r.id)).toContain(access.id);
  });

  it("FK-ordered cleanupDatabase empties every table", async () => {
    const event = await seedEvent({ status: "OPEN" });
    await seedEventAccess({ eventId: event.id });

    await cleanupDatabase();

    const remaining = await getDb().select({ id: events.id }).from(events);
    expect(remaining).toHaveLength(0);
  });
});
