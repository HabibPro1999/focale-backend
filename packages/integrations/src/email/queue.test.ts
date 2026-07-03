import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mock the @app/db fn layer (the raw-SQL/lease primitives are DB-tier) -----
vi.mock("@app/db", () => ({
  EMAIL_LEASE_MS: 10 * 60 * 1000,
  getTemplateByTrigger: vi.fn(),
  createEmailLog: vi.fn(),
  hasActiveEmailLogForRegistrationTrigger: vi.fn(),
  hasActiveSponsorshipEmailLog: vi.fn(),
  claimQueuedEmailLogs: vi.fn(),
  getClaimedEmailLogsForProcessing: vi.fn(),
  recoverStaleEmailLeases: vi.fn(),
  writeResolvedSubjectIfLeaseHeld: vi.fn(),
  refreshEmailLease: vi.fn(),
  markEmailSent: vi.fn(),
  markEmailFailed: vi.fn(),
  markEmailSkipped: vi.fn(),
  readEmailLogStatus: vi.fn(),
  updateEmailLogStatusGuarded: vi.fn(),
}));

const sendEmailMock = vi.fn();
vi.mock("./providers/index", () => ({
  getEmailProvider: () => ({ sendEmail: sendEmailMock }),
}));

vi.mock("./rendering/index", () => ({
  // Identity resolver so tests can assert the exact strings passed downstream.
  resolveVariables: vi.fn((tpl: string) => tpl),
  buildEmailContextWithAccess: vi.fn(),
}));

import {
  getTemplateByTrigger,
  createEmailLog,
  hasActiveEmailLogForRegistrationTrigger,
  hasActiveSponsorshipEmailLog,
  claimQueuedEmailLogs,
  getClaimedEmailLogsForProcessing,
  recoverStaleEmailLeases,
  writeResolvedSubjectIfLeaseHeld,
  refreshEmailLease,
  markEmailSent,
  markEmailFailed,
  markEmailSkipped,
  readEmailLogStatus,
  updateEmailLogStatusGuarded,
} from "@app/db";
import { buildEmailContextWithAccess } from "./rendering/index";
import {
  queueEmail,
  queueTriggeredEmail,
  queueSponsorshipEmail,
  processEmailQueue,
  updateEmailStatusFromWebhook,
} from "./queue";

const mocked = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible defaults: lease always held, sends succeed.
  mocked(recoverStaleEmailLeases).mockResolvedValue({
    requeued: 0,
    deadLettered: 0,
  });
  mocked(writeResolvedSubjectIfLeaseHeld).mockResolvedValue(true);
  mocked(refreshEmailLease).mockResolvedValue(true);
  mocked(markEmailSent).mockResolvedValue(true);
  mocked(markEmailFailed).mockResolvedValue(true);
  mocked(markEmailSkipped).mockResolvedValue(true);
  sendEmailMock.mockResolvedValue({ success: true, messageId: "m1" });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function claimed(overrides: Record<string, unknown> = {}): any {
  return {
    id: "log-1",
    trigger: null,
    templateId: "tmpl-1",
    registrationId: null,
    recipientEmail: "to@x.com",
    recipientName: "Bob",
    contextSnapshot: { eventName: "Conf", organizerEmail: "o@x.com", organizerName: "Org" },
    attemptCount: 1,
    maxRetries: 3,
    template: {
      id: "tmpl-1",
      isActive: true,
      subject: "Sub",
      htmlContent: "H",
      plainContent: "P",
    },
    registration: null,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runOne(log: any) {
  mocked(claimQueuedEmailLogs).mockResolvedValue([log.id]);
  mocked(getClaimedEmailLogsForProcessing).mockResolvedValue([log]);
  return processEmailQueue(50, { workerId: "w1" });
}

// =============================================================================
describe("queueEmail", () => {
  it("creates a QUEUED row with empty subject", async () => {
    mocked(createEmailLog).mockResolvedValue({ ok: true, log: { id: "l1" } });
    await queueEmail({ templateId: "t1", recipientEmail: "a@x.com" });
    expect(createEmailLog).toHaveBeenCalledWith(
      expect.objectContaining({
        templateId: "t1",
        recipientEmail: "a@x.com",
        subject: "",
        status: "QUEUED",
      }),
    );
  });

  it("passes trigger and contextSnapshot through", async () => {
    mocked(createEmailLog).mockResolvedValue({ ok: true, log: { id: "l1" } });
    await queueEmail({
      templateId: "t1",
      recipientEmail: "a@x.com",
      trigger: "REGISTRATION_CREATED",
      contextSnapshot: { foo: "bar" },
    });
    expect(createEmailLog).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "REGISTRATION_CREATED",
        contextSnapshot: { foo: "bar" },
      }),
    );
  });
});

describe("queueTriggeredEmail", () => {
  const reg = { id: "reg-1", email: "r@x.com", firstName: "Ann", lastName: "Lee" };

  it("queues when a template exists", async () => {
    mocked(getTemplateByTrigger).mockResolvedValue({ id: "tmpl-1" });
    mocked(hasActiveEmailLogForRegistrationTrigger).mockResolvedValue(false);
    mocked(createEmailLog).mockResolvedValue({ ok: true, log: { id: "l1" } });

    const out = await queueTriggeredEmail("REGISTRATION_CREATED", "ev-1", reg);
    expect(out).toBe(true);
    expect(createEmailLog).toHaveBeenCalledWith(
      expect.objectContaining({ recipientName: "Ann Lee" }),
    );
  });

  it("returns false when no template is configured", async () => {
    mocked(getTemplateByTrigger).mockResolvedValue(null);
    const out = await queueTriggeredEmail("REGISTRATION_CREATED", "ev-1", reg);
    expect(out).toBe(false);
    expect(createEmailLog).not.toHaveBeenCalled();
  });

  it("returns false when an active email already exists (pre-check)", async () => {
    mocked(getTemplateByTrigger).mockResolvedValue({ id: "tmpl-1" });
    mocked(hasActiveEmailLogForRegistrationTrigger).mockResolvedValue(true);
    const out = await queueTriggeredEmail("REGISTRATION_CREATED", "ev-1", reg);
    expect(out).toBe(false);
    expect(createEmailLog).not.toHaveBeenCalled();
  });

  it("returns false when the DB dedupe index wins a race", async () => {
    mocked(getTemplateByTrigger).mockResolvedValue({ id: "tmpl-1" });
    mocked(hasActiveEmailLogForRegistrationTrigger).mockResolvedValue(false);
    mocked(createEmailLog).mockResolvedValue({
      ok: false,
      conflictIndex: "email_logs_registration_trigger_active_key",
    });
    const out = await queueTriggeredEmail("REGISTRATION_CREATED", "ev-1", reg);
    expect(out).toBe(false);
  });

  it("uses only firstName when lastName is absent (no trailing space)", async () => {
    mocked(getTemplateByTrigger).mockResolvedValue({ id: "tmpl-1" });
    mocked(hasActiveEmailLogForRegistrationTrigger).mockResolvedValue(false);
    mocked(createEmailLog).mockResolvedValue({ ok: true, log: { id: "l1" } });
    await queueTriggeredEmail("REGISTRATION_CREATED", "ev-1", {
      id: "reg-1",
      email: "r@x.com",
      firstName: "Ann",
    });
    expect(createEmailLog).toHaveBeenCalledWith(
      expect.objectContaining({ recipientName: "Ann" }),
    );
  });

  it("sets recipientName to null when neither name is present", async () => {
    mocked(getTemplateByTrigger).mockResolvedValue({ id: "tmpl-1" });
    mocked(hasActiveEmailLogForRegistrationTrigger).mockResolvedValue(false);
    mocked(createEmailLog).mockResolvedValue({ ok: true, log: { id: "l1" } });
    await queueTriggeredEmail("REGISTRATION_CREATED", "ev-1", {
      id: "reg-1",
      email: "r@x.com",
    });
    // queueEmail maps undefined recipientName to null before insert.
    expect(createEmailLog).toHaveBeenCalledWith(
      expect.objectContaining({ recipientName: null }),
    );
  });
});

describe("queueSponsorshipEmail", () => {
  const input = {
    recipientEmail: "lab@x.com",
    recipientName: "Lab",
    context: { labName: "Lab" },
  };

  it("returns false when an active sponsorship email already exists", async () => {
    mocked(getTemplateByTrigger).mockResolvedValue({ id: "tmpl-1" });
    mocked(hasActiveSponsorshipEmailLog).mockResolvedValue(true);
    const out = await queueSponsorshipEmail(
      "SPONSORSHIP_BATCH_SUBMITTED",
      "ev-1",
      input,
    );
    expect(out).toBe(false);
    expect(createEmailLog).not.toHaveBeenCalled();
  });

  it("returns false when the DB dedupe index wins a race", async () => {
    mocked(getTemplateByTrigger).mockResolvedValue({ id: "tmpl-1" });
    mocked(hasActiveSponsorshipEmailLog).mockResolvedValue(false);
    mocked(createEmailLog).mockResolvedValue({
      ok: false,
      conflictIndex: "email_logs_template_recipient_trigger_active_key",
    });
    const out = await queueSponsorshipEmail(
      "SPONSORSHIP_BATCH_SUBMITTED",
      "ev-1",
      input,
    );
    expect(out).toBe(false);
  });
});

describe("processEmailQueue", () => {
  it("recovers stale leases, claims a batch and sends the happy path", async () => {
    const res = await runOne(claimed());
    expect(recoverStaleEmailLeases).toHaveBeenCalled();
    expect(claimQueuedEmailLogs).toHaveBeenCalledWith(
      "w1",
      50,
      expect.any(Date),
      expect.any(Date),
    );
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "to@x.com",
        subject: "Sub",
        html: "H",
        plainText: "P",
        trackingId: "log-1",
        fromName: "Conf",
        replyTo: "o@x.com",
        replyToName: "Org",
      }),
    );
    expect(markEmailSent).toHaveBeenCalledWith("log-1", "w1", "m1");
    expect(res).toEqual({ processed: 1, sent: 1, failed: 0, skipped: 0 });
  });

  it("returns a zero result when nothing is due", async () => {
    mocked(claimQueuedEmailLogs).mockResolvedValue([]);
    mocked(getClaimedEmailLogsForProcessing).mockResolvedValue([]);
    const res = await processEmailQueue(50, { workerId: "w1" });
    expect(res).toEqual({ processed: 0, sent: 0, failed: 0, skipped: 0 });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("respects the batchSize argument", async () => {
    mocked(claimQueuedEmailLogs).mockResolvedValue([]);
    mocked(getClaimedEmailLogsForProcessing).mockResolvedValue([]);
    await processEmailQueue(7, { workerId: "w1" });
    expect(claimQueuedEmailLogs).toHaveBeenCalledWith(
      "w1",
      7,
      expect.any(Date),
      expect.any(Date),
    );
  });

  it("skips (not fails) an email with no template relation", async () => {
    const res = await runOne(claimed({ template: null }));
    expect(markEmailSkipped).toHaveBeenCalledWith("log-1", "w1", "No template found");
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
  });

  it("skips an email whose template is inactive", async () => {
    const res = await runOne(
      claimed({ template: { id: "t", isActive: false, subject: "s" } }),
    );
    expect(markEmailSkipped).toHaveBeenCalledWith("log-1", "w1", "Template is inactive");
    expect(res.skipped).toBe(1);
  });

  it("uses the contextSnapshot instead of rebuilding from registration", async () => {
    await runOne(claimed({ registration: { id: "reg-1" } }));
    expect(buildEmailContextWithAccess).not.toHaveBeenCalled();
  });

  it("builds context from the registration when snapshot is empty", async () => {
    mocked(buildEmailContextWithAccess).mockResolvedValue({ eventName: "Conf" });
    await runOne(
      claimed({ contextSnapshot: {}, registration: { id: "reg-1" } }),
    );
    expect(buildEmailContextWithAccess).toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalled();
  });

  it("sends abstract-style snapshots that have no registration fields", async () => {
    const res = await runOne(
      claimed({
        registration: null,
        contextSnapshot: { congressName: "Congress", subject: "x" },
      }),
    );
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ fromName: "Congress" }),
    );
    expect(res.sent).toBe(1);
  });

  it("skips when context cannot be built (empty snapshot, no registration)", async () => {
    const res = await runOne(
      claimed({ contextSnapshot: {}, registration: null }),
    );
    expect(markEmailSkipped).toHaveBeenCalledWith(
      "log-1",
      "w1",
      "Could not build email context",
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
  });

  it("marks failed via the db layer when the provider send fails", async () => {
    sendEmailMock.mockResolvedValue({ success: false, error: "smtp down" });
    const res = await runOne(claimed({ attemptCount: 4, maxRetries: 3 }));
    expect(markEmailFailed).toHaveBeenCalledWith(
      "log-1",
      "w1",
      "smtp down",
      4,
      3,
    );
    expect(res.failed).toBe(1);
  });

  it("does NOT call the provider when the lease is lost before the send", async () => {
    mocked(refreshEmailLease).mockResolvedValue(false);
    const res = await runOne(claimed());
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(res).toEqual({ processed: 1, sent: 0, failed: 0, skipped: 0 });
  });

  it("does not count a send when the lease is lost before the final update", async () => {
    mocked(markEmailSent).mockResolvedValue(false);
    const res = await runOne(claimed());
    expect(sendEmailMock).toHaveBeenCalled();
    expect(res).toEqual({ processed: 1, sent: 0, failed: 0, skipped: 0 });
  });

  it("does not write the subject / send when the lease is lost early", async () => {
    mocked(writeResolvedSubjectIfLeaseHeld).mockResolvedValue(false);
    const res = await runOne(claimed());
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(res).toEqual({ processed: 1, sent: 0, failed: 0, skipped: 0 });
  });

  describe("certificate attachments", () => {
    const certLog = () =>
      claimed({
        trigger: "CERTIFICATE_SENT",
        registrationId: "reg-1",
        contextSnapshot: {
          eventName: "Conf",
          _certificateTemplateIds: ["c1", "c2"],
        },
      });
    const attachment = {
      content: "b64",
      filename: "c.pdf",
      type: "application/pdf",
      disposition: "attachment" as const,
    };

    it("attaches generated certificates and sends", async () => {
      const gen = vi.fn().mockResolvedValue([attachment, attachment]);
      mocked(claimQueuedEmailLogs).mockResolvedValue(["log-1"]);
      mocked(getClaimedEmailLogsForProcessing).mockResolvedValue([certLog()]);
      const res = await processEmailQueue(50, {
        workerId: "w1",
        generateCertificateAttachments: gen,
      });
      expect(gen).toHaveBeenCalledWith(
        expect.objectContaining({
          registrationId: "reg-1",
          certificateTemplateIds: ["c1", "c2"],
        }),
      );
      expect(sendEmailMock).toHaveBeenCalledWith(
        expect.objectContaining({ attachments: [attachment, attachment] }),
      );
      expect(res.sent).toBe(1);
    });

    it("fails when fewer attachments are generated than queued", async () => {
      const gen = vi.fn().mockResolvedValue([attachment]); // 1 < 2
      mocked(claimQueuedEmailLogs).mockResolvedValue(["log-1"]);
      mocked(getClaimedEmailLogsForProcessing).mockResolvedValue([certLog()]);
      const res = await processEmailQueue(50, {
        workerId: "w1",
        generateCertificateAttachments: gen,
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(markEmailFailed).toHaveBeenCalledWith(
        "log-1",
        "w1",
        "Fewer certificate attachments generated than queued",
        1,
        3,
      );
      expect(res.failed).toBe(1);
    });

    it("skips when the generator returns zero attachments", async () => {
      const gen = vi.fn().mockResolvedValue([]);
      mocked(claimQueuedEmailLogs).mockResolvedValue(["log-1"]);
      mocked(getClaimedEmailLogsForProcessing).mockResolvedValue([certLog()]);
      const res = await processEmailQueue(50, {
        workerId: "w1",
        generateCertificateAttachments: gen,
      });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(markEmailSkipped).toHaveBeenCalledWith(
        "log-1",
        "w1",
        "No eligible certificates to attach",
      );
      expect(res.skipped).toBe(1);
    });

    it("fails when certificate generation throws", async () => {
      const gen = vi.fn().mockRejectedValue(new Error("pdf boom"));
      mocked(claimQueuedEmailLogs).mockResolvedValue(["log-1"]);
      mocked(getClaimedEmailLogsForProcessing).mockResolvedValue([certLog()]);
      const res = await processEmailQueue(50, {
        workerId: "w1",
        generateCertificateAttachments: gen,
      });
      expect(markEmailFailed).toHaveBeenCalledWith(
        "log-1",
        "w1",
        "pdf boom",
        1,
        3,
      );
      expect(res.failed).toBe(1);
    });

    it("fails when no generator is injected for a certificate email", async () => {
      const res = await runOne(certLog());
      expect(markEmailFailed).toHaveBeenCalledWith(
        "log-1",
        "w1",
        "Certificate attachment generator not configured",
        1,
        3,
      );
      expect(res.failed).toBe(1);
    });
  });
});

describe("updateEmailStatusFromWebhook", () => {
  beforeEach(() => {
    mocked(updateEmailLogStatusGuarded).mockResolvedValue(true);
  });

  it("applies DELIVERED with a deliveredAt timestamp", async () => {
    mocked(readEmailLogStatus).mockResolvedValue("SENT");
    await updateEmailStatusFromWebhook("log-1", "delivered");
    expect(updateEmailLogStatusGuarded).toHaveBeenCalledWith(
      "log-1",
      "SENT",
      expect.objectContaining({ status: "DELIVERED", deliveredAt: expect.any(Date) }),
    );
  });

  it("applies OPENED and CLICKED to the right timestamp fields", async () => {
    mocked(readEmailLogStatus).mockResolvedValue("DELIVERED");
    await updateEmailStatusFromWebhook("log-1", "open");
    expect(updateEmailLogStatusGuarded).toHaveBeenCalledWith(
      "log-1",
      "DELIVERED",
      expect.objectContaining({ status: "OPENED", openedAt: expect.any(Date) }),
    );
    mocked(readEmailLogStatus).mockResolvedValue("OPENED");
    await updateEmailStatusFromWebhook("log-1", "click");
    expect(updateEmailLogStatusGuarded).toHaveBeenLastCalledWith(
      "log-1",
      "OPENED",
      expect.objectContaining({ status: "CLICKED", clickedAt: expect.any(Date) }),
    );
  });

  it("uses the metadata reason for bounces, defaulting to 'Bounced'", async () => {
    mocked(readEmailLogStatus).mockResolvedValue("SENT");
    await updateEmailStatusFromWebhook("log-1", "bounce", { reason: "mailbox full" });
    expect(updateEmailLogStatusGuarded).toHaveBeenCalledWith(
      "log-1",
      "SENT",
      expect.objectContaining({ status: "BOUNCED", errorMessage: "mailbox full" }),
    );
    mocked(readEmailLogStatus).mockResolvedValue("SENT");
    await updateEmailStatusFromWebhook("log-1", "bounce");
    expect(updateEmailLogStatusGuarded).toHaveBeenLastCalledWith(
      "log-1",
      "SENT",
      expect.objectContaining({ errorMessage: "Bounced" }),
    );
  });

  it("defaults the dropped reason to 'Dropped'", async () => {
    mocked(readEmailLogStatus).mockResolvedValue("SENT");
    await updateEmailStatusFromWebhook("log-1", "dropped");
    expect(updateEmailLogStatusGuarded).toHaveBeenCalledWith(
      "log-1",
      "SENT",
      expect.objectContaining({ status: "DROPPED", errorMessage: "Dropped" }),
    );
  });

  it("no-ops for an unknown email log", async () => {
    mocked(readEmailLogStatus).mockResolvedValue(null);
    await updateEmailStatusFromWebhook("nope", "delivered");
    expect(updateEmailLogStatusGuarded).not.toHaveBeenCalled();
  });

  it("never overwrites a terminal status", async () => {
    mocked(readEmailLogStatus).mockResolvedValue("BOUNCED");
    await updateEmailStatusFromWebhook("log-1", "delivered");
    expect(updateEmailLogStatusGuarded).not.toHaveBeenCalled();
  });

  it("rejects backward transitions", async () => {
    mocked(readEmailLogStatus).mockResolvedValue("OPENED");
    await updateEmailStatusFromWebhook("log-1", "delivered"); // DELIVERED < OPENED
    expect(updateEmailLogStatusGuarded).not.toHaveBeenCalled();
  });

  it("swallows a concurrent status change (guarded update returns false)", async () => {
    mocked(readEmailLogStatus).mockResolvedValue("SENT");
    mocked(updateEmailLogStatusGuarded).mockResolvedValue(false);
    await expect(
      updateEmailStatusFromWebhook("log-1", "delivered"),
    ).resolves.toBeUndefined();
  });

  it("swallows DB errors and never throws", async () => {
    mocked(readEmailLogStatus).mockRejectedValue(new Error("db down"));
    await expect(
      updateEmailStatusFromWebhook("log-1", "delivered"),
    ).resolves.toBeUndefined();
  });
});
