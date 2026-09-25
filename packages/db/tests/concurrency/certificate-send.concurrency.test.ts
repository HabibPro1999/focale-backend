import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  emailLogs,
  emailTemplates,
  getDb,
  queueCertificateEmailLogsTxn,
  type CertificateEmailCandidate,
  type QueueCertificateEmailLogsInput,
} from "@app/db";
import { dbTestsEnabled } from "../helpers/test-env";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedAbstract, seedEvent, seedForm, seedRegistration } from "../helpers/factories";

// Certificate sends (2.12). Certificate emails are no longer covered by the
// per-trigger unique indexes (0024), so the event lock in
// queueCertificateEmailLogsTxn is what stops parallel sends from queueing a
// certificate twice: each send re-reads what is already queued after the lock.
describe.runIf(dbTestsEnabled())("concurrency: certificate sends", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  const contenders = 12;
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
    const registrations = [];
    for (let i = 0; i < 4; i++) {
      registrations.push(await seedRegistration({ eventId: event.id, formId: form.id }));
    }
    const author = registrations[0].email;
    const abstracts = [
      await seedAbstract({ eventId: event.id, authorEmail: author }),
      await seedAbstract({ eventId: event.id, authorEmail: author }),
    ];
    return { event, emailTemplateId: template.id, registrations, abstracts };
  }

  function candidate(
    targetId: string,
    recipientEmail: string,
    certificates: Array<{ id: string; name: string }>,
  ): CertificateEmailCandidate {
    return { targetId, recipientEmail, recipientName: null, certificates, contextSnapshot: {} };
  }

  async function certificateLogs(eventTargets: Set<string>) {
    const rows = await getDb()
      .select({
        registrationId: emailLogs.registrationId,
        abstractId: emailLogs.abstractId,
        contextSnapshot: emailLogs.contextSnapshot,
      })
      .from(emailLogs)
      .where(eq(emailLogs.trigger, "CERTIFICATE_SENT"));
    return rows
      .map((row) => ({
        target: (row.registrationId ?? row.abstractId) as string,
        templateIds: (row.contextSnapshot as { _certificateTemplateIds: string[] })._certificateTemplateIds,
      }))
      .filter((row) => eventTargets.has(row.target));
  }

  it("parallel identical sends queue each certificate once", async () => {
    const { event, emailTemplateId, registrations, abstracts } = await setup();
    const input: QueueCertificateEmailLogsInput = {
      eventId: event.id,
      emailTemplateId,
      registrations: registrations.map((r) => candidate(r.id, r.email, [certA])),
      abstracts: abstracts.map((a) => candidate(a.id, a.authorEmail, [certB])),
    };

    const results = await Promise.all(
      Array.from({ length: contenders }, () => queueCertificateEmailLogsTxn(input)),
    );

    // Exactly one send queued each target; every other send saw it as sent.
    for (const batch of ["registrations", "abstracts"] as const) {
      for (let i = 0; i < input[batch].length; i++) {
        const statuses = results.map((result) => result?.[batch][i].status);
        expect(statuses.filter((status) => status === "queued")).toHaveLength(1);
        expect(statuses.filter((status) => status === "already_sent")).toHaveLength(contenders - 1);
      }
    }

    const targets = new Set([...registrations.map((r) => r.id), ...abstracts.map((a) => a.id)]);
    const logs = await certificateLogs(targets);
    expect(logs).toHaveLength(targets.size);
    // Both abstracts of the same author got their email.
    expect(logs.filter((log) => abstracts.some((a) => a.id === log.target))).toHaveLength(2);
  });

  it("parallel sends with overlapping certificate sets never queue a certificate twice", async () => {
    const { event, emailTemplateId, registrations } = await setup();
    const send = (certificates: Array<{ id: string; name: string }>) =>
      queueCertificateEmailLogsTxn({
        eventId: event.id,
        emailTemplateId,
        registrations: registrations.map((r) => candidate(r.id, r.email, certificates)),
        abstracts: [],
      });

    await Promise.all(
      Array.from({ length: contenders }, (_, i) =>
        send(i % 3 === 0 ? [certA] : i % 3 === 1 ? [certB] : [certA, certB]),
      ),
    );

    const logs = await certificateLogs(new Set(registrations.map((r) => r.id)));
    for (const registration of registrations) {
      const queued = logs
        .filter((log) => log.target === registration.id)
        .flatMap((log) => log.templateIds)
        .sort();
      expect(queued).toEqual(["cert-a", "cert-b"]);
    }
  });
});
