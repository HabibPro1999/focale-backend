import { describe, it, expect, vi } from "vitest";
import { faker } from "@faker-js/faker";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import {
  createMockEvent,
  createMockForm,
  createMockSponsorship,
  createMockSponsorshipBatch,
  createMockEventPricing,
} from "../../../tests/helpers/factories.js";
import { createSponsorshipBatch } from "./sponsorships-batch.service.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxCallback = (tx: any) => Promise<unknown>;

// Mock values often don't match the full Prisma types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asMock = <T>(value: T): any => value;

// Suppress unused import
void asMock;

vi.mock("@shared/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock email module — email sending is tested for resilience, not correctness
vi.mock("@email", () => ({
  queueSponsorshipEmail: vi.fn().mockResolvedValue(true),
  buildBatchEmailContext: vi.fn().mockReturnValue({}),
  buildLinkedSponsorshipContext: vi.fn().mockReturnValue({}),
}));

import { queueSponsorshipEmail, buildLinkedSponsorshipContext } from "@email";

// ============================================================================
// Helpers
// ============================================================================

const sponsorInput = {
  labName: "Pharma Lab",
  contactName: "Alice Martin",
  email: "alice@pharmalab.com",
  phone: "+21612345678",
};

function makeLinkedInput(
  registrationIds: string[],
  opts: {
    coversBasePrice?: boolean;
    coveredAccessIds?: string[];
  } = {},
) {
  return {
    sponsor: sponsorInput,
    linkedBeneficiaries: registrationIds.map((registrationId, i) => ({
      registrationId,
      email: `doctor${i}@hospital.com`,
      name: `Dr. Doctor ${i}`,
      coversBasePrice: opts.coversBasePrice ?? true,
      coveredAccessIds: opts.coveredAccessIds ?? [],
    })),
  };
}

function makeRegistration(overrides: Record<string, unknown> = {}) {
  return {
    id: faker.string.uuid(),
    email: "reg@example.com",
    firstName: "John",
    lastName: "Doe",
    phone: "+21600000000",
    totalAmount: 500,
    sponsorshipAmount: 0,
    baseAmount: 400,
    accessTypeIds: [],
    priceBreakdown: {},
    linkBaseUrl: null,
    editToken: null,
    ...overrides,
  };
}

// ============================================================================
// LINKED_ACCOUNT batch mode tests
// ============================================================================

describe("createSponsorshipBatch — LINKED_ACCOUNT mode", () => {
  const eventId = faker.string.uuid();
  const formId = faker.string.uuid();

  const mockEvent = createMockEvent({
    id: eventId,
    name: "Medical Conference",
    slug: "medical-conference",
  });
  const mockForm = createMockForm({ id: formId, eventId, type: "SPONSOR" });

  it("creates USED sponsorships linked to registrations", async () => {
    const regId = faker.string.uuid();
    const reg = makeRegistration({ id: regId });

    prismaMock.event.findUnique.mockResolvedValue(mockEvent);
    prismaMock.form.findFirst.mockResolvedValue(mockForm);
    prismaMock.registration.findMany.mockResolvedValue([asMock(reg)]);
    prismaMock.eventAccess.findMany.mockResolvedValue([]);

    const txMock = {
      sponsorshipBatch: {
        create: vi
          .fn()
          .mockResolvedValue(createMockSponsorshipBatch({ eventId })),
      },
      sponsorship: {
        create: vi
          .fn()
          .mockResolvedValue(
            createMockSponsorship({ eventId, status: "USED" }),
          ),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      sponsorshipUsage: {
        create: vi.fn().mockResolvedValue({ id: faker.string.uuid() }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      registration: { update: vi.fn().mockResolvedValue({}) },
      eventPricing: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            createMockEventPricing({ eventId, basePrice: 300 }),
          ),
      },
      eventAccess: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };

    prismaMock.$transaction.mockImplementation(async (fn: TxCallback) =>
      fn(txMock),
    );

    const result = await createSponsorshipBatch(
      eventId,
      formId,
      makeLinkedInput([regId]),
    );

    expect(result.count).toBe(1);
    expect(txMock.sponsorship.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "USED" }),
      }),
    );
    expect(txMock.sponsorshipUsage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          registrationId: regId,
          appliedBy: "SYSTEM",
        }),
      }),
    );
    expect(txMock.registration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: regId },
        data: expect.objectContaining({
          sponsorshipAmount: { increment: expect.any(Number) },
        }),
      }),
    );
  });

  it("skips registration when capped to zero (fully sponsored)", async () => {
    const regId = faker.string.uuid();
    // Registration already has sponsorshipAmount = totalAmount (fully sponsored)
    const reg = makeRegistration({
      id: regId,
      totalAmount: 300,
      sponsorshipAmount: 300, // fully covered
      baseAmount: 300,
    });

    prismaMock.event.findUnique.mockResolvedValue(mockEvent);
    prismaMock.form.findFirst.mockResolvedValue(mockForm);
    prismaMock.registration.findMany.mockResolvedValue([asMock(reg)]);
    prismaMock.eventAccess.findMany.mockResolvedValue([]);

    const txMock = {
      sponsorshipBatch: {
        create: vi
          .fn()
          .mockResolvedValue(createMockSponsorshipBatch({ eventId })),
      },
      sponsorship: {
        create: vi.fn().mockResolvedValue(createMockSponsorship({ eventId })),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      sponsorshipUsage: {
        create: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
      },
      registration: { update: vi.fn().mockResolvedValue({}) },
      eventPricing: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            createMockEventPricing({ eventId, basePrice: 300 }),
          ),
      },
      eventAccess: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };

    prismaMock.$transaction.mockImplementation(async (fn: TxCallback) =>
      fn(txMock),
    );

    const result = await createSponsorshipBatch(
      eventId,
      formId,
      makeLinkedInput([regId]),
    );

    // Sponsorship skipped → count is 0, no sponsorship created, no usage created
    expect(result.count).toBe(0);
    expect(txMock.sponsorship.create).not.toHaveBeenCalled();
    expect(txMock.sponsorshipUsage.create).not.toHaveBeenCalled();
    expect(txMock.registration.update).not.toHaveBeenCalled();
  });

  it("caps amount for partially-sponsored registration (existing sponsorshipAmount)", async () => {
    const regId = faker.string.uuid();
    // Registration is already 480 / 500 sponsored — new sponsorship should cap to 20
    const reg = makeRegistration({
      id: regId,
      totalAmount: 500,
      sponsorshipAmount: 480, // nearly full
      baseAmount: 500,
    });

    prismaMock.event.findUnique.mockResolvedValue(mockEvent);
    prismaMock.form.findFirst.mockResolvedValue(mockForm);
    prismaMock.registration.findMany.mockResolvedValue([asMock(reg)]);
    prismaMock.eventAccess.findMany.mockResolvedValue([]);

    const txMock = {
      sponsorshipBatch: {
        create: vi
          .fn()
          .mockResolvedValue(createMockSponsorshipBatch({ eventId })),
      },
      sponsorship: {
        create: vi
          .fn()
          .mockResolvedValue(
            createMockSponsorship({ eventId, status: "USED" }),
          ),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      sponsorshipUsage: {
        create: vi.fn().mockResolvedValue({ id: faker.string.uuid() }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      registration: { update: vi.fn().mockResolvedValue({}) },
      eventPricing: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            createMockEventPricing({ eventId, basePrice: 500 }),
          ),
      },
      eventAccess: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };

    prismaMock.$transaction.mockImplementation(async (fn: TxCallback) =>
      fn(txMock),
    );

    const result = await createSponsorshipBatch(
      eventId,
      formId,
      makeLinkedInput([regId]),
    );

    // Sponsorship created with capped amount (not skipped, since 20 > 0)
    expect(result.count).toBe(1);
    expect(txMock.sponsorshipUsage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amountApplied: 20, // capped to remaining 500 - 480 = 20
        }),
      }),
    );
  });

  it("throws when duplicate registrationId in batch", async () => {
    const regId = faker.string.uuid();
    const input = {
      sponsor: sponsorInput,
      linkedBeneficiaries: [
        {
          registrationId: regId,
          email: "doc1@hospital.com",
          name: "Dr. One",
          coversBasePrice: true,
          coveredAccessIds: [],
        },
        {
          registrationId: regId, // duplicate!
          email: "doc2@hospital.com",
          name: "Dr. Two",
          coversBasePrice: true,
          coveredAccessIds: [],
        },
      ],
    };

    prismaMock.event.findUnique.mockResolvedValue(mockEvent);
    prismaMock.form.findFirst.mockResolvedValue(mockForm);
    prismaMock.eventAccess.findMany.mockResolvedValue([]);

    await expect(
      createSponsorshipBatch(eventId, formId, input),
    ).rejects.toThrow(AppError);

    await expect(
      createSponsorshipBatch(eventId, formId, input),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: ErrorCodes.BAD_REQUEST,
    });
  });

  it("throws when registration not found", async () => {
    const missingRegId = faker.string.uuid();

    prismaMock.event.findUnique.mockResolvedValue(mockEvent);
    prismaMock.form.findFirst.mockResolvedValue(mockForm);
    prismaMock.registration.findMany.mockResolvedValue([]); // No registrations found
    prismaMock.eventAccess.findMany.mockResolvedValue([]);

    await expect(
      createSponsorshipBatch(eventId, formId, makeLinkedInput([missingRegId])),
    ).rejects.toThrow(AppError);

    await expect(
      createSponsorshipBatch(eventId, formId, makeLinkedInput([missingRegId])),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: ErrorCodes.NOT_FOUND,
    });
  });

  it("queues sponsorship email for each linked beneficiary", async () => {
    const regId = faker.string.uuid();
    const reg = makeRegistration({ id: regId });

    prismaMock.event.findUnique.mockResolvedValue(mockEvent);
    prismaMock.form.findFirst.mockResolvedValue(mockForm);
    prismaMock.registration.findMany.mockResolvedValue([asMock(reg)]);
    prismaMock.eventAccess.findMany.mockResolvedValue([]);

    const txMock = {
      sponsorshipBatch: {
        create: vi
          .fn()
          .mockResolvedValue(createMockSponsorshipBatch({ eventId })),
      },
      sponsorship: {
        create: vi
          .fn()
          .mockResolvedValue(
            createMockSponsorship({ eventId, status: "USED" }),
          ),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      sponsorshipUsage: {
        create: vi.fn().mockResolvedValue({ id: faker.string.uuid() }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      registration: { update: vi.fn().mockResolvedValue({}) },
      eventPricing: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            createMockEventPricing({ eventId, basePrice: 300 }),
          ),
      },
      eventAccess: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };

    prismaMock.$transaction.mockImplementation(async (fn: TxCallback) =>
      fn(txMock),
    );

    vi.mocked(queueSponsorshipEmail).mockResolvedValue(true);
    vi.mocked(buildLinkedSponsorshipContext).mockReturnValue(asMock({}));

    await createSponsorshipBatch(eventId, formId, makeLinkedInput([regId]));

    expect(queueSponsorshipEmail).toHaveBeenCalledWith(
      "SPONSORSHIP_LINKED",
      eventId,
      expect.objectContaining({
        registrationId: regId,
      }),
    );
  });

  it("does not fail when email queueing fails (resilience)", async () => {
    const regId = faker.string.uuid();
    const reg = makeRegistration({ id: regId });

    prismaMock.event.findUnique.mockResolvedValue(mockEvent);
    prismaMock.form.findFirst.mockResolvedValue(mockForm);
    prismaMock.registration.findMany.mockResolvedValue([asMock(reg)]);
    prismaMock.eventAccess.findMany.mockResolvedValue([]);

    const txMock = {
      sponsorshipBatch: {
        create: vi
          .fn()
          .mockResolvedValue(createMockSponsorshipBatch({ eventId })),
      },
      sponsorship: {
        create: vi
          .fn()
          .mockResolvedValue(
            createMockSponsorship({ eventId, status: "USED" }),
          ),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      sponsorshipUsage: {
        create: vi.fn().mockResolvedValue({ id: faker.string.uuid() }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      registration: { update: vi.fn().mockResolvedValue({}) },
      eventPricing: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            createMockEventPricing({ eventId, basePrice: 300 }),
          ),
      },
      eventAccess: { findMany: vi.fn().mockResolvedValue([]) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };

    prismaMock.$transaction.mockImplementation(async (fn: TxCallback) =>
      fn(txMock),
    );

    // Simulate email failure
    vi.mocked(queueSponsorshipEmail).mockRejectedValue(
      new Error("Email service unavailable"),
    );

    // Should not throw even when email fails
    const result = await createSponsorshipBatch(
      eventId,
      formId,
      makeLinkedInput([regId]),
    );

    expect(result.count).toBe(1);
  });

  it("throws when event not found", async () => {
    prismaMock.event.findUnique.mockResolvedValue(null);

    await expect(
      createSponsorshipBatch(
        eventId,
        formId,
        makeLinkedInput([faker.string.uuid()]),
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: ErrorCodes.NOT_FOUND,
    });
  });
});
