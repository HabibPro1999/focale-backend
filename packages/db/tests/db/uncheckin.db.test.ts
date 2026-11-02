import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, registrations, accessCheckIns, undoCheckIn, getRegistrationForCheckIn, getAccessCheckIn } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { eq } from "drizzle-orm";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedEventAccess, seedRegistration, seedUser } from "../helpers/factories";
describe.runIf(dbTestsEnabled())("undo check-in", () => {
  beforeEach(cleanupDatabase); afterEach(cleanupDatabase);
  it("clears event check-in idempotently without requiring the old payment status", async () => {
    const event = await seedEvent(); const user = await seedUser();
    const time = new Date("2026-01-01T12:00:00Z");
    const reg = await seedRegistration({ eventId: event.id, checkedInAt: time, checkedInBy: user.id });
    const input = { eventId: event.id, registrationId: reg.id, actorId: user.id, expectedCheckedInAt: time };
    expect(await undoCheckIn(input)).toEqual({ outcome: "UNDONE" });
    expect(await getRegistrationForCheckIn(reg.id)).toMatchObject({ checkedInAt: null });
    expect(await undoCheckIn(input)).toEqual({ outcome: "ALREADY_UNDONE" });
    await getDb().update(registrations).set({ checkedInAt: new Date("2026-01-02T12:00:00Z") }).where(eq(registrations.id, reg.id));
    expect(await undoCheckIn(input)).toEqual({ outcome: "CONFLICT" });
    expect((await getRegistrationForCheckIn(reg.id))?.checkedInAt).not.toBeNull();
  });
  it("undoes only the selected access check-in and never crosses event boundaries", async () => {
    const event = await seedEvent(); const other = await seedEvent(); const user = await seedUser();
    const access = await seedEventAccess({ eventId: event.id });
    const reg = await seedRegistration({ eventId: event.id, checkedInAt: new Date() });
    await getDb().insert(accessCheckIns).values({ registrationId: reg.id, accessId: access.id, checkedInBy: user.id });
    const input = { eventId: other.id, registrationId: reg.id, accessId: access.id, actorId: user.id };
    expect(await undoCheckIn(input)).toEqual({ outcome: "NOT_FOUND" });
    expect(await getAccessCheckIn(reg.id, access.id)).not.toBeNull();
    expect(await undoCheckIn({ ...input, eventId: event.id })).toEqual({ outcome: "UNDONE" });
    expect(await getAccessCheckIn(reg.id, access.id)).toBeNull();
    expect((await getRegistrationForCheckIn(reg.id))?.checkedInAt).not.toBeNull();
  });
});
