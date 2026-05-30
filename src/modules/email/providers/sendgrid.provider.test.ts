import { beforeEach, describe, expect, it } from "vitest";
import { EventWebhookHeader } from "@sendgrid/eventwebhook";
import {
  sendGridMock,
  resetSendGridMock,
} from "../../../../tests/mocks/sendgrid.js";
import { SendgridProvider, mapSendgridEvents } from "./sendgrid.provider.js";

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
      { event: "processed", emailLogId: "log-1" }, // not handled
    ]);
    expect(events).toEqual([]);
    expect(logOnly).toEqual([]);
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
    expect(result).toEqual({ success: true, messageId: "mock-message-id-123" });
    expect(sendGridMock.send).toHaveBeenCalledTimes(1);
  });

  it("reports not-configured without calling the API", async () => {
    const provider = new SendgridProvider({ ...FROM });
    const result = await provider.sendEmail({
      to: "doctor@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
    });
    expect(result.success).toBe(false);
    expect(sendGridMock.send).not.toHaveBeenCalled();
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
