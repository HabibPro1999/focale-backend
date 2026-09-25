import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  emailLogs,
  emailTemplates,
  getDb,
  insertEmailLogsSkippingConflicts,
  queueCertificateEmailLogsTxn,
  type CertificateEmailCandidate,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedAbstract, seedEvent, seedForm, seedRegistration } from "../helpers/factories";

// Certificate sends (2.12) on a migrated DB, both engines: dedupe per
// certificate template (OPENED/CLICKED count as sent), several certificate
// emails per registration or recipient (0024), both batches in one
// transaction, and the conflict-skipping insert against the partial indexes.
describe.runIf(dbTestsEnabled())("db: certificate sends", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  const certA = { id: "cert-a", name: "Attendance" };
  const certB = { id: "cert-b", name: "Presenter" };

  async function setup() {
    const event = await seedEvent();
    const form = await seedForm({ eventId: event.id });
    const [template] = await getDb()
      .insert(emailTemplates)
      .values({
        clientId: event.clientId,
        eventId: event.id,
        name: "Certificate",
        subject: "Your certificate",
        content: {},
        category: "AUTOMATIC",
        trigger: "CERTIFICATE_SENT",
      })
      .returning();
    return { event, form, emailTemplateId: template.id };
  }

  function candidate(
    targetId: string,
    recipientEmail: string,
    certificates = [certA],
  ): CertificateEmailCandidate {
    return {
      targetId,
      recipientEmail,
      recipientName: "Ada Lovelace",
      certificates,
      contextSnapshot: { fullName: "Ada Lovelace" },
    };
  }

  async function certificateLogs() {
    return getDb()
      .select({
        id: emailLogs.id,
        registrationId: emailLogs.registrationId,
        abstractId: emailLogs.abstractId,
        recipientEmail: emailLogs.recipientEmail,
        status: emailLogs.status,
        contextSnapshot: emailLogs.contextSnapshot,
      })
      .from(emailLogs)
      .where(eq(emailLogs.trigger, "CERTIFICATE_SENT"))
      .orderBy(asc(emailLogs.id));
  }

  const templateIdsOf = (snapshot: unknown) =>
    (snapshot as { _certificateTemplateIds: string[] })._certificateTemplateIds;

  it("queues the remaining certificates only; OPENED and CLICKED count as sent", async () => {
    const { event, form, emailTemplateId } = await setup();
    const opened = await seedRegistration({ eventId: event.id, formId: form.id });
    const clicked = await seedRegistration({ eventId: event.id, formId: form.id });
    const failed = await seedRegistration({ eventId: event.id, formId: form.id });

    const first = await queueCertificateEmailLogsTxn({
      eventId: event.id,
      emailTemplateId,
      registrations: [opened, clicked, failed].map((r) => candidate(r.id, r.email)),
      abstracts: [],
    });
    expect(first?.registrations.map((o) => o.status)).toEqual(["queued", "queued", "queued"]);

    const statusFor = new Map([
      [opened.id, "OPENED" as const],
      [clicked.id, "CLICKED" as const],
      [failed.id, "FAILED" as const],
    ]);
    for (const [registrationId, status] of statusFor) {
      await getDb()
        .update(emailLogs)
        .set({ status })
        .where(and(eq(emailLogs.registrationId, registrationId), eq(emailLogs.trigger, "CERTIFICATE_SENT")));
    }

    // A second template was added; the send runs again.
    const second = await queueCertificateEmailLogsTxn({
      eventId: event.id,
      emailTemplateId,
      registrations: [opened, clicked, failed].map((r) => candidate(r.id, r.email, [certA, certB])),
      abstracts: [],
    });
    expect(second?.registrations).toEqual([
      expect.objectContaining({ status: "queued", certificates: [certB] }),
      expect.objectContaining({ status: "queued", certificates: [certB] }),
      expect.objectContaining({ status: "queued", certificates: [certA, certB] }),
    ]);

    const third = await queueCertificateEmailLogsTxn({
      eventId: event.id,
      emailTemplateId,
      registrations: [opened, clicked].map((r) => candidate(r.id, r.email, [certA, certB])),
      abstracts: [],
    });
    expect(third?.registrations.map((o) => o.status)).toEqual(["already_sent", "already_sent"]);

    const logs = await certificateLogs();
    // Two active emails for the same registration (0024 lets them coexist).
    expect(logs.filter((l) => l.registrationId === opened.id).map((l) => templateIdsOf(l.contextSnapshot)))
      .toEqual(expect.arrayContaining([["cert-a"], ["cert-b"]]));
    expect(logs).toHaveLength(6);
  });

  it("gives an author with two abstracts, who is also a registrant, one email each", async () => {
    const { event, form, emailTemplateId } = await setup();
    const email = `author-${randomUUID()}@example.test`;
    const registration = await seedRegistration({ eventId: event.id, formId: form.id, email });
    const first = await seedAbstract({ eventId: event.id, authorEmail: email });
    const second = await seedAbstract({ eventId: event.id, authorEmail: email });

    const result = await queueCertificateEmailLogsTxn({
      eventId: event.id,
      emailTemplateId,
      registrations: [candidate(registration.id, email)],
      abstracts: [candidate(first.id, email, [certB]), candidate(second.id, email, [certB])],
    });

    expect(result?.registrations.map((o) => o.status)).toEqual(["queued"]);
    expect(result?.abstracts.map((o) => o.status)).toEqual(["queued", "queued"]);
    const logs = await certificateLogs();
    expect(logs).toHaveLength(3);
    expect(new Set(logs.map((l) => l.recipientEmail))).toEqual(new Set([email]));
    expect(logs.filter((l) => l.abstractId).map((l) => l.abstractId).sort())
      .toEqual([first.id, second.id].sort());
    for (const log of logs) expect(log.status).toBe("QUEUED");
  });

  it("dedupes abstracts per abstract and certificate template", async () => {
    const { event, emailTemplateId } = await setup();
    const abstract = await seedAbstract({ eventId: event.id });
    const send = () =>
      queueCertificateEmailLogsTxn({
        eventId: event.id,
        emailTemplateId,
        registrations: [],
        abstracts: [candidate(abstract.id, abstract.authorEmail, [certB])],
      });
    expect((await send())?.abstracts.map((o) => o.status)).toEqual(["queued"]);
    expect((await send())?.abstracts.map((o) => o.status)).toEqual(["already_sent"]);
  });

  // 3.6a's UNCERTAIN: the provider may already have sent the email, so a
  // repeated send queues nothing; an admin resends it explicitly instead.
  it("counts an UNCERTAIN certificate email as sent for registrations and abstracts", async () => {
    const { event, form, emailTemplateId } = await setup();
    const registration = await seedRegistration({ eventId: event.id, formId: form.id });
    const abstract = await seedAbstract({ eventId: event.id });
    const send = () =>
      queueCertificateEmailLogsTxn({
        eventId: event.id,
        emailTemplateId,
        registrations: [candidate(registration.id, registration.email)],
        abstracts: [candidate(abstract.id, abstract.authorEmail, [certB])],
      });
    const first = await send();
    expect(first?.registrations.map((o) => o.status)).toEqual(["queued"]);
    expect(first?.abstracts.map((o) => o.status)).toEqual(["queued"]);
    await getDb()
      .update(emailLogs)
      .set({ status: "UNCERTAIN" })
      .where(eq(emailLogs.trigger, "CERTIFICATE_SENT"));

    const again = await send();
    expect(again?.registrations.map((o) => o.status)).toEqual(["already_sent"]);
    expect(again?.abstracts.map((o) => o.status)).toEqual(["already_sent"]);
    expect((await certificateLogs()).map((l) => l.status)).toEqual(["UNCERTAIN", "UNCERTAIN"]);
  });

  it("commits both batches or neither", async () => {
    const { event, form, emailTemplateId } = await setup();
    const registration = await seedRegistration({ eventId: event.id, formId: form.id });

    // The abstract does not exist, so its row fails its foreign key and the
    // registration's row must roll back with it.
    await expect(
      queueCertificateEmailLogsTxn({
        eventId: event.id,
        emailTemplateId,
        registrations: [candidate(registration.id, registration.email)],
        abstracts: [candidate("missing-abstract", "x@example.test")],
      }),
    ).rejects.toThrow();
    expect(await certificateLogs()).toEqual([]);
  });

  it("returns null and queues nothing when the event does not exist", async () => {
    const { event, form, emailTemplateId } = await setup();
    const registration = await seedRegistration({ eventId: event.id, formId: form.id });
    const result = await queueCertificateEmailLogsTxn({
      eventId: "missing-event",
      emailTemplateId,
      registrations: [candidate(registration.id, registration.email)],
      abstracts: [],
    });
    expect(result).toBeNull();
    expect(await certificateLogs()).toEqual([]);
  });

  it("skips rows the partial unique indexes refuse and keeps the rest", async () => {
    const { event, form, emailTemplateId } = await setup();
    const registration = await seedRegistration({ eventId: event.id, formId: form.id });
    const base = { subject: "", status: "QUEUED" as const, templateId: emailTemplateId };
    await insertEmailLogsSkippingConflicts([
      { ...base, trigger: "REGISTRATION_CREATED", registrationId: registration.id, recipientEmail: "r1@example.test" },
      { ...base, trigger: "SPONSORSHIP_LINKED", recipientEmail: "s@example.test" },
      { ...base, recipientEmail: "d@example.test", dedupeKey: "outbox:evt-1" },
    ]);

    const rows = [
      // registration + trigger index
      { ...base, id: randomUUID(), trigger: "REGISTRATION_CREATED" as const, registrationId: registration.id, recipientEmail: "r2@example.test" },
      // template + recipient + trigger index
      { ...base, id: randomUUID(), trigger: "SPONSORSHIP_LINKED" as const, recipientEmail: "s@example.test" },
      // dedupe key index
      { ...base, id: randomUUID(), recipientEmail: "d2@example.test", dedupeKey: "outbox:evt-1" },
      // manual send: no index applies
      { ...base, id: randomUUID(), recipientEmail: "m@example.test" },
      // certificate emails are outside both per-trigger indexes (0024)
      { ...base, id: randomUUID(), trigger: "CERTIFICATE_SENT" as const, registrationId: registration.id, recipientEmail: "r1@example.test" },
      { ...base, id: randomUUID(), trigger: "CERTIFICATE_SENT" as const, registrationId: registration.id, recipientEmail: "r1@example.test" },
    ];
    const kept = await insertEmailLogsSkippingConflicts(rows);
    expect(kept).toEqual(new Set(rows.slice(3).map((row) => row.id)));
  });
});
