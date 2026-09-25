import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { emailLogs, emailTemplates, getDb, resendUncertainEmailLog, type EmailLogInsert } from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent, seedRegistration } from "../helpers/factories";

// 3.6: an admin's explicit resend of an UNCERTAIN email queues a new log (a
// new provider idempotency key) and keeps the UNCERTAIN one.
describe.runIf(dbTestsEnabled())("db tier: resendUncertainEmailLog (3.6)", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  async function setup() {
    const event = await seedEvent();
    const registration = await seedRegistration({ eventId: event.id });
    const [template] = await getDb()
      .insert(emailTemplates)
      .values({
        clientId: event.clientId,
        eventId: event.id,
        name: "Confirmation",
        subject: "Welcome",
        content: {},
        category: "AUTOMATIC",
        trigger: "PAYMENT_CONFIRMED",
      })
      .returning();
    return { event, registration, template: template! };
  }

  async function insertLog(values: Partial<EmailLogInsert>) {
    const [log] = await getDb()
      .insert(emailLogs)
      .values({ recipientEmail: "doc@example.test", subject: "Welcome", status: "UNCERTAIN", ...values })
      .returning();
    return log!;
  }

  async function readLog(id: string) {
    const [log] = await getDb().select().from(emailLogs).where(eq(emailLogs.id, id));
    return log!;
  }

  it("queues a copy with a fresh id and keeps the UNCERTAIN log, pointing at the copy", async () => {
    const { event, registration, template } = await setup();
    const source = await insertLog({
      trigger: "PAYMENT_CONFIRMED",
      templateId: template.id,
      registrationId: registration.id,
      recipientName: "Dr Who",
      contextSnapshot: { eventName: "Conf" },
      maxRetries: 5,
      providerAttemptedAt: new Date(),
      provider: "sendgrid",
    });

    const result = await resendUncertainEmailLog(event.id, source.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.log.id).not.toBe(source.id);
    expect(result.log).toMatchObject({
      status: "QUEUED",
      subject: "",
      trigger: "PAYMENT_CONFIRMED",
      templateId: template.id,
      registrationId: registration.id,
      recipientEmail: "doc@example.test",
      recipientName: "Dr Who",
      contextSnapshot: { eventName: "Conf" },
      maxRetries: 5,
      attemptCount: 0,
      providerAttemptedAt: null,
      dedupeKey: `resend:${source.id}`,
    });
    expect(await readLog(source.id)).toMatchObject({
      status: "UNCERTAIN",
      errorMessage: `Resent by an admin as email log ${result.log.id}`,
    });
  });

  it("refuses a second resend while the first is active", async () => {
    const { event, registration, template } = await setup();
    const source = await insertLog({ templateId: template.id, registrationId: registration.id });
    expect((await resendUncertainEmailLog(event.id, source.id)).ok).toBe(true);
    // The source is still UNCERTAIN; its resend key is taken by the active copy.
    await expect(resendUncertainEmailLog(event.id, source.id)).resolves.toEqual({ ok: false, reason: "already_active" });
    expect(await getDb().select({ id: emailLogs.id }).from(emailLogs)).toHaveLength(2);
  });

  it("resends only UNCERTAIN emails of this event that the queue can render again", async () => {
    const { event, registration, template } = await setup();
    const other = await seedEvent();
    const sent = await insertLog({ templateId: template.id, registrationId: registration.id, status: "SENT" });
    const oneOff = await insertLog({ registrationId: registration.id, contextSnapshot: { eventName: "Conf" } });
    const networking = await insertLog({
      templateId: template.id,
      registrationId: registration.id,
      contextSnapshot: { dispatchOwner: "networking" },
    });
    const fallback = await insertLog({
      registrationId: registration.id,
      contextSnapshot: { _fallbackSubject: "Hi {{firstName}}", _fallbackPlainBody: "Body" },
    });

    await expect(resendUncertainEmailLog(other.id, fallback.id)).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(resendUncertainEmailLog(event.id, "missing")).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(resendUncertainEmailLog(event.id, sent.id)).resolves.toEqual({ ok: false, reason: "not_uncertain" });
    await expect(resendUncertainEmailLog(event.id, oneOff.id)).resolves.toEqual({ ok: false, reason: "not_resendable" });
    await expect(resendUncertainEmailLog(event.id, networking.id)).resolves.toEqual({ ok: false, reason: "not_resendable" });
    // A plain-text fallback (no admin template) is rendered by the queue like a template.
    await expect(resendUncertainEmailLog(event.id, fallback.id)).resolves.toMatchObject({ ok: true });
  });

  it("finds the event through the template when the email has no registration (sponsor sends)", async () => {
    const { event, template } = await setup();
    const source = await insertLog({ templateId: template.id, contextSnapshot: { labName: "Lab" } });
    await expect(resendUncertainEmailLog(event.id, source.id)).resolves.toMatchObject({
      ok: true,
      log: { templateId: template.id, registrationId: null, contextSnapshot: { labName: "Lab" } },
    });
  });
});
