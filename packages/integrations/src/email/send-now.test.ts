import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/db", async () => ({
  ...(await vi.importActual<typeof import("@app/db")>("@app/db")),
  createSendNowEmailLog: vi.fn(),
  markEmailSent: vi.fn(),
  markEmailFailed: vi.fn(),
  markEmailUncertain: vi.fn(),
}));

const sendEmailMock = vi.fn();
let providerName: "sendgrid" | "resend" = "sendgrid";
vi.mock("./providers/index", () => ({
  getEmailProvider: () => ({ name: providerName, sendEmail: sendEmailMock }),
}));

import { createSendNowEmailLog, markEmailFailed, markEmailSent, markEmailUncertain } from "@app/db";
import { acceptedSend, ambiguousSend, rejectedSend } from "./providers/email-provider.types";
import { setEmailStatusChangeListener } from "./queue";
import { sendEmailNow, type SendEmailNowInput } from "./send-now";

const mocked = <T>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;
const WORKER = expect.stringMatching(/^email-now:/);

const input: SendEmailNowInput = {
  to: "ada@example.test",
  toName: "Ada",
  subject: "Hello",
  html: "<p>Hi</p>",
  plainText: "Hi",
  categories: ["custom-one-off"],
  log: { registrationId: "reg-1", contextSnapshot: { firstName: "Ada" } },
};

let notified: Array<[string, string]>;

beforeEach(() => {
  vi.clearAllMocks();
  providerName = "sendgrid";
  notified = [];
  setEmailStatusChangeListener((id, status) => {
    notified.push([id, status]);
  });
  mocked(createSendNowEmailLog).mockResolvedValue({ id: "log-1" });
  mocked(markEmailSent).mockResolvedValue(true);
  mocked(markEmailFailed).mockResolvedValue(true);
  mocked(markEmailUncertain).mockResolvedValue(true);
});

afterEach(() => setEmailStatusChangeListener(undefined));

describe("sendEmailNow (3.6b)", () => {
  it("writes the leased log first, sends under its id, and records SENT", async () => {
    const order: string[] = [];
    mocked(createSendNowEmailLog).mockImplementation(async () => {
      order.push("log");
      return { id: "log-1" };
    });
    sendEmailMock.mockImplementation(async () => {
      order.push("send");
      return acceptedSend("msg-1");
    });

    await expect(sendEmailNow(input)).resolves.toEqual({ status: "SENT", emailLogId: "log-1", messageId: "msg-1" });

    expect(order).toEqual(["log", "send"]);
    expect(createSendNowEmailLog).toHaveBeenCalledWith(
      {
        registrationId: "reg-1",
        contextSnapshot: { firstName: "Ada" },
        recipientEmail: "ada@example.test",
        recipientName: "Ada",
        subject: "Hello",
      },
      WORKER,
      "sendgrid",
    );
    expect(sendEmailMock).toHaveBeenCalledWith({
      to: "ada@example.test",
      toName: "Ada",
      subject: "Hello",
      html: "<p>Hi</p>",
      plainText: "Hi",
      categories: ["custom-one-off"],
      trackingId: "log-1",
    });
    expect(markEmailSent).toHaveBeenCalledWith("log-1", WORKER, "msg-1");
    expect(notified).toEqual([
      ["log-1", "SENDING"],
      ["log-1", "SENT"],
    ]);
  });

  it("records a refusal as FAILED, never requeued (max_retries 0)", async () => {
    sendEmailMock.mockResolvedValue(rejectedSend("550 mailbox unavailable", 400));
    await expect(sendEmailNow(input)).resolves.toEqual({
      status: "FAILED",
      emailLogId: "log-1",
      error: "550 mailbox unavailable",
    });
    expect(markEmailFailed).toHaveBeenCalledWith("log-1", WORKER, "550 mailbox unavailable", 1, 0);
    expect(notified.at(-1)).toEqual(["log-1", "FAILED"]);
  });

  it.each([
    ["sendgrid", ambiguousSend("socket hang up")],
    ["resend", ambiguousSend("socket hang up", { idempotentRetry: true })],
  ] as const)("parks an ambiguous %s send as UNCERTAIN without sending again", async (provider, result) => {
    providerName = provider;
    sendEmailMock.mockResolvedValue(result);
    await expect(sendEmailNow(input)).resolves.toEqual({
      status: "UNCERTAIN",
      emailLogId: "log-1",
      error: "socket hang up",
    });
    expect(sendEmailMock).toHaveBeenCalledOnce();
    expect(markEmailUncertain).toHaveBeenCalledWith(
      "log-1",
      WORKER,
      "Email provider outcome unknown; not resent automatically: socket hang up",
    );
    expect(markEmailFailed).not.toHaveBeenCalled();
    expect(notified.at(-1)).toEqual(["log-1", "UNCERTAIN"]);
  });

  it("treats a provider throw as ambiguous", async () => {
    sendEmailMock.mockRejectedValue(new Error("boom"));
    await expect(sendEmailNow(input)).resolves.toMatchObject({ status: "UNCERTAIN", error: "boom" });
    expect(markEmailFailed).not.toHaveBeenCalled();
  });

  it("still reports SENT when the SENT write keeps failing, and never marks it failed", async () => {
    sendEmailMock.mockResolvedValue(acceptedSend("msg-1"));
    mocked(markEmailSent).mockRejectedValue(new Error("db down"));
    await expect(sendEmailNow(input)).resolves.toEqual({ status: "SENT", emailLogId: "log-1", messageId: "msg-1" });
    // Three tries; then the row keeps its lease and marker for recovery.
    expect(markEmailSent).toHaveBeenCalledTimes(3);
    expect(markEmailFailed).not.toHaveBeenCalled();
    expect(markEmailUncertain).not.toHaveBeenCalled();
    expect(notified).toEqual([["log-1", "SENDING"]]);
  });

  it("does not notify when the lease was already taken over", async () => {
    sendEmailMock.mockResolvedValue(acceptedSend("msg-1"));
    mocked(markEmailSent).mockResolvedValue(false);
    await expect(sendEmailNow(input)).resolves.toMatchObject({ status: "SENT" });
    expect(notified).toEqual([["log-1", "SENDING"]]);
  });

  it("sends nothing when the log cannot be written", async () => {
    mocked(createSendNowEmailLog).mockRejectedValue(new Error("db down"));
    await expect(sendEmailNow(input)).rejects.toThrow("db down");
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(notified).toEqual([]);
  });

  it("records a missing name as null", async () => {
    sendEmailMock.mockResolvedValue(acceptedSend(undefined));
    await sendEmailNow({ to: "x@example.test", subject: "S", html: "h" });
    expect(createSendNowEmailLog).toHaveBeenCalledWith(
      { recipientEmail: "x@example.test", recipientName: null, subject: "S" },
      WORKER,
      "sendgrid",
    );
  });
});
