import { beforeEach, describe, expect, it, vi } from "vitest";

const { tx } = vi.hoisted(() => ({ tx: { executor: "tx" } }));
vi.mock("@app/db", () => ({
  withTxn: (fn: (exec: unknown) => unknown) => fn(tx),
  getRegistrationForEmailContext: vi.fn(),
  getRegistrationsByIds: vi.fn(),
  getRegistrationsByFilters: vi.fn(),
  listSponsorshipBatchesForBulk: vi.fn(),
  getClientById: vi.fn(),
  insertEmailLogsSkippingConflicts: vi.fn(),
}));

const sendEmailMock = vi.fn();
vi.mock("@app/integrations", () => ({
  getEmailProvider: () => ({ sendEmail: sendEmailMock }),
  getSampleEmailContext: vi.fn(() => ({})),
  resolveVariables: vi.fn((tpl: string) => tpl),
  buildEmailContextWithAccess: vi.fn(async () => ({
    eventName: "Conf",
    organizerEmail: "org@x.com",
    organizerName: "Org",
  })),
  buildBatchEmailContext: vi.fn(() => ({ labName: "Lab" })),
  renderTemplateToMjml: vi.fn(() => "MJML"),
  compileMjmlToHtml: vi.fn(() => ({ html: "HTML", errors: [] })),
  extractPlainText: vi.fn(() => "PLAIN"),
  resendUncertainEmail: vi.fn(),
  sendEmailNow: vi.fn(),
}));

import {
  getRegistrationForEmailContext,
  getRegistrationsByIds,
  getRegistrationsByFilters,
  listSponsorshipBatchesForBulk,
  getClientById,
  insertEmailLogsSkippingConflicts,
} from "@app/db";
import { resendUncertainEmail, resolveVariables, sendEmailNow } from "@app/integrations";
import { EmailSendService } from "./email-send.service";

const service = new EmailSendService();

const event = {
  id: "event-1",
  clientId: "client-1",
  name: "Conf",
  startDate: new Date("2025-04-20T00:00:00Z"),
  location: "Tunis",
  pricing: { currency: "TND" },
};

function template(overrides: Record<string, unknown> = {}) {
  return {
    id: "tmpl-1",
    subject: "Hello",
    htmlContent: "<p>hi</p>",
    plainContent: "hi",
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("testSend", () => {
  it("sends synchronously with a [TEST] subject and returns the messageId", async () => {
    sendEmailMock.mockResolvedValue({ success: true, messageId: "m1" });
    const res = await service.testSend(template(), "to@x.com", "Bob");
    expect(res).toEqual({
      success: true,
      message: "Test email sent to to@x.com",
      messageId: "m1",
    });
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "to@x.com",
        toName: "Bob",
        subject: "[TEST] Hello",
        categories: ["test-email"],
      }),
    );
    expect(sendEmailNow).not.toHaveBeenCalled();
    // 6.1: subject and plain text resolve as text; HTML keeps escaping.
    expect(vi.mocked(resolveVariables).mock.calls.map((c) => c[2])).toEqual([
      { mode: "text" },
      undefined,
      { mode: "text" },
    ]);
  });

  it("throws 502 when the provider fails", async () => {
    sendEmailMock.mockResolvedValue({ success: false, error: "smtp down" });
    await expect(
      service.testSend(template(), "to@x.com"),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("bulkSend — registrants", () => {
  it("queues the explicitly listed registrations", async () => {
    vi.mocked(getRegistrationsByIds).mockResolvedValue([
      { id: "r1", email: "a@x.com", firstName: "A", lastName: null },
    ]);
    vi.mocked(insertEmailLogsSkippingConflicts).mockResolvedValue(new Set(["log-1"]));
    const res = await service.bulkSend(event, "tmpl-1", {
      audience: "registrants",
      registrationIds: ["r1"],
    });
    expect(res).toEqual({
      success: true,
      queued: 1,
      message: "1 emails queued for sending",
    });
    const [rows, exec] = vi.mocked(insertEmailLogsSkippingConflicts).mock.calls[0];
    expect(exec).toBe(tx); // one transaction: all-or-nothing batch
    expect(rows[0]).toMatchObject({
      templateId: "tmpl-1",
      registrationId: "r1",
      recipientEmail: "a@x.com",
      recipientName: "A",
      status: "QUEUED",
    });
  });

  it("queries by filters when no ids given", async () => {
    vi.mocked(getRegistrationsByFilters).mockResolvedValue([
      { id: "r2", email: "b@x.com", firstName: null, lastName: null },
    ]);
    vi.mocked(insertEmailLogsSkippingConflicts).mockResolvedValue(new Set(["log-1"]));
    await service.bulkSend(event, "tmpl-1", {
      audience: "registrants",
      filters: { paymentStatus: ["PAID"] },
    });
    expect(getRegistrationsByFilters).toHaveBeenCalledWith("event-1", {
      paymentStatus: ["PAID"],
      accessTypeIds: undefined,
      role: undefined,
    });
    const rows = vi.mocked(insertEmailLogsSkippingConflicts).mock.calls[0][0];
    expect(rows[0].recipientName).toBeNull(); // no name → null
  });

  it("counts only the rows the insert kept (a row a unique index refused is skipped)", async () => {
    vi.mocked(getRegistrationsByIds).mockResolvedValue([
      { id: "r1", email: "a@x.com", firstName: "A", lastName: null },
      { id: "r2", email: "b@x.com", firstName: "B", lastName: null },
    ]);
    vi.mocked(insertEmailLogsSkippingConflicts).mockResolvedValue(new Set(["log-1"]));
    const res = await service.bulkSend(event, "tmpl-1", {
      audience: "registrants",
      registrationIds: ["r1", "r2"],
    });
    expect(vi.mocked(insertEmailLogsSkippingConflicts).mock.calls[0][0]).toHaveLength(2);
    expect(res).toEqual({
      success: true,
      queued: 1,
      message: "1 emails queued for sending",
    });
  });

  it("returns queued:0 with the no-match message when nothing matches", async () => {
    vi.mocked(getRegistrationsByFilters).mockResolvedValue([]);
    const res = await service.bulkSend(event, "tmpl-1", {
      audience: "registrants",
    });
    expect(res).toEqual({
      success: true,
      queued: 0,
      message: "No recipients matched the criteria",
    });
    expect(insertEmailLogsSkippingConflicts).not.toHaveBeenCalled();
  });
});

describe("bulkSend — sponsors", () => {
  it("merges sponsorships across same-email batches into one recipient", async () => {
    vi.mocked(getClientById).mockResolvedValue({ name: "Org" } as never);
    vi.mocked(listSponsorshipBatchesForBulk).mockResolvedValue([
      {
        labName: "Lab New",
        contactName: "New Contact",
        email: "Lab@X.com",
        phone: null,
        sponsorships: [
          { beneficiaryName: "A", beneficiaryEmail: "a@x", totalAmount: 100 },
        ],
      },
      {
        labName: "Lab Old",
        contactName: "Old Contact",
        email: "lab@x.com",
        phone: null,
        sponsorships: [
          { beneficiaryName: "B", beneficiaryEmail: "b@x", totalAmount: 50 },
        ],
      },
    ]);
    vi.mocked(insertEmailLogsSkippingConflicts).mockResolvedValue(new Set(["log-1"]));

    const res = await service.bulkSend(event, "tmpl-1", {
      audience: "sponsors",
    });
    expect(res.queued).toBe(1);
    const rows = vi.mocked(insertEmailLogsSkippingConflicts).mock.calls[0][0];
    expect(rows).toHaveLength(1); // merged into one
    expect(rows[0].recipientEmail).toBe("Lab@X.com"); // newest batch contact info
  });

  it("returns queued:0 when there are no sponsors", async () => {
    vi.mocked(getClientById).mockResolvedValue({ name: "Org" } as never);
    vi.mocked(listSponsorshipBatchesForBulk).mockResolvedValue([]);
    const res = await service.bulkSend(event, "tmpl-1", {
      audience: "sponsors",
    });
    expect(res).toEqual({
      success: true,
      queued: 0,
      message: "No sponsors found for this event",
    });
    expect(insertEmailLogsSkippingConflicts).not.toHaveBeenCalled();
  });
});

describe("sendCustom", () => {
  const registration = {
    id: "reg-1",
    eventId: "event-1",
    email: "reg@x.com",
    firstName: "Reg",
    lastName: "One",
  };
  const content = { type: "doc" as const, content: [] };

  it("404s when the registration is missing or belongs to another event", async () => {
    vi.mocked(getRegistrationForEmailContext).mockResolvedValue(null);
    await expect(
      service.sendCustom(event, "reg-1", "S", content),
    ).rejects.toMatchObject({ status: 404 });

    vi.mocked(getRegistrationForEmailContext).mockResolvedValue({
      ...registration,
      eventId: "other",
    } as never);
    await expect(
      service.sendCustom(event, "reg-1", "S", content),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("sends through sendEmailNow with the registration's log links and reports SENT", async () => {
    vi.mocked(getRegistrationForEmailContext).mockResolvedValue(registration as never);
    vi.mocked(sendEmailNow).mockResolvedValue({ status: "SENT", emailLogId: "log-1", messageId: "m1" });

    const res = await service.sendCustom(event, "reg-1", "Subject", content);
    expect(vi.mocked(resolveVariables).mock.calls.map((c) => c[2])).toEqual([
      { mode: "text" },
      undefined,
      { mode: "text" },
    ]);
    expect(sendEmailNow).toHaveBeenCalledWith({
      to: "reg@x.com",
      toName: "Reg One",
      fromName: "Conf",
      replyTo: "org@x.com",
      replyToName: "Org",
      subject: "Subject",
      html: "HTML",
      plainText: "PLAIN",
      categories: ["custom-one-off"],
      log: {
        registrationId: "reg-1",
        contextSnapshot: { eventName: "Conf", organizerEmail: "org@x.com", organizerName: "Org" },
      },
    });
    expect(res).toEqual({
      success: true,
      emailLogId: "log-1",
      status: "SENT",
      messageId: "m1",
    });
  });

  it("reports an UNCERTAIN send without an error (the provider may have sent it)", async () => {
    vi.mocked(getRegistrationForEmailContext).mockResolvedValue(registration as never);
    vi.mocked(sendEmailNow).mockResolvedValue({ status: "UNCERTAIN", emailLogId: "log-1", error: "timeout" });
    await expect(service.sendCustom(event, "reg-1", "S", content)).resolves.toEqual({
      success: true,
      emailLogId: "log-1",
      status: "UNCERTAIN",
    });
  });

  it("throws 502 when the provider refused the email", async () => {
    vi.mocked(getRegistrationForEmailContext).mockResolvedValue(registration as never);
    vi.mocked(sendEmailNow).mockResolvedValue({ status: "FAILED", emailLogId: "log-1", error: "boom" });

    await expect(
      service.sendCustom(event, "reg-1", "S", content),
    ).rejects.toMatchObject({ status: 502, message: "boom" });
  });
});

describe("resendUncertain (3.6)", () => {
  const resend = vi.mocked(resendUncertainEmail);

  it("returns the queued copy", async () => {
    resend.mockResolvedValue({ ok: true, log: { id: "log-2" } } as never);
    await expect(service.resendUncertain("event-1", "log-1")).resolves.toEqual({
      id: "log-2",
      status: "QUEUED",
      resentFrom: "log-1",
    });
    expect(resend).toHaveBeenCalledWith("event-1", "log-1");
  });

  it.each([
    ["not_found", 404, "RES_3001"],
    ["not_uncertain", 409, "RES_3002"],
    ["not_resendable", 409, "RES_3002"],
    ["already_active", 409, "RES_3002"],
  ] as const)("maps %s to %i %s", async (reason, status, code) => {
    resend.mockResolvedValue({ ok: false, reason });
    const error = await service.resendUncertain("event-1", "log-1").catch((err: unknown) => err);
    expect(error).toMatchObject({ statusCode: status, code });
  });
});
