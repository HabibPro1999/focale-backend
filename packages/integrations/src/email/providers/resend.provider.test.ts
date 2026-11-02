import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ResendProvider,
  classifyResendError,
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

  it("maps sent to processed (Resend took the email)", () => {
    const out = normalizeResendEvents({ type: "email.sent", created_at: "", data: data() } as never);
    expect(out.events).toEqual([{ emailLogId: "log-1", type: "processed" }]);
    expect(out.logOnly).toEqual([]);
  });

  it("treats scheduled/delivery_delayed as log-only", () => {
    const out = normalizeResendEvents({ type: "email.delivery_delayed", created_at: "", data: data() } as never);
    expect(out.events).toEqual([]);
    expect(out.logOnly).toEqual([{ type: "email.delivery_delayed", emailLogId: "log-1" }]);
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

    expect(result).toEqual({ outcome: "accepted", success: true, messageId: "mock-resend-id" });
    expect(resendMock.send).toHaveBeenCalledTimes(1);
    const [, opts] = resendMock.send.mock.calls[0];
    expect(opts).toEqual({ idempotencyKey: "log-9", signal: expect.any(AbortSignal) });
  });

  it("surfaces a returned Resend HTTP error as a rejected result", async () => {
    resendMock.send.mockResolvedValue({ data: null, error: { name: "validation_error", message: "bad from", statusCode: 422 } });
    const result = await configured().sendEmail(baseInput());
    expect(result).toEqual({ outcome: "rejected", success: false, error: "bad from", statusCode: 422 });
  });

  it("reports a request without a response as ambiguous, retryable under the same idempotency key", async () => {
    mockResendFailure({ name: "application_error", message: "Unable to fetch data. The request could not be resolved." });
    const result = await configured().sendEmail(baseInput({ trackingId: "log-7" }));
    expect(result).toMatchObject({ outcome: "ambiguous", success: false, idempotentRetry: true });
  });

  it("reports not-configured without calling the API", async () => {
    const provider = new ResendProvider({ ...FROM });
    const result = await provider.sendEmail(baseInput());
    expect(result).toMatchObject({ outcome: "rejected", success: false });
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

describe("classifyResendError", () => {
  it("no response (network error or our timeout abort) is ambiguous, retryable under the key", () => {
    expect(classifyResendError({ name: "application_error", message: "Unable to fetch data.", statusCode: null }, true)).toEqual({
      outcome: "ambiguous",
      success: false,
      error: "Unable to fetch data.",
      idempotentRetry: true,
    });
    // Without an idempotency key a retry could send twice.
    expect(classifyResendError({ name: "application_error", message: "x" }, false)).toMatchObject({
      outcome: "ambiguous",
      idempotentRetry: false,
    });
  });

  it("a 5xx or a concurrent request with the same key is ambiguous, retryable", () => {
    expect(classifyResendError({ name: "internal_server_error", message: "x", statusCode: 500 }, true)).toMatchObject({
      outcome: "ambiguous",
      statusCode: 500,
      idempotentRetry: true,
    });
    expect(classifyResendError({ name: "concurrent_idempotent_requests", message: "x", statusCode: 409 }, true)).toMatchObject({
      outcome: "ambiguous",
      idempotentRetry: true,
    });
  });

  it("a key already used with another payload is ambiguous and not retryable (an earlier request reached Resend)", () => {
    expect(classifyResendError({ name: "invalid_idempotent_request", message: "x", statusCode: 409 }, true)).toMatchObject({
      outcome: "ambiguous",
      idempotentRetry: false,
    });
  });

  it.each([
    ["validation_error", 422],
    ["invalid_api_key", 403],
    ["rate_limit_exceeded", 429],
    ["daily_quota_exceeded", 429],
  ])("%s (%i) is rejected", (name, statusCode) => {
    expect(classifyResendError({ name, message: "x", statusCode }, true)).toMatchObject({ outcome: "rejected", statusCode });
  });
});
