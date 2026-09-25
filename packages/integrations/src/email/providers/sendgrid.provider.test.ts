import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventWebhookHeader } from "@sendgrid/eventwebhook";
import { SendgridProvider, classifySendgridError, mapSendgridEvents } from "./sendgrid.provider";

const { sendGridMock } = vi.hoisted(() => ({
  sendGridMock: {
    setApiKey: vi.fn(),
    setTimeout: vi.fn(),
    send: vi.fn().mockResolvedValue([
      {
        statusCode: 202,
        headers: { "x-message-id": "mock-message-id-123" },
        body: "",
      },
      {},
    ]),
  },
}));

vi.mock("@sendgrid/mail", () => ({
  default: sendGridMock,
  setApiKey: sendGridMock.setApiKey,
  setTimeout: sendGridMock.setTimeout,
  send: sendGridMock.send,
}));

function resetSendGridMock(): void {
  sendGridMock.setApiKey.mockClear();
  sendGridMock.send.mockClear();
  sendGridMock.send.mockResolvedValue([
    {
      statusCode: 202,
      headers: { "x-message-id": "mock-message-id-123" },
      body: "",
    },
    {},
  ]);
}

const FROM = { fromEmail: "noreply@focale.test", fromName: "Focale" };
const SIG_HEADER = EventWebhookHeader.SIGNATURE().toLowerCase();
const TS_HEADER = EventWebhookHeader.TIMESTAMP().toLowerCase();

describe("mapSendgridEvents", () => {
  it("maps handled events and attaches url/reason metadata", () => {
    const { events } = mapSendgridEvents([
      { event: "delivered", emailLogId: "log-1" },
      { event: "click", emailLogId: "log-2", url: "https://x" },
      { event: "bounce", emailLogId: "log-3", reason: "550 no mailbox" },
    ]);
    expect(events).toEqual([
      { emailLogId: "log-1", type: "delivered", metadata: { url: undefined, reason: undefined } },
      { emailLogId: "log-2", type: "click", metadata: { url: "https://x", reason: undefined } },
      { emailLogId: "log-3", type: "bounce", metadata: { url: undefined, reason: "550 no mailbox" } },
    ]);
  });

  it("skips events with no emailLogId and unknown event names", () => {
    const { events, logOnly } = mapSendgridEvents([
      { event: "delivered" }, // no emailLogId
      { event: "group_resubscribe", emailLogId: "log-1" }, // not handled
    ]);
    expect(events).toEqual([]);
    expect(logOnly).toEqual([]);
  });

  it("maps processed (SendGrid took the email) for UNCERTAIN reconciliation", () => {
    const { events } = mapSendgridEvents([{ event: "processed", emailLogId: "log-1" }]);
    expect(events).toEqual([
      { emailLogId: "log-1", type: "processed", metadata: { url: undefined, reason: undefined } },
    ]);
  });

  it("routes deferred to log-only", () => {
    const { events, logOnly } = mapSendgridEvents([
      { event: "deferred", emailLogId: "log-1", reason: "try later" },
    ]);
    expect(events).toEqual([]);
    expect(logOnly).toEqual([{ type: "deferred", emailLogId: "log-1", reason: "try later" }]);
  });

  it("returns empty for a non-array payload", () => {
    expect(mapSendgridEvents({ not: "an array" })).toEqual({ events: [], logOnly: [] });
  });
});

describe("SendgridProvider", () => {
  beforeEach(() => resetSendGridMock());

  it("sends and extracts the x-message-id", async () => {
    const provider = new SendgridProvider({ apiKey: "SG.test", ...FROM });
    const result = await provider.sendEmail({
      to: "doctor@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
    });
    expect(result).toEqual({ outcome: "accepted", success: true, messageId: "mock-message-id-123" });
    expect(sendGridMock.send).toHaveBeenCalledTimes(1);
    // A stalled request cannot hold the email job past 15 s.
    expect(sendGridMock.setTimeout).toHaveBeenCalledWith(15_000);
  });

  it("reports not-configured without calling the API", async () => {
    const provider = new SendgridProvider({ ...FROM });
    const result = await provider.sendEmail({
      to: "doctor@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
    });
    expect(result).toMatchObject({ outcome: "rejected", success: false });
    expect(sendGridMock.send).not.toHaveBeenCalled();
  });

  it("reports a timeout after the request left as ambiguous (never retried blind)", async () => {
    sendGridMock.send.mockRejectedValueOnce(
      Object.assign(new Error("timeout of 15000ms exceeded"), { isAxiosError: true, code: "ECONNABORTED" }),
    );
    const provider = new SendgridProvider({ apiKey: "SG.test", ...FROM });
    const result = await provider.sendEmail({ to: "a@example.com", subject: "Hi", html: "<p>Hi</p>", trackingId: "log-1" });
    expect(result).toEqual({
      outcome: "ambiguous",
      success: false,
      error: "timeout of 15000ms exceeded",
      idempotentRetry: false,
    });
  });

  it("reports an HTTP 4xx as rejected, with its status and SendGrid's message", async () => {
    sendGridMock.send.mockRejectedValueOnce(
      Object.assign(new Error("Bad Request"), {
        code: 400,
        response: { headers: {}, body: { errors: [{ message: "Invalid from address" }] } },
      }),
    );
    const provider = new SendgridProvider({ apiKey: "SG.test", ...FROM });
    const result = await provider.sendEmail({ to: "a@example.com", subject: "Hi", html: "<p>Hi</p>" });
    expect(result).toEqual({ outcome: "rejected", success: false, error: "Invalid from address", statusCode: 400 });
  });

  it("returns unconfigured when no webhook public key is set", () => {
    const provider = new SendgridProvider({ apiKey: "SG.test", ...FROM });
    expect(provider.handleWebhook(Buffer.from("[]"), {})).toEqual({
      ok: false,
      reason: "unconfigured",
    });
  });

  it("rejects stale webhook timestamps before verifying the signature", () => {
    const provider = new SendgridProvider({
      webhookPublicKey: "pk",
      ...FROM,
    });
    const staleTs = String(Math.floor((Date.now() - 10 * 60 * 1000) / 1000));
    const out = provider.handleWebhook(Buffer.from("[]"), {
      [SIG_HEADER]: "sig",
      [TS_HEADER]: staleTs,
    });
    expect(out).toEqual({ ok: false, reason: "stale" });
  });

  it("rejects a non-numeric timestamp as stale", () => {
    const provider = new SendgridProvider({ webhookPublicKey: "pk", ...FROM });
    const out = provider.handleWebhook(Buffer.from("[]"), {
      [SIG_HEADER]: "sig",
      [TS_HEADER]: "not-a-number",
    });
    expect(out).toEqual({ ok: false, reason: "stale" });
  });
});

describe("classifySendgridError", () => {
  const httpError = (status: number) =>
    Object.assign(new Error("HTTP error"), { code: status, response: { headers: {}, body: {} } });
  const clientError = (code: string) => Object.assign(new Error(code), { isAxiosError: true, code });

  it.each([400, 401, 403, 413, 429, 500, 503])("HTTP %i is a definitive rejection", (status) => {
    expect(classifySendgridError(httpError(status))).toMatchObject({ outcome: "rejected", statusCode: status });
  });

  it.each([502, 504])("gateway HTTP %i is ambiguous (SendGrid may have taken it)", (status) => {
    expect(classifySendgridError(httpError(status))).toMatchObject({ outcome: "ambiguous", statusCode: status });
  });

  it.each(["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EPIPE", "ERR_NETWORK", "ERR_CANCELED"])(
    "%s after the request may have left is ambiguous",
    (code) => {
      expect(classifySendgridError(clientError(code))).toMatchObject({ outcome: "ambiguous", idempotentRetry: false });
    },
  );

  it.each(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"])("%s (never connected) is rejected", (code) => {
    expect(classifySendgridError(clientError(code))).toMatchObject({ outcome: "rejected" });
  });

  it("a library error raised before the request (message validation) is rejected", () => {
    expect(classifySendgridError(new Error("Provide at least one of to, cc or bcc"))).toMatchObject({
      outcome: "rejected",
      error: "Provide at least one of to, cc or bcc",
    });
  });

  it("anything else is ambiguous", () => {
    expect(classifySendgridError("socket hang up")).toMatchObject({ outcome: "ambiguous", error: "Unknown error" });
    expect(classifySendgridError(undefined)).toMatchObject({ outcome: "ambiguous" });
  });
});
