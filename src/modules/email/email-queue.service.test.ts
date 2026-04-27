import { describe, it, expect, beforeEach, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { resetSendGridMock } from "../../../tests/mocks/sendgrid.js";
import {
  createMockClient,
  createMockEvent,
  createMockForm,
} from "../../../tests/helpers/factories.js";
import { faker } from "@faker-js/faker";
import {
  queueEmail,
  queueTriggeredEmail,
  queueBulkEmails,
  processEmailQueue,
  updateEmailStatusFromWebhook,
  getQueueStats,
} from "./email-queue.service.js";
import type {
  EmailLog,
  EmailTemplate,
  Prisma,
} from "@/generated/prisma/client.js";
import type { TiptapDocument } from "./email.types.js";

// Mock the email-sendgrid.service
vi.mock("./email-sendgrid.service.js", () => ({
  sendEmail: vi.fn().mockResolvedValue({ success: true, messageId: "msg-123" }),
}));

// Mock the email-variable.service
vi.mock("./email-variable.service.js", () => ({
  resolveVariables: vi.fn().mockImplementation((template: string) => template),
  buildEmailContextWithAccess: vi.fn().mockResolvedValue({
    firstName: "John",
    lastName: "Doe",
    email: "john@example.com",
    eventName: "Test Event",
    fullName: "John Doe",
  }),
}));

// Mock the email-template.service
vi.mock("./email-template.service.js", () => ({
  getTemplateByTrigger: vi.fn(),
}));

// Import the mocked modules to access mock functions
import { sendEmail } from "./email-sendgrid.service.js";
import { buildEmailContextWithAccess } from "./email-variable.service.js";
import { getTemplateByTrigger } from "./email-template.service.js";

// ============================================================================
// Test Data Factories
// ============================================================================

function createMockTiptapDocument(): TiptapDocument {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Hello {{firstName}}" }],
      },
    ],
  };
}

function createMockEmailTemplate(
  overrides: Partial<EmailTemplate> = {},
): EmailTemplate {
  return {
    id: faker.string.uuid(),
    clientId: faker.string.uuid(),
    eventId: faker.string.uuid(),
    name: faker.lorem.words(3),
    description: faker.lorem.sentence(),
    subject: "Welcome {{firstName}}",
    content: createMockTiptapDocument() as unknown as EmailTemplate["content"],
    mjmlContent: "<mjml><mj-body></mj-body></mjml>",
    htmlContent: "<html><body>Hello {{firstName}}</body></html>",
    plainContent: "Hello {{firstName}}",
    category: "AUTOMATIC",
    trigger: "REGISTRATION_CREATED",
    isDefault: false,
    isActive: true,
    abstractTrigger: null,
    createdAt: faker.date.past(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

function createMockEmailLog(overrides: Partial<EmailLog> = {}): EmailLog {
  return {
    id: faker.string.uuid(),
    trigger: null,
    templateId: faker.string.uuid(),
    registrationId: faker.string.uuid(),
    abstractId: null,
    recipientEmail: faker.internet.email(),
    recipientName: faker.person.fullName(),
    abstractTrigger: null,
    subject: "Test Subject",
    contextSnapshot: null,
    status: "QUEUED",
    sendgridMessageId: null,
    retryCount: 0,
    maxRetries: 3,
    errorMessage: null,
    queuedAt: faker.date.recent(),
    updatedAt: faker.date.recent(),
    sentAt: null,
    deliveredAt: null,
    openedAt: null,
    clickedAt: null,
    bouncedAt: null,
    failedAt: null,
    ...overrides,
  };
}

// Type for email log with relations
type EmailLogWithRelations = EmailLog & {
  template: EmailTemplate | null;
  registration: {
    id: string;
    event: { id: string; client: { id: string; name: string } };
    form: { id: string } | null;
  } | null;
};

function mockClaimedEmails(logs: EmailLogWithRelations[]) {
  prismaMock.$queryRawUnsafe.mockResolvedValue(
    logs.map((log) => ({ id: log.id })) as never,
  );
  prismaMock.emailLog.findMany.mockResolvedValue(logs as never);
}

function mockEmptyEmailQueue() {
  prismaMock.$queryRawUnsafe.mockResolvedValue([] as never);
}

function mockCurrentEmailStatus(status: EmailLog["status"] = "SENT") {
  prismaMock.emailLog.findUnique.mockResolvedValue({ status } as never);
}

// ============================================================================
// Tests
// ============================================================================

describe("Email Queue Service", () => {
  const eventId = "event-123";
  const templateId = "template-456";
  const registrationId = "registration-789";

  beforeEach(() => {
    vi.clearAllMocks();
    resetSendGridMock();
  });

  describe("queueEmail", () => {
    it("should create a queued email log entry", async () => {
      const mockEmailLog = createMockEmailLog({
        templateId,
        registrationId,
        recipientEmail: "test@example.com",
        recipientName: "Test User",
        status: "QUEUED",
      });

      prismaMock.emailLog.create.mockResolvedValue(mockEmailLog);

      const result = await queueEmail({
        templateId,
        registrationId,
        recipientEmail: "test@example.com",
        recipientName: "Test User",
      });

      expect(result.status).toBe("QUEUED");
      expect(prismaMock.emailLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          templateId,
          registrationId,
          recipientEmail: "test@example.com",
          recipientName: "Test User",
          status: "QUEUED",
          subject: "",
        }),
      });
    });

    it("should include trigger when provided", async () => {
      const mockEmailLog = createMockEmailLog({
        trigger: "REGISTRATION_CREATED",
      });

      prismaMock.emailLog.create.mockResolvedValue(mockEmailLog);

      await queueEmail({
        trigger: "REGISTRATION_CREATED",
        templateId,
        recipientEmail: "test@example.com",
      });

      expect(prismaMock.emailLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          trigger: "REGISTRATION_CREATED",
        }),
      });
    });

    it("should store context snapshot when provided", async () => {
      const contextSnapshot = { firstName: "John", eventName: "Test Event" };
      const mockEmailLog = createMockEmailLog({
        contextSnapshot: contextSnapshot as Prisma.JsonValue,
      });

      prismaMock.emailLog.create.mockResolvedValue(mockEmailLog);

      await queueEmail({
        templateId,
        recipientEmail: "test@example.com",
        contextSnapshot,
      });

      expect(prismaMock.emailLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          contextSnapshot,
        }),
      });
    });
  });

  describe("queueTriggeredEmail", () => {
    it("should queue email when template exists for trigger", async () => {
      const mockTemplate = createMockEmailTemplate({
        id: templateId,
        trigger: "REGISTRATION_CREATED",
      });
      const mockEmailLog = createMockEmailLog({ templateId });

      vi.mocked(getTemplateByTrigger).mockResolvedValue(mockTemplate);
      prismaMock.emailLog.create.mockResolvedValue(mockEmailLog);

      const result = await queueTriggeredEmail(
        "REGISTRATION_CREATED",
        eventId,
        {
          id: registrationId,
          email: "test@example.com",
          firstName: "John",
          lastName: "Doe",
        },
      );

      expect(result).toBe(true);
      expect(getTemplateByTrigger).toHaveBeenCalledWith(
        eventId,
        "REGISTRATION_CREATED",
      );
      expect(prismaMock.emailLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          trigger: "REGISTRATION_CREATED",
          templateId,
          registrationId,
          recipientEmail: "test@example.com",
          recipientName: "John Doe",
        }),
      });
    });

    it("should return false when no template exists for trigger", async () => {
      vi.mocked(getTemplateByTrigger).mockResolvedValue(null);

      const result = await queueTriggeredEmail(
        "REGISTRATION_CREATED",
        eventId,
        {
          id: registrationId,
          email: "test@example.com",
        },
      );

      expect(result).toBe(false);
      expect(prismaMock.emailLog.create).not.toHaveBeenCalled();
    });

    it("should handle registration with only firstName", async () => {
      const mockTemplate = createMockEmailTemplate({ id: templateId });
      const mockEmailLog = createMockEmailLog();

      vi.mocked(getTemplateByTrigger).mockResolvedValue(mockTemplate);
      prismaMock.emailLog.create.mockResolvedValue(mockEmailLog);

      await queueTriggeredEmail("PAYMENT_CONFIRMED", eventId, {
        id: registrationId,
        email: "test@example.com",
        firstName: "John",
        lastName: null,
      });

      expect(prismaMock.emailLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          recipientName: "John",
        }),
      });
    });

    it("should set recipientName to undefined when no names provided", async () => {
      const mockTemplate = createMockEmailTemplate({ id: templateId });
      const mockEmailLog = createMockEmailLog({ recipientName: null });

      vi.mocked(getTemplateByTrigger).mockResolvedValue(mockTemplate);
      prismaMock.emailLog.create.mockResolvedValue(mockEmailLog);

      await queueTriggeredEmail("PAYMENT_PROOF_SUBMITTED", eventId, {
        id: registrationId,
        email: "test@example.com",
      });

      expect(prismaMock.emailLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          recipientName: undefined,
        }),
      });
    });
  });

  describe("queueBulkEmails", () => {
    it("should queue multiple emails in bulk", async () => {
      const registrations = [
        {
          id: "reg-1",
          email: "user1@example.com",
          firstName: "John",
          lastName: "Doe",
        },
        {
          id: "reg-2",
          email: "user2@example.com",
          firstName: "Jane",
          lastName: "Smith",
        },
        {
          id: "reg-3",
          email: "user3@example.com",
          firstName: null,
          lastName: null,
        },
      ];

      prismaMock.emailLog.createMany.mockResolvedValue({ count: 3 });

      const result = await queueBulkEmails(templateId, registrations);

      expect(result).toBe(3);
      expect(prismaMock.emailLog.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            templateId,
            registrationId: "reg-1",
            recipientEmail: "user1@example.com",
            recipientName: "John Doe",
            status: "QUEUED",
          }),
          expect.objectContaining({
            registrationId: "reg-2",
            recipientName: "Jane Smith",
          }),
          expect.objectContaining({
            registrationId: "reg-3",
            recipientName: null,
          }),
        ]),
      });
    });

    it("should return 0 for empty registration list", async () => {
      prismaMock.emailLog.createMany.mockResolvedValue({ count: 0 });

      const result = await queueBulkEmails(templateId, []);

      expect(result).toBe(0);
    });
  });

  describe("processEmailQueue", () => {
    it("should process queued emails successfully", async () => {
      const mockClient = createMockClient();
      const mockEvent = createMockEvent({ clientId: mockClient.id });
      const mockForm = createMockForm({ eventId: mockEvent.id });
      const mockTemplate = createMockEmailTemplate({ isActive: true });

      const mockEmailLog: EmailLogWithRelations = {
        ...createMockEmailLog({ status: "QUEUED", retryCount: 0 }),
        template: mockTemplate,
        registration: {
          id: registrationId,
          event: {
            id: mockEvent.id,
            client: { id: mockClient.id, name: mockClient.name },
          },
          form: { id: mockForm.id },
        },
      };

      mockClaimedEmails([mockEmailLog]);
      prismaMock.emailLog.update.mockResolvedValue(mockEmailLog);

      vi.mocked(sendEmail).mockResolvedValue({
        success: true,
        messageId: "msg-123",
      });

      const result = await processEmailQueue(10);

      expect(result.processed).toBe(1);
      expect(result.sent).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it("should skip emails without template", async () => {
      const mockEmailLog: EmailLogWithRelations = {
        ...createMockEmailLog({ status: "QUEUED" }),
        template: null,
        registration: null,
      };

      mockClaimedEmails([mockEmailLog]);
      prismaMock.emailLog.update.mockResolvedValue(mockEmailLog);

      const result = await processEmailQueue();

      expect(result.skipped).toBe(1);
      expect(result.sent).toBe(0);
    });

    it("should skip emails with inactive template", async () => {
      const mockTemplate = createMockEmailTemplate({ isActive: false });
      const mockEmailLog: EmailLogWithRelations = {
        ...createMockEmailLog({ status: "QUEUED" }),
        template: mockTemplate,
        registration: null,
      };

      mockClaimedEmails([mockEmailLog]);
      prismaMock.emailLog.update.mockResolvedValue(mockEmailLog);

      const result = await processEmailQueue();

      expect(result.skipped).toBe(1);
      expect(prismaMock.emailLog.update).toHaveBeenCalledWith({
        where: { id: mockEmailLog.id },
        data: {
          status: "SKIPPED",
          errorMessage: "Template is inactive",
        },
      });
    });

    it("should mark email as failed after SendGrid error with retries", async () => {
      const mockTemplate = createMockEmailTemplate({ isActive: true });
      const mockClient = createMockClient();
      const mockEvent = createMockEvent({ clientId: mockClient.id });

      const mockEmailLog: EmailLogWithRelations = {
        ...createMockEmailLog({ status: "QUEUED", retryCount: 3 }), // Max retries reached
        template: mockTemplate,
        registration: {
          id: registrationId,
          event: {
            id: mockEvent.id,
            client: { id: mockClient.id, name: mockClient.name },
          },
          form: null,
        },
      };

      mockClaimedEmails([mockEmailLog]);
      prismaMock.emailLog.update.mockResolvedValue(mockEmailLog);

      vi.mocked(sendEmail).mockResolvedValue({
        success: false,
        error: "SendGrid API error",
      });

      const result = await processEmailQueue();

      expect(result.failed).toBe(1);
      expect(prismaMock.emailLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockEmailLog.id },
          data: expect.objectContaining({
            status: "FAILED",
            errorMessage: "SendGrid API error",
          }),
        }),
      );
    });

    it("should re-queue email for retry when retries remain", async () => {
      const mockTemplate = createMockEmailTemplate({ isActive: true });
      const mockClient = createMockClient();
      const mockEvent = createMockEvent({ clientId: mockClient.id });

      const mockEmailLog: EmailLogWithRelations = {
        ...createMockEmailLog({ status: "QUEUED", retryCount: 1 }), // Retries remaining
        template: mockTemplate,
        registration: {
          id: registrationId,
          event: {
            id: mockEvent.id,
            client: { id: mockClient.id, name: mockClient.name },
          },
          form: null,
        },
      };

      mockClaimedEmails([mockEmailLog]);
      prismaMock.emailLog.update.mockResolvedValue(mockEmailLog);

      vi.mocked(sendEmail).mockResolvedValue({
        success: false,
        error: "Temporary failure",
      });

      await processEmailQueue();

      expect(prismaMock.emailLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockEmailLog.id },
          data: expect.objectContaining({
            status: "QUEUED", // Re-queued for retry
            retryCount: { increment: 1 },
            failedAt: null,
          }),
        }),
      );
    });

    it("should return empty result when queue is empty", async () => {
      mockEmptyEmailQueue();

      const result = await processEmailQueue();

      expect(result.processed).toBe(0);
      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it("should use provided context snapshot instead of building new context", async () => {
      const contextSnapshot = {
        firstName: "Custom",
        lastName: "User",
        email: "custom@example.com",
        eventName: "Custom Event",
      };

      const mockTemplate = createMockEmailTemplate({ isActive: true });
      const mockEmailLog: EmailLogWithRelations = {
        ...createMockEmailLog({
          status: "QUEUED",
          contextSnapshot: contextSnapshot as Prisma.JsonValue,
        }),
        template: mockTemplate,
        registration: null,
      };

      mockClaimedEmails([mockEmailLog]);
      prismaMock.emailLog.update.mockResolvedValue(mockEmailLog);

      vi.mocked(sendEmail).mockResolvedValue({ success: true });

      await processEmailQueue();

      // buildEmailContextWithAccess should not be called since we have a valid context snapshot
      expect(buildEmailContextWithAccess).not.toHaveBeenCalled();
    });

    it("should skip emails when context cannot be built", async () => {
      const mockTemplate = createMockEmailTemplate({ isActive: true });
      const mockEmailLog: EmailLogWithRelations = {
        ...createMockEmailLog({ status: "QUEUED", contextSnapshot: null }),
        template: mockTemplate,
        registration: null, // No registration to build context from
      };

      mockClaimedEmails([mockEmailLog]);
      prismaMock.emailLog.update.mockResolvedValue(mockEmailLog);

      const result = await processEmailQueue();

      expect(result.skipped).toBe(1);
      expect(prismaMock.emailLog.update).toHaveBeenCalledWith({
        where: { id: mockEmailLog.id },
        data: {
          status: "SKIPPED",
          errorMessage: "Could not build email context",
        },
      });
    });

    it("should respect batch size parameter", async () => {
      mockEmptyEmailQueue();

      await processEmailQueue(25);

      expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining("FOR UPDATE SKIP LOCKED"),
        4,
        25,
      );
    });

    it("should only process emails that have not exceeded max retries", async () => {
      mockEmptyEmailQueue();

      await processEmailQueue();

      expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('"retry_count" < $1'),
        4,
        50,
      );
    });
  });

  describe("updateEmailStatusFromWebhook", () => {
    const emailLogId = "log-123";

    it("should update status to DELIVERED", async () => {
      mockCurrentEmailStatus("SENT");
      prismaMock.emailLog.update.mockResolvedValue(createMockEmailLog());

      await updateEmailStatusFromWebhook(emailLogId, "delivered");

      expect(prismaMock.emailLog.update).toHaveBeenCalledWith({
        where: { id: emailLogId },
        data: expect.objectContaining({
          status: "DELIVERED",
          deliveredAt: expect.any(Date),
        }),
      });
    });

    it("should update status to OPENED", async () => {
      mockCurrentEmailStatus("DELIVERED");
      prismaMock.emailLog.update.mockResolvedValue(createMockEmailLog());

      await updateEmailStatusFromWebhook(emailLogId, "open");

      expect(prismaMock.emailLog.update).toHaveBeenCalledWith({
        where: { id: emailLogId },
        data: expect.objectContaining({
          status: "OPENED",
          openedAt: expect.any(Date),
        }),
      });
    });

    it("should update status to CLICKED", async () => {
      mockCurrentEmailStatus("OPENED");
      prismaMock.emailLog.update.mockResolvedValue(createMockEmailLog());

      await updateEmailStatusFromWebhook(emailLogId, "click", {
        url: "https://example.com",
      });

      expect(prismaMock.emailLog.update).toHaveBeenCalledWith({
        where: { id: emailLogId },
        data: expect.objectContaining({
          status: "CLICKED",
          clickedAt: expect.any(Date),
        }),
      });
    });

    it("should update status to BOUNCED with reason", async () => {
      mockCurrentEmailStatus("SENT");
      prismaMock.emailLog.update.mockResolvedValue(createMockEmailLog());

      await updateEmailStatusFromWebhook(emailLogId, "bounce", {
        reason: "Invalid email address",
      });

      expect(prismaMock.emailLog.update).toHaveBeenCalledWith({
        where: { id: emailLogId },
        data: expect.objectContaining({
          status: "BOUNCED",
          bouncedAt: expect.any(Date),
          errorMessage: "Invalid email address",
        }),
      });
    });

    it("should update status to BOUNCED with default reason", async () => {
      mockCurrentEmailStatus("SENT");
      prismaMock.emailLog.update.mockResolvedValue(createMockEmailLog());

      await updateEmailStatusFromWebhook(emailLogId, "bounce");

      expect(prismaMock.emailLog.update).toHaveBeenCalledWith({
        where: { id: emailLogId },
        data: expect.objectContaining({
          errorMessage: "Bounced",
        }),
      });
    });

    it("should update status to DROPPED with reason", async () => {
      mockCurrentEmailStatus("SENT");
      prismaMock.emailLog.update.mockResolvedValue(createMockEmailLog());

      await updateEmailStatusFromWebhook(emailLogId, "dropped", {
        reason: "Spam content detected",
      });

      expect(prismaMock.emailLog.update).toHaveBeenCalledWith({
        where: { id: emailLogId },
        data: expect.objectContaining({
          status: "DROPPED",
          errorMessage: "Spam content detected",
        }),
      });
    });

    it("should update status to DROPPED with default reason", async () => {
      mockCurrentEmailStatus("SENT");
      prismaMock.emailLog.update.mockResolvedValue(createMockEmailLog());

      await updateEmailStatusFromWebhook(emailLogId, "dropped");

      expect(prismaMock.emailLog.update).toHaveBeenCalledWith({
        where: { id: emailLogId },
        data: expect.objectContaining({
          errorMessage: "Dropped",
        }),
      });
    });

    it("should handle update errors gracefully", async () => {
      mockCurrentEmailStatus("SENT");
      prismaMock.emailLog.update.mockRejectedValue(new Error("Database error"));

      // Should not throw
      await expect(
        updateEmailStatusFromWebhook(emailLogId, "delivered"),
      ).resolves.not.toThrow();
    });
  });

  describe("getQueueStats", () => {
    it("should return aggregated queue statistics", async () => {
      const mockStats = [
        { status: "QUEUED", _count: { status: 10 } },
        { status: "SENT", _count: { status: 50 } },
        { status: "DELIVERED", _count: { status: 45 } },
        { status: "FAILED", _count: { status: 3 } },
        { status: "BOUNCED", _count: { status: 2 } },
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prismaMock.emailLog.groupBy as any).mockResolvedValue(mockStats);

      const result = await getQueueStats();

      expect(result).toEqual({
        QUEUED: 10,
        SENT: 50,
        DELIVERED: 45,
        FAILED: 3,
        BOUNCED: 2,
      });
    });

    it("should return empty object when no emails in queue", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prismaMock.emailLog.groupBy as any).mockResolvedValue([]);

      const result = await getQueueStats();

      expect(result).toEqual({});
    });

    it("should handle single status in queue", async () => {
      const mockStats = [{ status: "QUEUED", _count: { status: 5 } }];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (prismaMock.emailLog.groupBy as any).mockResolvedValue(mockStats);

      const result = await getQueueStats();

      expect(result).toEqual({ QUEUED: 5 });
    });
  });
});
