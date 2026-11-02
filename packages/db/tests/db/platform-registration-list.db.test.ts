import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPlatformRegistrationRows } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedRegistration } from "../helpers/factories";
describe.runIf(dbTestsEnabled())("platform registration list", () => {
  beforeEach(cleanupDatabase); afterEach(cleanupDatabase);
  it("paginates across events with filters and never selects self-edit credentials", async () => {
    const a = await seedEvent(); const b = await seedEvent();
    await seedRegistration({ eventId: a.id, role: "SPEAKER", editToken: "secret-a", idempotencyKey: "key-a" });
    await seedRegistration({ eventId: b.id, role: "PARTICIPANT", editToken: "secret-b" });
    expect(await listPlatformRegistrationRows({ offset: 0, limit: 1 })).toMatchObject({ total: 2, data: [expect.any(Object)] });
    const filtered = await listPlatformRegistrationRows({ clientId: a.clientId, role: "SPEAKER", offset: 0, limit: 10 });
    expect(filtered.total).toBe(1);
    expect(filtered.data[0]).toMatchObject({ event: { id: a.id } });
    expect(filtered.data[0]).not.toHaveProperty("editToken"); expect(filtered.data[0]).not.toHaveProperty("idempotencyKey");
    expect(await listPlatformRegistrationRows({ eventId: a.id, role: "PARTICIPANT", offset: 0, limit: 10 })).toMatchObject({ total: 0, data: [] });
  });
});
