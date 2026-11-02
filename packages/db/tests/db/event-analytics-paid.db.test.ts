import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEventAnalyticsData } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedEventAccess } from "../helpers/factories";

describe.runIf(dbTestsEnabled())("analytics paid access counts", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);
  it("returns the maintained paid-capacity count separately from registrations", async () => {
    const event = await seedEvent();
    const item = await seedEventAccess({ eventId: event.id, registeredCount: 5, paidCount: 2 });
    await seedEventAccess({ paidCount: 99 });
    expect((await getEventAnalyticsData(event.id)).accessItems).toEqual([
      expect.objectContaining({ id: item.id, registeredCount: 5, paidCount: 2 }),
    ]);
  });
});
