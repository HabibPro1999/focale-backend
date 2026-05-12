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
  recoverStaleEmailLeases,
  updateEmailStatusFromWebhook,
  getEmailQueueHealth,
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
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
    lockedAt: null,
    lockedUntil: null,
    lockedBy: null,
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
  prismaMock.$executeRawUnsafe.mockResolvedValue(0 as never);
  prismaMock.$queryRawUnsafe.mockResolvedValue(
    logs.map((log) => ({ id: log.id })) as never,
  );
  prismaMock.emailLog.findMany.mockResolvedValue(logs as never);
  prismaMock.emailLog.updateMany.mockResolvedValue({ count: 1 } as never);
}

function mockEmptyEmailQueue() {
  prismaMock.$executeRawUnsafe.mockResolvedValue(0 as never);
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
    prismaMock.$executeRawUnsafe.mockResolvedValue(0 as never);
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
      expect(prismaMock.emailLog.updateMany).toHaveBeenCalledWith({
        where: {
          id: mockEmailLog.id,
          status: "SENDING",
          lockedBy: expect.any(String),
        },
        data: expect.objectContaining({
          status: "SKIPPED",
          errorMessage: "Template is inactive",
          lockedAt: null,
          lockedUntil: null,
          lockedBy: null,
        }),
      });
    });

    it("should mark email as failed after SendGrid error with retries", async () => {
      const mockTemplate = createMockEmailTemplate({ isActive: true });
      const mockClient = createMockClient();
      const mockEvent = createMockEvent({ clientId: mockClient.id });

      const mockEmailLog: EmailLogWithRelations = {
        ...createMockEmailLog({ status: "QUEUED", retryCount: 3, attemptCount: 4 }), // Max retries reached
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
      expect(prismaMock.emailLog.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: mockEmailLog.id, lockedBy: expect.any(String) }),
          data: expect.objectContaining({
            status: "FAILED",
            errorMessage: "SendGrid API error",
            lockedAt: null,
            lockedUntil: null,
            lockedBy: null,
          }),
        }),
      );
    });

    it("should re-queue email for retry when retries remain", async () => {
      const mockTemplate = createMockEmailTemplate({ isActive: true });
      const mockClient = createMockClient();
      const mockEvent = createMockEvent({ clientId: mockClient.id });

      const mockEmailLog: EmailLogWithRelations = {
        ...createMockEmailLog({ status: "QUEUED", retryCount: 1, attemptCount: 2 }), // Retries remaining
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

      expect(prismaMock.emailLog.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: mockEmailLog.id, lockedBy: expect.any(String) }),
          data: expect.objectContaining({
            status: "QUEUED", // Re-queued for retry
            retryCount: { increment: 1 },
            failedAt: null,
            nextAttemptAt: expect.any(Date),
            lockedAt: null,
            lockedUntil: null,
            lockedBy: null,
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
      expect(prismaMock.emailLog.updateMany).toHaveBeenCalledWith({
        where: {
          id: mockEmailLog.id,
          status: "SENDING",
          lockedBy: expect.any(String),
        },
        data: expect.objectContaining({
          status: "SKIPPED",
          errorMessage: "Could not build email context",
          lockedAt: null,
          lockedUntil: null,
          lockedBy: null,
        }),
      });
    });

    it("should respect batch size parameter", async () => {
      mockEmptyEmailQueue();

      await processEmailQueue(25);

      expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining("FOR UPDATE SKIP LOCKED"),
        expect.any(Date),
        expect.any(Date),
        expect.any(String),
        25,
      );
    });

    it("should only process emails that have not exceeded max retries", async () => {
      mockEmptyEmailQueue();

      await processEmailQueue();

      expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('"attempt_count" <= "max_retries"'),
        expect.any(Date),
        expect.any(Date),
        expect.any(String),
        50,
      );
    });

    it("should not call SendGrid when the worker lease is lost before the provider call", async () => {
      const contextSnapshot = {
        firstName: "Lease",
        email: "lease@example.com",
        eventName: "Lease Event",
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
      prismaMock.emailLog.updateMany
        .mockResolvedValue({ count: 1 } as never)
        .mockResolvedValueOnce({ count: 1 } as never)
        .mockResolvedValueOnce({ count: 0 } as never);

      const result = await processEmailQueue(1, { workerId: "worker-a" });

      expect(result.processed).toBe(1);
      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(sendEmail).not.toHaveBeenCalled();
      expect(prismaMock.emailLog.updateMany).toHaveBeenCalledTimes(2);
      expect(prismaMock.emailLog.updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: expect.objectContaining({
            id: mockEmailLog.id,
            status: "SENDING",
            lockedBy: "worker-a",
            lockedUntil: { gt: expect.any(Date) },
          }),
          data: expect.objectContaining({
            lockedAt: expect.any(Date),
            lockedUntil: expect.any(Date),
          }),
        }),
      );
    });

    it("should not count a result when the worker lease was lost before final update", async () => {
      const mockEmailLog: EmailLogWithRelations = {
        ...createMockEmailLog({ status: "QUEUED" }),
        template: null,
        registration: null,
      };
      mockClaimedEmails([mockEmailLog]);
      prismaMock.emailLog.updateMany.mockResolvedValue({ count: 0 } as never);

      const result = await processEmailQueue(1, { workerId: "worker-a" });

      expect(result.processed).toBe(1);
      expect(result.skipped).toBe(0);
      expect(prismaMock.emailLog.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockEmailLog.id, status: "SENDING", lockedBy: "worker-a" },
        }),
      );
    });
  });

  describe("recoverStaleEmailLeases", () => {
    it("should requeue stale sending rows and dead-letter exhausted stale rows", async () => {
      prismaMock.$executeRawUnsafe
        .mockResolvedValueOnce(2 as never)
        .mockResolvedValueOnce(1 as never);

      const now = new Date("2026-01-01T00:00:00.000Z");
      const leaseMs = 10 * 60 * 1000;
      const result = await recoverStaleEmailLeases(now, leaseMs);

      expect(result).toEqual({ requeued: 2, deadLettered: 1 });
      expect(prismaMock.$executeRawUnsafe).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('"status" = \'QUEUED\''),
        now,
        new Date("2025-12-31T23:50:00.000Z"),
        new Date("2026-01-01T00:01:00.000Z"),
        new Date("2026-01-01T00:05:00.000Z"),
        new Date("2026-01-01T00:15:00.000Z"),
      );
      expect(prismaMock.$executeRawUnsafe).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('"status" = \'FAILED\''),
        now,
        new Date("2025-12-31T23:50:00.000Z"),
      );
    });

    it("should only recover SENDING rows without lockedUntil after the lease cutoff", async () => {
      prismaMock.$executeRawUnsafe.mockResolvedValue(0 as never);

      const now = new Date("2026-01-01T12:00:00.000Z");
      await recoverStaleEmailLeases(now, 5 * 60 * 1000);

      const requeueSql = prismaMock.$executeRawUnsafe.mock.calls[0][0];
      const deadLetterSql = prismaMock.$executeRawUnsafe.mock.calls[1][0];

      expect(requeueSql).toContain('"locked_until" < $1');
      expect(requeueSql).toContain(
        'COALESCE("locked_at", "last_attempt_at", "updated_at") < $2',
      );
      expect(requeueSql).toContain('"retry_count" = "retry_count" + 1');
      expect(requeueSql).toContain('"retry_count" < "max_retries"');
      expect(deadLetterSql).toContain('"locked_until" < $1');
      expect(deadLetterSql).toContain(
        'COALESCE("locked_at", "last_attempt_at", "updated_at") < $2',
      );
      expect(deadLetterSql).toContain('"retry_count" = "retry_count" + 1');
      expect(deadLetterSql).toContain('"retry_count" >= "max_retries"');
      expect(prismaMock.$executeRawUnsafe.mock.calls[0][2]).toEqual(
        new Date("2026-01-01T11:55:00.000Z"),
      );
      expect(prismaMock.$executeRawUnsafe.mock.calls[1][2]).toEqual(
        new Date("2026-01-01T11:55:00.000Z"),
      );
    });
  });

  describe("getEmailQueueHealth", () => {
    it("should include lease-aware health metadata", async () => {
      prismaMock.emailLog.count
        .mockResolvedValueOnce(5 as never)
        .mockResolvedValueOnce(3 as never)
        .mockResolvedValueOnce(2 as never)
        .mockResolvedValueOnce(1 as never)
        .mockResolvedValueOnce(4 as never)
        .mockResolvedValueOnce(2 as never);
      prismaMock.emailLog.findFirst
        .mockResolvedValueOnce({ queuedAt: new Date(Date.now() - 1000) } as never)
        .mockResolvedValueOnce({ lockedAt: new Date(Date.now() - 2000), updatedAt: new Date() } as never);

      const health = await getEmailQueueHealth();

      expect(health).toMatchObject({
        queueSize: 5,
        dueQueuedCount: 3,
        sendingCount: 2,
        staleSendingCount: 1,
        failedCount: 4,
        deadLetterCount: 4,
        recentFailures24h: 2,
        isHealthy: false,
      });
      expect(health.oldestQueuedAgeMs).toBeGreaterThanOrEqual(0);
      expect(health.oldestInFlightAgeMs).toBeGreaterThanOrEqual(0);
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
