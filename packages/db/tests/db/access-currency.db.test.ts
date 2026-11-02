import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eventPricing, getDb, getEventDatesForAccess } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent } from "../helpers/factories";
describe.runIf(dbTestsEnabled())("access currency source", () => {
  beforeEach(cleanupDatabase); afterEach(cleanupDatabase);
  it("reads event pricing currency and uses TND only when pricing is absent", async () => {
    const event = await seedEvent();
    expect(await getEventDatesForAccess(event.id)).toMatchObject({ currency: "TND" });
    await getDb().insert(eventPricing).values({ eventId: event.id, currency: "EUR", basePrice: 0, rules: [] });
    expect(await getEventDatesForAccess(event.id)).toMatchObject({ currency: "EUR" });
  });
});
