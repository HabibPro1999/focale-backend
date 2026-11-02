import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRegistrationRows } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedForm, seedRegistration } from "../helpers/factories";
describe.runIf(dbTestsEnabled())("registration sorting", () => {
  beforeEach(cleanupDatabase); afterEach(cleanupDatabase);
  it("sorts names, amounts and dates in both directions with stable pagination", async () => {
    const event = await seedEvent(); const form = await seedForm({ eventId: event.id });
    const a = await seedRegistration({ eventId: event.id, formId: form.id, firstName: "Zoe", totalAmount: 10, createdAt: new Date("2026-01-01T00:00:00Z") });
    const b = await seedRegistration({ eventId: event.id, formId: form.id, firstName: "Ada", totalAmount: 20, createdAt: new Date("2026-01-02T00:00:00Z") });
    const ids = async (sort: "name"|"amount"|"date", sortOrder: "asc"|"desc") => (await listRegistrationRows(event.id, { sort, sortOrder, limit: 10, offset: 0 })).data.map(r => r.id);
    expect(await ids("name", "asc")).toEqual([b.id,a.id]);
    expect(await ids("name", "desc")).toEqual([a.id,b.id]);
    expect(await ids("amount", "asc")).toEqual([a.id,b.id]);
    expect(await ids("date", "asc")).toEqual([a.id,b.id]);
    expect(await ids("date", "desc")).toEqual([b.id,a.id]);
  });
});
