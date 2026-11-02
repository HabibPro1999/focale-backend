import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, emailTemplates, listEmailTemplates } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent } from "../helpers/factories";
describe.runIf(dbTestsEnabled())("email template scope", () => {
  beforeEach(cleanupDatabase); afterEach(cleanupDatabase);
  it("adds only the owning client's global templates when requested", async () => {
    const event = await seedEvent(); const other = await seedEvent();
    await getDb().insert(emailTemplates).values([
      { clientId: event.clientId, eventId: event.id, name: "Event", subject: "S", content: {}, category: "MANUAL" },
      { clientId: event.clientId, eventId: null, name: "Global", subject: "S", content: {}, category: "MANUAL" },
      { clientId: other.clientId, eventId: null, name: "Other", subject: "S", content: {}, category: "MANUAL" },
    ]);
    const list = (scope?: "event"|"client"|"all") => listEmailTemplates(event.id, { scope, offset: 0, limit: 20 });
    expect((await list()).data.map(t => t.name)).toEqual(["Event"]);
    expect((await list("client")).data.map(t => t.name)).toEqual(["Global"]);
    expect((await list("all")).data.map(t => t.name).sort()).toEqual(["Event","Global"]);
    expect((await list("all")).total).toBe(2);
  });
});
