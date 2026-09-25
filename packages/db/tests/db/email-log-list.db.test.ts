import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emailLogs, emailTemplates, getDb, listEventEmailLogs, type EmailLogInsert } from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedRegistration } from "../helpers/factories";

// 3.6b: the event email-log list as a UNION ALL of the registration branch and
// the template branch (minus the event's registrations), with a capped count,
// against a migrated database (both engines in CI).
describe.runIf(dbTestsEnabled())("db tier: listEventEmailLogs (3.6b)", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  const base = Date.parse("2026-09-01T00:00:00.000Z");
  const at = (minutes: number) => new Date(base + minutes * 60_000);

  async function seedTemplate(event: { id: string; clientId: string }, name: string) {
    const [template] = await getDb()
      .insert(emailTemplates)
      .values({ clientId: event.clientId, eventId: event.id, name, subject: name, content: {}, category: "MANUAL" })
      .returning();
    return template!;
  }

  async function seedLog(subject: string, minutes: number, values: Partial<EmailLogInsert> = {}) {
    const [log] = await getDb()
      .insert(emailLogs)
      .values({ recipientEmail: `${subject}@example.test`, subject, status: "SENT", queuedAt: at(minutes), ...values })
      .returning({ id: emailLogs.id });
    return log!.id;
  }

  async function setup() {
    const event = await seedEvent();
    const other = await seedEvent();
    const registration = await seedRegistration({ eventId: event.id });
    const otherRegistration = await seedRegistration({ eventId: other.id });
    const template = await seedTemplate(event, "Welcome");
    const otherTemplate = await seedTemplate(other, "Elsewhere");
    // Registration only (one-off email), template only (sponsor send), both
    // (listed once), this event's template with another event's registration,
    // and three rows of the other event.
    await seedLog("reg-only", 1, { registrationId: registration.id });
    await seedLog("tpl-only", 2, { templateId: template.id, status: "UNCERTAIN" });
    await seedLog("both", 3, { registrationId: registration.id, templateId: template.id });
    await seedLog("tpl-other-reg", 4, { templateId: template.id, registrationId: otherRegistration.id });
    await seedLog("other-reg", 5, { registrationId: otherRegistration.id });
    await seedLog("other-tpl", 6, { templateId: otherTemplate.id });
    await seedLog("unlinked", 7);
    return { event };
  }

  it("lists the event's emails once each, newest first, with the template name", async () => {
    const { event } = await setup();
    const result = await listEventEmailLogs(event.id, { skip: 0, limit: 50 });

    expect(result.data.map((row) => row.subject)).toEqual(["tpl-other-reg", "both", "tpl-only", "reg-only"]);
    expect(result.data.find((row) => row.subject === "both")).toMatchObject({ templateName: "Welcome" });
    expect(result.data.find((row) => row.subject === "reg-only")).toMatchObject({ templateName: null });
    expect(result).toMatchObject({ total: 4, totalCapped: false });
  });

  it("pages across both branches", async () => {
    const { event } = await setup();
    const pages = [];
    for (const skip of [0, 2]) {
      const page = await listEventEmailLogs(event.id, { skip, limit: 2 });
      pages.push(page.data.map((row) => row.subject));
      expect(page.total).toBe(4);
    }
    expect(pages).toEqual([
      ["tpl-other-reg", "both"],
      ["tpl-only", "reg-only"],
    ]);
    await expect(listEventEmailLogs(event.id, { skip: 4, limit: 2 })).resolves.toMatchObject({ data: [], total: 4 });
  });

  it("orders rows with the same queued_at by id", async () => {
    const event = await seedEvent();
    const registration = await seedRegistration({ eventId: event.id });
    const template = await seedTemplate(event, "Welcome");
    const ids = [
      await seedLog("r1", 1, { registrationId: registration.id }),
      await seedLog("t1", 1, { templateId: template.id }),
      await seedLog("r2", 1, { registrationId: registration.id }),
    ];
    const first = await listEventEmailLogs(event.id, { skip: 0, limit: 2 });
    const second = await listEventEmailLogs(event.id, { skip: 2, limit: 2 });
    const listed = [...first.data, ...second.data].map((row) => row.id);
    expect(listed).toEqual([...ids].sort().reverse());
  });

  it("filters on status and trigger", async () => {
    const { event } = await setup();
    const uncertain = await listEventEmailLogs(event.id, { skip: 0, limit: 50, status: "UNCERTAIN" });
    expect(uncertain.data.map((row) => row.subject)).toEqual(["tpl-only"]);
    expect(uncertain.total).toBe(1);
    await expect(
      listEventEmailLogs(event.id, { skip: 0, limit: 50, trigger: "PAYMENT_CONFIRMED" }),
    ).resolves.toMatchObject({ data: [], total: 0 });
  });

  it("caps the count", async () => {
    const { event } = await setup();
    await expect(listEventEmailLogs(event.id, { skip: 0, limit: 50, countCap: 3 })).resolves.toMatchObject({
      total: 3,
      totalCapped: true,
    });
    await expect(listEventEmailLogs(event.id, { skip: 0, limit: 50, countCap: 4 })).resolves.toMatchObject({
      total: 4,
      totalCapped: false,
    });
  });
});
