import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
  beforeEach,
} from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { AppInstance } from "@shared/types/fastify.js";
import { errorHandler } from "@shared/middleware/error.middleware.js";
import { emailWebhookRoutes } from "./email-webhook.routes.js";

// Mock the sendgrid service
vi.mock("./email-sendgrid.service.js", () => ({
  verifyWebhookSignature: vi.fn(),
  parseWebhookEvents: vi.fn(),
  WebhookHeaders: {
    SIGNATURE: "x-twilio-email-event-webhook-signature",
    TIMESTAMP: "x-twilio-email-event-webhook-timestamp",
  },
}));

// Mock the queue service
vi.mock("./email-queue.service.js", () => ({
  updateEmailStatusFromWebhook: vi.fn(),
}));

import {
  verifyWebhookSignature as _verifyWebhookSignature,
  parseWebhookEvents as _parseWebhookEvents,
  type SendGridWebhookEvent,
} from "./email-sendgrid.service.js";
import { updateEmailStatusFromWebhook as _updateEmailStatusFromWebhook } from "./email-queue.service.js";

// Get properly typed mocks
const verifyWebhookSignature = vi.mocked(_verifyWebhookSignature);
const parseWebhookEvents = vi.mocked(_parseWebhookEvents);
const updateEmailStatusFromWebhook = vi.mocked(_updateEmailStatusFromWebhook);

// Helper to create a standalone Fastify instance for webhook tests
async function createWebhookTestApp(): Promise<AppInstance> {
  const app = Fastify({
    logger: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register error handler
  app.setErrorHandler(errorHandler);

  // Register webhook routes
  await app.register(emailWebhookRoutes, { prefix: "/api/webhooks/email" });

  await app.ready();
  return app;
}

describe("Email Webhook Routes", () => {
  let app: AppInstance;

  beforeAll(async () => {
    app = await createWebhookTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/webhooks/email", () => {
    const validSignature = "valid-signature";
    const validTimestamp = "1234567890";
    const validHeaders = {
      "x-twilio-email-event-webhook-signature": validSignature,
      "x-twilio-email-event-webhook-timestamp": validTimestamp,
    };

    it("should return 401 when signature header is missing", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/webhooks/email",
        headers: {
          "x-twilio-email-event-webhook-timestamp": validTimestamp,
        },
        payload: [],
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toMatchObject({
        code: "EML_16002",
      });
    });

    it("should return 401 when timestamp header is missing", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/webhooks/email",
        headers: {
          "x-twilio-email-event-webhook-signature": validSignature,
        },
        payload: [],
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toMatchObject({
        code: "EML_16002",
      });
    });

    it("should return 401 when signature is invalid", async () => {
      verifyWebhookSignature.mockReturnValue(false);

      const response = await app.inject({
        method: "POST",
        url: "/api/webhooks/email",
        headers: validHeaders,
        payload: [],
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toMatchObject({
        code: "EML_16002",
      });
    });

    it("should return 200 for valid signature with valid events", async () => {
      const emailLogId = "log-123";
      const mockEvents = [
        {
          event: "delivered",
          email: "test@example.com",
          timestamp: 1234567890,
          sg_message_id: "msg-123",
          emailLogId,
        },
      ];

      verifyWebhookSignature.mockReturnValue(true);
      parseWebhookEvents.mockReturnValue(mockEvents as SendGridWebhookEvent[]);
      updateEmailStatusFromWebhook.mockResolvedValue(undefined);

      const response = await app.inject({
        method: "POST",
        url: "/api/webhooks/email",
        headers: validHeaders,
        payload: [
          {
            event: "delivered",
            email: "test@example.com",
            timestamp: 1234567890,
            "tracking-id": emailLogId,
          },
        ],
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ received: true });
      expect(updateEmailStatusFromWebhook).toHaveBeenCalledWith(
        emailLogId,
        "delivered",
        expect.objectContaining({
          url: undefined,
          reason: undefined,
        }),
      );
    });

    it("should return 200 for invalid payload format (prevents retries)", async () => {
      verifyWebhookSignature.mockReturnValue(true);

      const response = await app.inject({
        method: "POST",
        url: "/api/webhooks/email",
        headers: validHeaders,
        payload: { invalid: "schema structure" }, // Valid JSON, invalid schema
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ received: true });
    });

    it("should skip events without emailLogId", async () => {
      const mockEvents = [
        {
          event: "delivered",
          email: "test@example.com",
          timestamp: 1234567890,
          sg_message_id: "msg-123",
          emailLogId: undefined,
        },
      ];

      verifyWebhookSignature.mockReturnValue(true);
      parseWebhookEvents.mockReturnValue(mockEvents as SendGridWebhookEvent[]);

      const response = await app.inject({
        method: "POST",
        url: "/api/webhooks/email",
        headers: validHeaders,
        payload: [
          {
            event: "delivered",
            email: "test@example.com",
            timestamp: 1234567890,
          },
        ],
      });

      expect(response.statusCode).toBe(200);
      expect(updateEmailStatusFromWebhook).not.toHaveBeenCalled();
    });

    it("should process multiple events in batch", async () => {
      const emailLogId1 = "log-1";
      const emailLogId2 = "log-2";
      const mockEvents = [
        {
          event: "delivered",
          email: "test1@example.com",
          timestamp: 1234567890,
          emailLogId: emailLogId1,
        },
        {
          event: "open",
          email: "test2@example.com",
          timestamp: 1234567891,
          sg_message_id: "msg-456",
          emailLogId: emailLogId2,
        },
      ];

      verifyWebhookSignature.mockReturnValue(true);
      parseWebhookEvents.mockReturnValue(mockEvents as SendGridWebhookEvent[]);
      updateEmailStatusFromWebhook.mockResolvedValue(undefined);

      const response = await app.inject({
        method: "POST",
        url: "/api/webhooks/email",
        headers: validHeaders,
        payload: [
          {
            event: "delivered",
            email: "test1@example.com",
            timestamp: 1234567890,
            "tracking-id": emailLogId1,
          },
          {
            event: "open",
            email: "test2@example.com",
            timestamp: 1234567891,
            "tracking-id": emailLogId2,
          },
        ],
      });

      expect(response.statusCode).toBe(200);
      expect(updateEmailStatusFromWebhook).toHaveBeenCalledTimes(2);
      expect(updateEmailStatusFromWebhook).toHaveBeenCalledWith(
        emailLogId1,
        "delivered",
        expect.any(Object),
      );
      expect(updateEmailStatusFromWebhook).toHaveBeenCalledWith(
        emailLogId2,
        "open",
        expect.any(Object),
      );
    });

    it("should process all event types: delivered, open, click, bounce, dropped", async () => {
      const emailLogId = "log-123";
      const mockEvents = [
        {
          event: "delivered",
          email: "test@example.com",
          timestamp: 1234567890,
          sg_message_id: "msg-123",
          emailLogId,
        },
        {
          event: "open",
          email: "test@example.com",
          timestamp: 1234567891,
          emailLogId,
        },
        {
          event: "click",
          email: "test@example.com",
          timestamp: 1234567892,
          sg_message_id: "msg-123",
          emailLogId,
          url: "https://example.com",
        },
        {
          event: "bounce",
          email: "test@example.com",
          timestamp: 1234567893,
          sg_message_id: "msg-123",
          emailLogId,
          reason: "Invalid address",
        },
        {
          event: "dropped",
          email: "test@example.com",
          timestamp: 1234567894,
          sg_message_id: "msg-123",
          emailLogId,
          reason: "Spam detected",
        },
      ];

      verifyWebhookSignature.mockReturnValue(true);
      parseWebhookEvents.mockReturnValue(mockEvents as SendGridWebhookEvent[]);
      updateEmailStatusFromWebhook.mockResolvedValue(undefined);

      const response = await app.inject({
        method: "POST",
        url: "/api/webhooks/email",
        headers: validHeaders,
        payload: mockEvents.map((e) => ({
          event: e.event,
          email: e.email,
          timestamp: e.timestamp,
          "tracking-id": e.emailLogId,
          url: e.url,
          reason: e.reason,
        })),
      });

      expect(response.statusCode).toBe(200);
      expect(updateEmailStatusFromWebhook).toHaveBeenCalledTimes(5);
    });

    it("should skip unsupported event types (processed, deferred, spam_report)", async () => {
      const emailLogId = "log-123";
      const mockEvents = [
        {
          event: "processed",
          email: "test@example.com",
          timestamp: 1234567890,
          sg_message_id: "msg-123",
          emailLogId,
        },
        {
          event: "deferred",
          email: "test@example.com",
          timestamp: 1234567891,
          emailLogId,
        },
        {
          event: "spam_report",
          email: "test@example.com",
          timestamp: 1234567892,
          emailLogId,
        },
      ];

      verifyWebhookSignature.mockReturnValue(true);
      parseWebhookEvents.mockReturnValue(mockEvents as SendGridWebhookEvent[]);

      const response = await app.inject({
        method: "POST",
        url: "/api/webhooks/email",
        headers: validHeaders,
        payload: mockEvents,
      });

      expect(response.statusCode).toBe(200);
      expect(updateEmailStatusFromWebhook).not.toHaveBeenCalled();
    });

    it("should continue processing other events if one fails", async () => {
      const emailLogId1 = "log-1";
      const emailLogId2 = "log-2";
      const mockEvents = [
        {
          event: "delivered",
          email: "test1@example.com",
          timestamp: 1234567890,
          emailLogId: emailLogId1,
        },
        {
          event: "open",
          email: "test2@example.com",
          timestamp: 1234567891,
          sg_message_id: "msg-456",
          emailLogId: emailLogId2,
        },
      ];

      verifyWebhookSignature.mockReturnValue(true);
      parseWebhookEvents.mockReturnValue(mockEvents as SendGridWebhookEvent[]);
      updateEmailStatusFromWebhook
        .mockRejectedValueOnce(new Error("Database error"))
        .mockResolvedValueOnce(undefined);

      const response = await app.inject({
        method: "POST",
        url: "/api/webhooks/email",
        headers: validHeaders,
        payload: mockEvents,
      });

      expect(response.statusCode).toBe(200);
      expect(updateEmailStatusFromWebhook).toHaveBeenCalledTimes(2);
    });

    it("should handle click events with URL", async () => {
      const emailLogId = "log-123";
      const clickUrl = "https://example.com/link";
      const mockEvents = [
        {
          event: "click",
          email: "test@example.com",
          timestamp: 1234567890,
          sg_message_id: "msg-123",
          emailLogId,
          url: clickUrl,
        },
      ];

      verifyWebhookSignature.mockReturnValue(true);
      parseWebhookEvents.mockReturnValue(mockEvents as SendGridWebhookEvent[]);
      updateEmailStatusFromWebhook.mockResolvedValue(undefined);

      const response = await app.inject({
        method: "POST",
        url: "/api/webhooks/email",
        headers: validHeaders,
        payload: [
          {
            event: "click",
            email: "test@example.com",
            timestamp: 1234567890,
            "tracking-id": emailLogId,
            url: clickUrl,
          },
        ],
      });

      expect(response.statusCode).toBe(200);
      expect(updateEmailStatusFromWebhook).toHaveBeenCalledWith(
        emailLogId,
        "click",
        expect.objectContaining({
          url: clickUrl,
        }),
      );
    });

    it("should handle bounce events with reason", async () => {
      const emailLogId = "log-123";
      const bounceReason = "Invalid email address";
      const mockEvents = [
        {
          event: "bounce",
          email: "test@example.com",
          timestamp: 1234567890,
          sg_message_id: "msg-123",
          emailLogId,
          reason: bounceReason,
        },
      ];

      verifyWebhookSignature.mockReturnValue(true);
      parseWebhookEvents.mockReturnValue(mockEvents as SendGridWebhookEvent[]);
      updateEmailStatusFromWebhook.mockResolvedValue(undefined);

      const response = await app.inject({
        method: "POST",
        url: "/api/webhooks/email",
        headers: validHeaders,
        payload: [
          {
            event: "bounce",
            email: "test@example.com",
            timestamp: 1234567890,
            "tracking-id": emailLogId,
            reason: bounceReason,
          },
        ],
      });

      expect(response.statusCode).toBe(200);
      expect(updateEmailStatusFromWebhook).toHaveBeenCalledWith(
        emailLogId,
        "bounce",
        expect.objectContaining({
          reason: bounceReason,
        }),
      );
    });
  });
});
