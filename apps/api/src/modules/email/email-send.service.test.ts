import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/db", () => ({
  getRegistrationForEmailContext: vi.fn(),
  getRegistrationsByIds: vi.fn(),
  getRegistrationsByFilters: vi.fn(),
  listSponsorshipBatchesForBulk: vi.fn(),
  getClientById: vi.fn(),
  createEmailLog: vi.fn(),
  createEmailLogsBulk: vi.fn(),
  updateEmailLogById: vi.fn(),
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
}));

import {
  getRegistrationForEmailContext,
  getRegistrationsByIds,
  getRegistrationsByFilters,
  listSponsorshipBatchesForBulk,
  getClientById,
  createEmailLog,
  createEmailLogsBulk,
  updateEmailLogById,
} from "@app/db";
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
    expect(createEmailLog).not.toHaveBeenCalled();
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
    vi.mocked(createEmailLogsBulk).mockResolvedValue(1);
    const res = await service.bulkSend(event, "tmpl-1", {
      audience: "registrants",
      registrationIds: ["r1"],
    });
    expect(res).toEqual({
      success: true,
      queued: 1,
      message: "1 emails queued for sending",
    });
    const rows = vi.mocked(createEmailLogsBulk).mock.calls[0][0];
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
    vi.mocked(createEmailLogsBulk).mockResolvedValue(1);
    await service.bulkSend(event, "tmpl-1", {
      audience: "registrants",
      filters: { paymentStatus: ["PAID"] },
    });
    expect(getRegistrationsByFilters).toHaveBeenCalledWith("event-1", {
      paymentStatus: ["PAID"],
      accessTypeIds: undefined,
      role: undefined,
    });
    const rows = vi.mocked(createEmailLogsBulk).mock.calls[0][0];
    expect(rows[0].recipientName).toBeNull(); // no name → null
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
    expect(createEmailLogsBulk).not.toHaveBeenCalled();
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
    vi.mocked(createEmailLogsBulk).mockResolvedValue(1);

    const res = await service.bulkSend(event, "tmpl-1", {
      audience: "sponsors",
    });
    expect(res.queued).toBe(1);
    const rows = vi.mocked(createEmailLogsBulk).mock.calls[0][0];
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
    expect(createEmailLogsBulk).not.toHaveBeenCalled();
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

  it("creates the EmailLog BEFORE sending and marks SENT on success", async () => {
    vi.mocked(getRegistrationForEmailContext).mockResolvedValue(registration as never);
    vi.mocked(createEmailLog).mockResolvedValue({
      ok: true,
      log: { id: "log-1" },
    } as never);
    const order: string[] = [];
    vi.mocked(createEmailLog).mockImplementation(async () => {
      order.push("create");
      return { ok: true, log: { id: "log-1" } } as never;
    });
    sendEmailMock.mockImplementation(async () => {
      order.push("send");
      return { success: true, messageId: "m1" };
    });

    const res = await service.sendCustom(event, "reg-1", "Subject", content);
    expect(order).toEqual(["create", "send"]);
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ trackingId: "log-1", subject: "Subject" }),
    );
    expect(updateEmailLogById).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ status: "SENT", providerMessageId: "m1" }),
    );
    expect(res).toEqual({
      success: true,
      emailLogId: "log-1",
      messageId: "m1",
    });
  });

  it("marks the log FAILED and throws 502 when the send fails", async () => {
    vi.mocked(getRegistrationForEmailContext).mockResolvedValue(registration as never);
    vi.mocked(createEmailLog).mockResolvedValue({
      ok: true,
      log: { id: "log-1" },
    } as never);
    sendEmailMock.mockResolvedValue({ success: false, error: "boom" });

    await expect(
      service.sendCustom(event, "reg-1", "S", content),
    ).rejects.toMatchObject({ status: 502 });
    expect(updateEmailLogById).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ status: "FAILED", errorMessage: "boom" }),
    );
  });
});
