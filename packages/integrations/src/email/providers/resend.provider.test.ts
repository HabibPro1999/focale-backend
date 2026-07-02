import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResendProvider,
  buildResendPayload,
  normalizeResendEvents,
  sanitizeTagValue,
} from "./resend.provider";
import type { SendEmailInput } from "./email-provider.types";

const { resendMock } = vi.hoisted(() => ({
  resendMock: {
    send: vi
      .fn()
      .mockResolvedValue({ data: { id: "mock-resend-id" }, error: null }),
    verify: vi.fn(),
  },
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => resendMock.send(...args) };
    webhooks = { verify: (...args: unknown[]) => resendMock.verify(...args) };
    constructor(_key?: string) {}
  },
}));

function resetResendMock(): void {
  resendMock.send
    .mockReset()
    .mockResolvedValue({ data: { id: "mock-resend-id" }, error: null });
  resendMock.verify.mockReset();
}

function mockResendFailure(
  error: { name: string; message: string } = {
    name: "application_error",
    message: "Resend API error",
  },
): void {
  resendMock.send.mockResolvedValue({ data: null, error });
}

const FROM = { fromEmail: "noreply@focale.test", fromName: "Focale" };

function baseInput(overrides: Partial<SendEmailInput> = {}): SendEmailInput {
  return {
    to: "doctor@example.com",
    subject: "Hello",
    html: "<p>Hi <b>there</b></p>",
    ...overrides,
  };
}

describe("sanitizeTagValue", () => {
  it("replaces disallowed characters with underscores", () => {
    expect(sanitizeTagValue("payment confirmed!")).toBe("payment_confirmed_");
    expect(sanitizeTagValue("a@b.c/d")).toBe("a_b_c_d");
  });

  it("keeps valid characters incl. UUID dashes", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(sanitizeTagValue(uuid)).toBe(uuid);
  });

  it("truncates to 256 characters", () => {
    expect(sanitizeTagValue("a".repeat(300))).toHaveLength(256);
  });
});

describe("buildResendPayload", () => {
  it("formats from/to/replyTo with names", () => {
    const payload = buildResendPayload(
      baseInput({
        toName: "Dr Doe",
        fromName: "Congress 2026",
        replyTo: "org@example.com",
        replyToName: "Organizer",
      }),
      FROM,
    );
    expect(payload.from).toBe("Congress 2026 <noreply@focale.test>");
    expect(payload.to).toBe("Dr Doe <doctor@example.com>");
    expect(payload.replyTo).toBe("Organizer <org@example.com>");
  });

  it("falls back to the configured sender name and bare addresses", () => {
    const payload = buildResendPayload(baseInput(), FROM);
    expect(payload.from).toBe("Focale <noreply@focale.test>");
    expect(payload.to).toBe("doctor@example.com");
    expect(payload.replyTo).toBeUndefined();
  });

  it("uses plainText when present, else strips the HTML", () => {
    expect(buildResendPayload(baseInput({ plainText: "Plain" }), FROM).text).toBe(
      "Plain",
    );
    expect(buildResendPayload(baseInput(), FROM).text).toBe("Hi there");
  });

  it("carries trackingId and sanitized categories as tags", () => {
    const payload = buildResendPayload(
      baseInput({ trackingId: "log-123", categories: ["custom one-off"] }),
      FROM,
    );
    expect(payload.tags).toEqual([
      { name: "email_log_id", value: "log-123" },
      { name: "category", value: "custom_one-off" },
    ]);
  });

  it("omits tags entirely when there is nothing to tag", () => {
    expect(buildResendPayload(baseInput(), FROM).tags).toBeUndefined();
  });

  it("maps attachments to base64-decoded buffers with contentType", () => {
    const payload = buildResendPayload(
      baseInput({
        attachments: [
          {
            content: Buffer.from("hello").toString("base64"),
            filename: "c.pdf",
            type: "application/pdf",
            disposition: "attachment",
          },
        ],
      }),
      FROM,
    );
    const att = payload.attachments![0];
    expect(att.filename).toBe("c.pdf");
    expect(att.contentType).toBe("application/pdf");
    expect(Buffer.isBuffer(att.content)).toBe(true);
    expect((att.content as Buffer).toString()).toBe("hello");
  });
});

describe("normalizeResendEvents", () => {
  const data = (extra: Record<string, unknown> = {}) => ({
    email_id: "resend-id",
    from: "a@b.c",
    to: ["x@y.z"],
    subject: "s",
    created_at: "2026-01-01T00:00:00Z",
    tags: { email_log_id: "log-1" },
    ...extra,
  });

  it("maps delivered/opened", () => {
    expect(
      normalizeResendEvents({ type: "email.delivered", created_at: "", data: data() } as never).events,
    ).toEqual([{ emailLogId: "log-1", type: "delivered" }]);
    expect(
      normalizeResendEvents({ type: "email.opened", created_at: "", data: data() } as never).events,
    ).toEqual([{ emailLogId: "log-1", type: "open" }]);
  });

  it("maps clicked with the link url", () => {
    const out = normalizeResendEvents({
      type: "email.clicked",
      created_at: "",
      data: data({ click: { link: "https://focale.test/x" } }),
    } as never);
    expect(out.events).toEqual([
      { emailLogId: "log-1", type: "click", metadata: { url: "https://focale.test/x" } },
    ]);
  });

  it("maps bounced/failed/suppressed to terminal statuses with reasons", () => {
    expect(
      normalizeResendEvents({
        type: "email.bounced",
        created_at: "",
        data: data({ bounce: { message: "hard bounce", type: "Permanent", subType: "" } }),
      } as never).events,
    ).toEqual([{ emailLogId: "log-1", type: "bounce", metadata: { reason: "hard bounce" } }]);

    expect(
      normalizeResendEvents({
        type: "email.failed",
        created_at: "",
        data: data({ failed: { reason: "quota" } }),
      } as never).events,
    ).toEqual([{ emailLogId: "log-1", type: "dropped", metadata: { reason: "quota" } }]);

    expect(
      normalizeResendEvents({
        type: "email.suppressed",
        created_at: "",
        data: data({ suppressed: { message: "on list", type: "" } }),
      } as never).events[0].type,
    ).toBe("dropped");
  });

  it("maps complained to spam_report", () => {
    expect(
      normalizeResendEvents({ type: "email.complained", created_at: "", data: data() } as never)
        .events[0].type,
    ).toBe("spam_report");
  });

  it("treats sent/scheduled/delivery_delayed as log-only", () => {
    const out = normalizeResendEvents({ type: "email.sent", created_at: "", data: data() } as never);
    expect(out.events).toEqual([]);
    expect(out.logOnly).toEqual([{ type: "email.sent", emailLogId: "log-1" }]);
  });

  it("drops status events that carry no email_log_id tag", () => {
    const out = normalizeResendEvents({
      type: "email.delivered",
      created_at: "",
      data: data({ tags: {} }),
    } as never);
    expect(out.events).toEqual([]);
  });

  it("ignores non-email events", () => {
    const out = normalizeResendEvents({
      type: "domain.created",
      created_at: "",
      data: { id: "d" },
    } as never);
    expect(out.events).toEqual([]);
    expect(out.logOnly).toEqual([]);
  });
});

describe("ResendProvider", () => {
  beforeEach(() => resetResendMock());

  const configured = () =>
    new ResendProvider({
      apiKey: "re_test",
      webhookSecret: "whsec_test",
      ...FROM,
    });

  it("sends and returns the provider message id + idempotency key", async () => {
    const provider = configured();
    const result = await provider.sendEmail(baseInput({ trackingId: "log-9" }));

    expect(result).toEqual({ success: true, messageId: "mock-resend-id" });
    expect(resendMock.send).toHaveBeenCalledTimes(1);
    const [, opts] = resendMock.send.mock.calls[0];
    expect(opts).toEqual({ idempotencyKey: "log-9" });
  });

  it("surfaces a returned Resend error as a failed result", async () => {
    mockResendFailure({ name: "validation_error", message: "bad from" });
    const result = await configured().sendEmail(baseInput());
    expect(result).toEqual({ success: false, error: "bad from" });
  });

  it("reports not-configured without calling the API", async () => {
    const provider = new ResendProvider({ ...FROM });
    const result = await provider.sendEmail(baseInput());
    expect(result.success).toBe(false);
    expect(resendMock.send).not.toHaveBeenCalled();
  });

  it("returns unconfigured when no webhook secret is set", () => {
    const provider = new ResendProvider({ apiKey: "re_test", ...FROM });
    const out = provider.handleWebhook(Buffer.from("{}"), {});
    expect(out).toEqual({ ok: false, reason: "unconfigured" });
  });

  it("rejects webhooks missing svix headers", () => {
    const out = configured().handleWebhook(Buffer.from("{}"), {});
    expect(out).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects webhooks whose signature fails verification", () => {
    resendMock.verify.mockImplementation(() => {
      throw new Error("bad signature");
    });
    const out = configured().handleWebhook(Buffer.from("{}"), {
      "svix-id": "id",
      "svix-timestamp": "ts",
      "svix-signature": "sig",
    });
    expect(out).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("verifies and normalizes a valid webhook", () => {
    resendMock.verify.mockReturnValue({
      type: "email.delivered",
      created_at: "",
      data: {
        email_id: "resend-id",
        from: "a@b.c",
        to: ["x@y.z"],
        subject: "s",
        created_at: "",
        tags: { email_log_id: "log-7" },
      },
    });
    const out = configured().handleWebhook(Buffer.from("{}"), {
      "svix-id": "id",
      "svix-timestamp": "ts",
      "svix-signature": "sig",
    });
    expect(out).toEqual({
      ok: true,
      events: [{ emailLogId: "log-7", type: "delivered" }],
      logOnly: [],
    });
  });
});
