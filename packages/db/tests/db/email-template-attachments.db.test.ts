import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  DB_NOW,
  emailLogs,
  getClaimedEmailLogsForProcessing,
  getDb,
  getEmailTemplateById,
  insertEmailTemplate,
  updateEmailTemplate,
} from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { cleanupDatabase } from "../helpers/cleanup";
import { seedEvent } from "../helpers/factories";

// 0041: email_templates.attachments round-trips through the template writes
// and reads, and reaches the send pipeline through the claimed-row loader.
const WORKER = "email-template-attachments";

describe.runIf(dbTestsEnabled())("db tier: email template attachments", () => {
  beforeEach(cleanupDatabase);
  afterEach(cleanupDatabase);

  async function insertTemplate(attachments?: { type: "REGISTRATION_QR" }[]) {
    const event = await seedEvent();
    const result = await insertEmailTemplate({
      clientId: event.clientId,
      eventId: event.id,
      name: "Welcome",
      subject: "Hello",
      content: { type: "doc", content: [] },
      category: "MANUAL",
      ...(attachments && { attachments }),
    });
    if (!result.ok) throw new Error("insert failed");
    return result.template;
  }

  it("defaults to an empty list, and stores, updates and reads the configured attachments", async () => {
    const plain = await insertTemplate();
    expect(plain.attachments).toEqual([]);

    const withQr = await insertTemplate([{ type: "REGISTRATION_QR" }]);
    expect(withQr.attachments).toEqual([{ type: "REGISTRATION_QR" }]);
    expect((await getEmailTemplateById(withQr.id))?.attachments).toEqual([{ type: "REGISTRATION_QR" }]);

    expect((await updateEmailTemplate(plain.id, { attachments: [{ type: "REGISTRATION_QR" }] }))?.attachments)
      .toEqual([{ type: "REGISTRATION_QR" }]);
    expect((await updateEmailTemplate(withQr.id, { attachments: [] }))?.attachments).toEqual([]);
    expect((await getEmailTemplateById(withQr.id))?.attachments).toEqual([]);
  });

  it("loads the template's attachments with a claimed email", async () => {
    const template = await insertTemplate([{ type: "REGISTRATION_QR" }]);
    const [log] = await getDb()
      .insert(emailLogs)
      .values({
        templateId: template.id,
        recipientEmail: "attachments@example.test",
        subject: "unresolved",
        status: "SENDING",
        lockedBy: WORKER,
        lockedAt: DB_NOW,
        lockedUntil: sql`${DB_NOW} + interval '10 minutes'`,
      })
      .returning();

    const [claimed] = await getClaimedEmailLogsForProcessing(WORKER, [log!.id]);
    expect(claimed?.template?.attachments).toEqual([{ type: "REGISTRATION_QR" }]);
  });
});
