import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, emailLogs, getEventEmailLog } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedRegistration, seedAbstract } from "../helpers/factories";
describe.runIf(dbTestsEnabled())("email log detail", () => {
  beforeEach(cleanupDatabase); afterEach(cleanupDatabase);
  it("scopes the row to its event and never returns its credential-bearing context", async () => {
    const a = await seedEvent(); const b = await seedEvent(); const reg = await seedRegistration({ eventId: a.id });
    const [log] = await getDb().insert(emailLogs).values({ registrationId: reg.id, recipientEmail: "example@example.test", subject: "Subject", contextSnapshot: { editToken: "secret" } }).returning();
    expect(await getEventEmailLog(b.id, log.id)).toBeNull();
    const result = await getEventEmailLog(a.id, log.id);
    expect(result).toMatchObject({ id: log.id, subject: "Subject" });
    expect(result).not.toHaveProperty("contextSnapshot");
  });
});

it.runIf(dbTestsEnabled())("includes abstract and networking logs with explicit origins", async () => {
  const { listEventEmailLogs } = await import("@app/db");
  const event = await seedEvent(); const abstract = await seedAbstract({ eventId: event.id });
  await getDb().insert(emailLogs).values([
    { abstractId: abstract.id, abstractTrigger: "ABSTRACT_SUBMISSION_ACK", recipientEmail: "author@example.test", subject: "Abstract" },
    { recipientEmail: "participant@example.test", subject: "Networking", contextSnapshot: { dispatchOwner: "networking", eventId: event.id } },
  ]);
  const logs = await listEventEmailLogs(event.id, { offset: 0, limit: 20 });
  expect(logs.total).toBe(2);
  expect(logs.data.find(l => l.subject === "Abstract")).toMatchObject({ origin: "automatic", abstractTrigger: "ABSTRACT_SUBMISSION_ACK" });
  expect(logs.data.find(l => l.subject === "Networking")).toMatchObject({ origin: "networking", abstractTrigger: null });
  await cleanupDatabase();
});
