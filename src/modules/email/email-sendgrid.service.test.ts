import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
  vi,
} from "vitest";

// ─── Hoisted mock functions ───────────────────────────────────────────────────
const mockSgSend = vi.hoisted(() => vi.fn());
const mockSetApiKey = vi.hoisted(() => vi.fn());
const mockVerifySignatureFn = vi.hoisted(() => vi.fn());
const mockConvertPublicKeyFn = vi.hoisted(() => vi.fn());

// ─── Module mocks ─────────────────────────────────────────────────────────────
vi.mock("@sendgrid/mail", () => ({
  default: {
    setApiKey: mockSetApiKey,
    send: mockSgSend,
  },
}));

// Use regular function (not arrow) for mockImplementation so `new EventWebhook()` works
vi.mock("@sendgrid/eventwebhook", () => ({
  EventWebhook: vi.fn().mockImplementation(function () {
    return {
      convertPublicKeyToECDSA: mockConvertPublicKeyFn,
      verifySignature: mockVerifySignatureFn,
    };
  }),
  EventWebhookHeader: {
    SIGNATURE: vi
      .fn()
      .mockReturnValue("x-twilio-email-event-webhook-signature"),
    TIMESTAMP: vi
      .fn()
      .mockReturnValue("x-twilio-email-event-webhook-timestamp"),
  },
}));

vi.mock("@shared/utils/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ─── Static imports (loaded with .env.test: SENDGRID_API_KEY = "SG.test-key") ─
// Note: SENDGRID_WEBHOOK_PUBLIC_KEY is NOT in .env.test
import {
  sendEmail,
  verifyWebhookSignature,
  parseWebhookEvents,
} from "./email-sendgrid.service.js";

describe("Email SendGrid Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConvertPublicKeyFn.mockReturnValue("mock-ec-key");
    mockVerifySignatureFn.mockReturnValue(true);
  });

  // ─── sendEmail (API key present from .env.test) ────────────────────────────
  describe("sendEmail", () => {
    beforeEach(() => {
      mockSgSend.mockResolvedValue([
        {
          statusCode: 202,
          headers: { "x-message-id": "msg-abc-123" },
          body: "",
        },
        {},
      ]);
    });

    it("returns success with messageId on 202 response", async () => {
      const result = await sendEmail({
        to: "user@example.com",
        subject: "Test Subject",
        html: "<p>Body</p>",
      });
      expect(result).toEqual({ success: true, messageId: "msg-abc-123" });
      expect(mockSgSend).toHaveBeenCalledOnce();
    });

    it("constructs message with named recipient when toName provided", async () => {
      await sendEmail({
        to: "user@example.com",
        toName: "User Name",
        fromName: "My Event",
        subject: "Event Update",
        html: "<p>Content</p>",
        plainText: "Content",
        trackingId: "track-001",
        categories: ["events"],
      });
      const [msg] = mockSgSend.mock.calls[0] as [Record<string, unknown>];
      expect(msg.to).toEqual({ email: "user@example.com", name: "User Name" });
      expect(msg.from).toMatchObject({ name: "My Event" });
      expect(msg.subject).toBe("Event Update");
      expect(msg.html).toBe("<p>Content</p>");
      expect(msg.text).toBe("Content");
      expect(msg.customArgs).toEqual({ emailLogId: "track-001" });
      expect(msg.categories).toEqual(["events"]);
    });

    it("sends plain string as to when toName is not provided", async () => {
      await sendEmail({
        to: "plain@example.com",
        subject: "Hi",
        html: "<p>Hi</p>",
      });
      const [msg] = mockSgSend.mock.calls[0] as [Record<string, unknown>];
      expect(msg.to).toBe("plain@example.com");
    });

    it("omits customArgs when trackingId is not provided", async () => {
      await sendEmail({
        to: "user@example.com",
        subject: "Hi",
        html: "<p>Hi</p>",
      });
      const [msg] = mockSgSend.mock.calls[0] as [Record<string, unknown>];
      expect(msg.customArgs).toBeUndefined();
    });

    it("returns error with message from SendGrid response body", async () => {
      const sgError = Object.assign(new Error("Bad request"), {
        response: {
          body: { errors: [{ message: "Unauthorized - API key invalid" }] },
        },
        code: 401,
      });
      mockSgSend.mockRejectedValue(sgError);
      const result = await sendEmail({
        to: "user@example.com",
        subject: "Test",
        html: "<p>Test</p>",
      });
      expect(result).toEqual({
        success: false,
        error: "Unauthorized - API key invalid",
      });
    });

    it("falls back to error.message when no structured SendGrid error body", async () => {
      mockSgSend.mockRejectedValue(new Error("Connection refused"));
      const result = await sendEmail({
        to: "user@example.com",
        subject: "Test",
        html: "<p>Test</p>",
      });
      expect(result).toEqual({ success: false, error: "Connection refused" });
    });

    it("returns undefined messageId when x-message-id header is absent", async () => {
      mockSgSend.mockResolvedValue([
        { statusCode: 202, headers: {}, body: "" },
        {},
      ]);
      const result = await sendEmail({
        to: "user@example.com",
        subject: "Hi",
        html: "<p>Hi</p>",
      });
      expect(result).toEqual({ success: true, messageId: undefined });
    });
  });

  // ─── sendEmail without API key (module reload with key cleared) ────────────
  describe("sendEmail - without API key configured", () => {
    let sendEmailNoKey: typeof sendEmail;

    beforeAll(async () => {
      vi.resetModules();
      vi.stubEnv("SENDGRID_API_KEY", "");
      const mod = await import("./email-sendgrid.service.js");
      sendEmailNoKey = mod.sendEmail;
    });

    afterAll(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("returns not configured and skips send when API key is missing", async () => {
      const result = await sendEmailNoKey({
        to: "test@example.com",
        subject: "Hello",
        html: "<p>Hello</p>",
      });
      expect(result).toEqual({
        success: false,
        error: "SendGrid not configured",
      });
      expect(mockSgSend).not.toHaveBeenCalled();
    });
  });

  // ─── verifyWebhookSignature ────────────────────────────────────────────────
  describe("verifyWebhookSignature", () => {
    // SENDGRID_WEBHOOK_PUBLIC_KEY is not in .env.test so the static import has undefined
    describe("when SENDGRID_WEBHOOK_PUBLIC_KEY is not configured", () => {
      it("returns false immediately without calling EventWebhook", () => {
        const result = verifyWebhookSignature("payload", "sig", "1234567890");
        expect(result).toBe(false);
        expect(mockConvertPublicKeyFn).not.toHaveBeenCalled();
      });
    });

    describe("when SENDGRID_WEBHOOK_PUBLIC_KEY is configured", () => {
      let verifyFn: typeof verifyWebhookSignature;

      beforeAll(async () => {
        vi.resetModules();
        vi.stubEnv("SENDGRID_WEBHOOK_PUBLIC_KEY", "test-public-key");
        const mod = await import("./email-sendgrid.service.js");
        verifyFn = mod.verifyWebhookSignature;
      });

      afterAll(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
      });

      it("returns true when signature is valid", () => {
        mockConvertPublicKeyFn.mockReturnValue("ec-key");
        mockVerifySignatureFn.mockReturnValue(true);
        const ts = String(Math.floor(Date.now() / 1000));
        const result = verifyFn("payload-body", "valid-sig", ts);
        expect(result).toBe(true);
        expect(mockConvertPublicKeyFn).toHaveBeenCalledWith("test-public-key");
        expect(mockVerifySignatureFn).toHaveBeenCalledWith(
          "ec-key",
          "payload-body",
          "valid-sig",
          ts,
        );
      });

      it("returns false when signature is invalid", () => {
        mockConvertPublicKeyFn.mockReturnValue("ec-key");
        mockVerifySignatureFn.mockReturnValue(false);
        const result = verifyFn("payload-body", "bad-sig", "1234567890");
        expect(result).toBe(false);
      });

      it("returns false when exception is thrown during key conversion", () => {
        mockConvertPublicKeyFn.mockImplementation(() => {
          throw new Error("Invalid key format");
        });
        const result = verifyFn("payload-body", "sig", "ts");
        expect(result).toBe(false);
      });

      it("accepts Buffer payload", () => {
        mockConvertPublicKeyFn.mockReturnValue("ec-key");
        mockVerifySignatureFn.mockReturnValue(true);
        const buf = Buffer.from("raw payload");
        const ts = String(Math.floor(Date.now() / 1000));
        const result = verifyFn(buf, "valid-sig", ts);
        expect(result).toBe(true);
        expect(mockVerifySignatureFn).toHaveBeenCalledWith(
          "ec-key",
          buf,
          "valid-sig",
          ts,
        );
      });
    });
  });

  // ─── parseWebhookEvents (no env var dependency) ────────────────────────────
  describe("parseWebhookEvents", () => {
    it("returns empty array for null input", () => {
      expect(parseWebhookEvents(null)).toEqual([]);
    });

    it("returns empty array for object input (not array)", () => {
      expect(parseWebhookEvents({ event: "delivered" })).toEqual([]);
    });

    it("returns empty array for string input", () => {
      expect(parseWebhookEvents("not an array")).toEqual([]);
    });

    it("parses a valid event array into typed events", () => {
      const rawEvents = [
        {
          email: "user@example.com",
          event: "delivered",
          sg_message_id: "msg-001",
          timestamp: 1700000000,
          emailLogId: "log-abc",
          sg_event_id: "evt-001",
        },
      ];
      const result = parseWebhookEvents(rawEvents);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        email: "user@example.com",
        event: "delivered",
        sg_message_id: "msg-001",
        timestamp: 1700000000,
        emailLogId: "log-abc",
        sg_event_id: "evt-001",
      });
    });

    it("extracts emailLogId from customArgs in event", () => {
      const rawEvents = [
        {
          email: "track@example.com",
          event: "open",
          sg_message_id: "msg-002",
          timestamp: 1700000001,
          emailLogId: "my-tracking-id-123",
        },
      ];
      const result = parseWebhookEvents(rawEvents);
      expect(result[0].emailLogId).toBe("my-tracking-id-123");
    });

    it("leaves optional fields undefined when absent", () => {
      const rawEvents = [
        {
          email: "user@example.com",
          event: "bounce",
          sg_message_id: "msg-003",
          timestamp: 1700000002,
        },
      ];
      const result = parseWebhookEvents(rawEvents);
      expect(result[0].emailLogId).toBeUndefined();
      expect(result[0].url).toBeUndefined();
      expect(result[0].reason).toBeUndefined();
    });

    it("parses click event with url", () => {
      const rawEvents = [
        {
          email: "click@example.com",
          event: "click",
          sg_message_id: "msg-004",
          timestamp: 1700000003,
          url: "https://example.com/link",
        },
      ];
      const result = parseWebhookEvents(rawEvents);
      expect(result[0].url).toBe("https://example.com/link");
    });

    it("parses bounce event with reason, type, and status", () => {
      const rawEvents = [
        {
          email: "bounce@example.com",
          event: "bounce",
          sg_message_id: "msg-005",
          timestamp: 1700000004,
          reason: "550 Invalid address",
          type: "bounce",
          status: "5.1.1",
        },
      ];
      const result = parseWebhookEvents(rawEvents);
      expect(result[0].reason).toBe("550 Invalid address");
      expect(result[0].type).toBe("bounce");
      expect(result[0].status).toBe("5.1.1");
    });

    it("coerces missing email and sg_message_id to empty string", () => {
      const rawEvents = [{ event: "processed", timestamp: 1700000005 }];
      const result = parseWebhookEvents(rawEvents);
      expect(result[0].email).toBe("");
      expect(result[0].sg_message_id).toBe("");
      expect(result[0].timestamp).toBe(1700000005);
    });

    it("parses multiple events in a single call", () => {
      const rawEvents = [
        {
          email: "a@example.com",
          event: "delivered",
          sg_message_id: "m1",
          timestamp: 1,
        },
        {
          email: "b@example.com",
          event: "open",
          sg_message_id: "m2",
          timestamp: 2,
        },
      ];
      const result = parseWebhookEvents(rawEvents);
      expect(result).toHaveLength(2);
      expect(result[0].event).toBe("delivered");
      expect(result[1].event).toBe("open");
    });
  });
});
