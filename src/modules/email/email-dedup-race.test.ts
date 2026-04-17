/**
 * Fix 1 — Email dedup race via idempotencyKey unique constraint
 *
 * Two concurrent calls to queueTriggeredEmail for the same (registrationId, trigger)
 * should result in exactly one EmailLog row. The second insert hits the P2002 unique
 * constraint and returns false — no duplicate email queued.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { Prisma } from "@/generated/prisma/client.js";
import { faker } from "@faker-js/faker";
import { queueTriggeredEmail } from "@modules/email/email-queue.service.js";
import type { EmailLog, EmailTemplate } from "@/generated/prisma/client.js";

// Mock dependencies
vi.mock("@modules/email/email-template.service.js", () => ({
  getTemplateByTrigger: vi.fn(),
}));

import { getTemplateByTrigger } from "@modules/email/email-template.service.js";

function makeMockTemplate(overrides: Partial<EmailTemplate> = {}): EmailTemplate {
  return {
    id: faker.string.uuid(),
    clientId: faker.string.uuid(),
    eventId: faker.string.uuid(),
    name: "Welcome",
    description: null,
    subject: "Welcome {{firstName}}",
    content: { type: "doc", content: [] } as never,
    mjmlContent: null,
    htmlContent: "<p>Hello</p>",
    plainContent: "Hello",
    category: "AUTOMATIC",
    trigger: "REGISTRATION_CREATED",
    isDefault: false,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeMockEmailLog(overrides: Partial<EmailLog> = {}): EmailLog {
  return {
    id: faker.string.uuid(),
    trigger: "REGISTRATION_CREATED",
    templateId: faker.string.uuid(),
    registrationId: faker.string.uuid(),
    recipientEmail: faker.internet.email(),
    recipientName: null,
    subject: "",
    contextSnapshot: null,
    idempotencyKey: null,
    status: "QUEUED",
    sendgridMessageId: null,
    retryCount: 0,
    maxRetries: 3,
    errorMessage: null,
    queuedAt: new Date(),
    updatedAt: new Date(),
    sentAt: null,
    deliveredAt: null,
    openedAt: null,
    clickedAt: null,
    bouncedAt: null,
    failedAt: null,
    ...overrides,
  };
}

describe("queueTriggeredEmail dedup via idempotencyKey (Fix 1)", () => {
  const eventId = "event-abc";
  const registrationId = "reg-xyz";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("first call succeeds, second call with same args hits P2002 and returns false", async () => {
    const template = makeMockTemplate({ id: "tpl-1" });
    vi.mocked(getTemplateByTrigger).mockResolvedValue(template);

    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`idempotency_key`)",
      { code: "P2002", clientVersion: "5.0.0" },
    );

    // First call succeeds
    prismaMock.emailLog.create
      .mockResolvedValueOnce(makeMockEmailLog())
      // Second call hits unique constraint
      .mockRejectedValueOnce(p2002);

    const [first, second] = await Promise.all([
      queueTriggeredEmail("REGISTRATION_CREATED", eventId, {
        id: registrationId,
        email: "doc@hospital.tn",
        firstName: "Ali",
        lastName: "Ben Salah",
      }),
      queueTriggeredEmail("REGISTRATION_CREATED", eventId, {
        id: registrationId,
        email: "doc@hospital.tn",
        firstName: "Ali",
        lastName: "Ben Salah",
      }),
    ]);

    // Exactly one succeeded, one was skipped
    const successes = [first, second].filter(Boolean).length;
    const skips = [first, second].filter((r) => r === false).length;
    expect(successes).toBe(1);
    expect(skips).toBe(1);

    // Both calls attempted an insert — no findFirst guard pre-flight
    expect(prismaMock.emailLog.create).toHaveBeenCalledTimes(2);
  });

  it("each insert carries the correct idempotencyKey", async () => {
    const template = makeMockTemplate({ id: "tpl-2" });
    vi.mocked(getTemplateByTrigger).mockResolvedValue(template);
    prismaMock.emailLog.create.mockResolvedValue(makeMockEmailLog());

    await queueTriggeredEmail("PAYMENT_CONFIRMED", eventId, {
      id: registrationId,
      email: "doc@hospital.tn",
    });

    expect(prismaMock.emailLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        idempotencyKey: `${registrationId}:PAYMENT_CONFIRMED`,
      }),
    });
  });

  it("re-throws non-P2002 errors", async () => {
    const template = makeMockTemplate({ id: "tpl-3" });
    vi.mocked(getTemplateByTrigger).mockResolvedValue(template);

    const dbError = new Error("Connection timeout");
    prismaMock.emailLog.create.mockRejectedValue(dbError);

    await expect(
      queueTriggeredEmail("REGISTRATION_CREATED", eventId, {
        id: registrationId,
        email: "doc@hospital.tn",
      }),
    ).rejects.toThrow("Connection timeout");
  });
});
