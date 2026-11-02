import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAdminAbstracts } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedAbstract, seedEvent } from "../helpers/factories";

describe.runIf(dbTestsEnabled())("abstract status tab counts", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);
  it("ignores the selected status, keeps other filters and never crosses events", async () => {
    const event = await seedEvent();
    await seedAbstract({ eventId: event.id, status: "SUBMITTED", authorFirstName: "Match" });
    await seedAbstract({ eventId: event.id, status: "ACCEPTED", authorFirstName: "Match" });
    await seedAbstract({ eventId: event.id, status: "ACCEPTED", authorFirstName: "Different" });
    await seedAbstract({ eventId: (await seedEvent()).id, status: "ACCEPTED", authorFirstName: "Match" });
    const result = await listAdminAbstracts(event.id, { limit: 1, offset: 0, q: "Match", status: "ACCEPTED" });
    expect(result.total).toBe(1);
    expect(result.countsByStatus).toEqual({ SUBMITTED: 1, UNDER_REVIEW: 0, REVIEW_COMPLETE: 0, ACCEPTED: 1, REJECTED: 0, PENDING: 0 });
  });
});
