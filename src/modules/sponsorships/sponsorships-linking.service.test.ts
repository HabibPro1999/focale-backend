import { describe, it, expect, vi } from "vitest";
import { faker } from "@faker-js/faker";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { createMockSponsorship } from "../../../tests/helpers/factories.js";

// Type for transaction callback - eslint-disable to allow any for mock flexibility
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxCallback = (tx: any) => Promise<unknown>;

// Mock values often don't match the full Prisma types - this is intentional
// since we only mock the fields the function actually uses
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asMock = <T>(value: T): any => value;

/**
 * Build a valid stored PriceBreakdown fixture for tests.
 * parsePriceBreakdown validates the full schema; partial objects return zero.
 */
function makeBreakdown(
  calculatedBasePrice = 0,
  accessItems: Array<{
    accessId: string;
    name?: string;
    unitPrice?: number;
    quantity?: number;
    subtotal: number;
  }> = [],
) {
  const accessTotal = accessItems.reduce((s, i) => s + i.subtotal, 0);
  return {
    basePrice: calculatedBasePrice,
    appliedRules: [],
    calculatedBasePrice,
    accessItems: accessItems.map((i) => ({
      accessId: i.accessId,
      name: i.name ?? i.accessId,
      unitPrice: i.unitPrice ?? i.subtotal,
      quantity: i.quantity ?? 1,
      subtotal: i.subtotal,
    })),
    accessTotal,
    subtotal: calculatedBasePrice + accessTotal,
    sponsorships: [],
    sponsorshipTotal: 0,
    total: calculatedBasePrice + accessTotal,
    currency: "TND",
  };
}

import {
  linkSponsorshipToRegistration,
  linkSponsorshipByCode,
  unlinkSponsorshipFromRegistration,
  type LinkSponsorshipResult,
} from "./sponsorships-linking.service.js";
import {
  getAvailableSponsorships,
  getLinkedSponsorships,
  recalculateUsageAmounts,
} from "./sponsorships-query.service.js";
import { ErrorCodes } from "@shared/errors.js";

describe("Sponsorships Linking Service", () => {
  const eventId = faker.string.uuid();
  const batchId = faker.string.uuid();
  const adminUserId = faker.string.uuid();

  describe("linkSponsorshipToRegistration", () => {
    const sponsorshipId = faker.string.uuid();
    const registrationId = faker.string.uuid();

    it("should link sponsorship successfully", async () => {
      const mockSponsorship = {
        ...createMockSponsorship({
          id: sponsorshipId,
          eventId,
          status: "PENDING",
          coversBasePrice: true,
          coveredAccessIds: [],
          totalAmount: 200,
        }),
        usages: [],
      };
      const mockRegistration = {
        id: registrationId,
        eventId,
        totalAmount: 300,
        baseAmount: 200,
        accessTypeIds: [],
        priceBreakdown: makeBreakdown(200),
        sponsorshipAmount: 0,
        sponsorshipUsages: [],
      };

      prismaMock.sponsorship.findUnique.mockResolvedValue(mockSponsorship);
      prismaMock.registration.findUnique.mockResolvedValue(
        asMock(mockRegistration),
      );
      prismaMock.sponsorshipUsage.findUnique.mockResolvedValue(null);

      const mockUsage = {
        id: faker.string.uuid(),
        sponsorshipId,
        registrationId,
        amountApplied: 200,
      };

      prismaMock.$transaction.mockImplementation(async (fn: TxCallback) => {
        const txMock = {
          sponsorshipUsage: {
            create: vi.fn().mockResolvedValue(mockUsage),
            findMany: vi.fn().mockResolvedValue([mockUsage]),
          },
          sponsorship: {
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          registration: { update: vi.fn().mockResolvedValue({}) },
          auditLog: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(txMock);
      });

      const result = await linkSponsorshipToRegistration(
        sponsorshipId,
        registrationId,
        adminUserId,
      );

      expect(result.skipped).toBe(false);
      const linked = result as LinkSponsorshipResult;
      expect(linked.usage.amountApplied).toBe(200);
      expect(linked.registration.sponsorshipAmount).toBe(200);
      expect(linked.warnings).toHaveLength(0);
    });

    it("should throw when sponsorship not found", async () => {
      prismaMock.sponsorship.findUnique.mockResolvedValue(null);

      await expect(
        linkSponsorshipToRegistration(
          sponsorshipId,
          registrationId,
          adminUserId,
        ),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it("should throw when sponsorship is cancelled", async () => {
      const mockSponsorship = {
        ...createMockSponsorship({
          id: sponsorshipId,
          eventId,
          status: "CANCELLED",
        }),
        usages: [],
      };

      prismaMock.sponsorship.findUnique.mockResolvedValue(mockSponsorship);

      await expect(
        linkSponsorshipToRegistration(
          sponsorshipId,
          registrationId,
          adminUserId,
        ),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.BAD_REQUEST,
      });
    });

    it("should throw when registration not found", async () => {
      const mockSponsorship = {
        ...createMockSponsorship({
          id: sponsorshipId,
          eventId,
          status: "PENDING",
        }),
        usages: [],
      };

      prismaMock.sponsorship.findUnique.mockResolvedValue(mockSponsorship);
      prismaMock.registration.findUnique.mockResolvedValue(null);

      await expect(
        linkSponsorshipToRegistration(
          sponsorshipId,
          registrationId,
          adminUserId,
        ),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.REGISTRATION_NOT_FOUND,
      });
    });

    it("should throw when sponsorship and registration are for different events", async () => {
      const differentEventId = faker.string.uuid();
      const mockSponsorship = {
        ...createMockSponsorship({
          id: sponsorshipId,
          eventId,
          status: "PENDING",
        }),
        usages: [],
      };
      const mockRegistration = {
        id: registrationId,
        eventId: differentEventId,
        totalAmount: 300,
        baseAmount: 200,
        accessTypeIds: [],
        priceBreakdown: makeBreakdown(),
        sponsorshipAmount: 0,
        sponsorshipUsages: [],
      };

      prismaMock.sponsorship.findUnique.mockResolvedValue(mockSponsorship);
      prismaMock.registration.findUnique.mockResolvedValue(
        asMock(mockRegistration),
      );

      await expect(
        linkSponsorshipToRegistration(
          sponsorshipId,
          registrationId,
          adminUserId,
        ),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.BAD_REQUEST,
      });
    });

    it("should throw when sponsorship is already linked to this registration", async () => {
      const mockSponsorship = {
        ...createMockSponsorship({
          id: sponsorshipId,
          eventId,
          status: "PENDING",
        }),
        usages: [],
      };
      const mockRegistration = {
        id: registrationId,
        eventId,
        totalAmount: 300,
        baseAmount: 200,
        accessTypeIds: [],
        priceBreakdown: makeBreakdown(),
        sponsorshipAmount: 0,
        sponsorshipUsages: [],
      };

      prismaMock.sponsorship.findUnique.mockResolvedValue(
        asMock(mockSponsorship),
      );
      prismaMock.registration.findUnique.mockResolvedValue(
        asMock(mockRegistration),
      );
      prismaMock.sponsorshipUsage.findUnique.mockResolvedValue(
        asMock({
          id: faker.string.uuid(),
          sponsorshipId,
          registrationId,
        }),
      );

      await expect(
        linkSponsorshipToRegistration(
          sponsorshipId,
          registrationId,
          adminUserId,
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: ErrorCodes.CONFLICT,
      });
    });

    it("should return skipped result when sponsorship coverage does not apply", async () => {
      const mockSponsorship = {
        ...createMockSponsorship({
          id: sponsorshipId,
          eventId,
          status: "PENDING",
          coversBasePrice: false,
          coveredAccessIds: ["access-xyz"],
          totalAmount: 100,
        }),
        usages: [],
      };
      const mockRegistration = {
        id: registrationId,
        eventId,
        totalAmount: 300,
        baseAmount: 200,
        accessTypeIds: ["access-abc"], // Different from sponsorship coverage
        priceBreakdown: makeBreakdown(200, [
          { accessId: "access-abc", subtotal: 100 },
        ]),
        sponsorshipAmount: 0,
        sponsorshipUsages: [],
      };

      prismaMock.sponsorship.findUnique.mockResolvedValue(mockSponsorship);
      prismaMock.registration.findUnique.mockResolvedValue(
        asMock(mockRegistration),
      );
      prismaMock.sponsorshipUsage.findUnique.mockResolvedValue(null);

      const result = await linkSponsorshipToRegistration(
        sponsorshipId,
        registrationId,
        adminUserId,
      );

      expect(result).toMatchObject({
        skipped: true,
        reason: expect.stringContaining("does not apply"),
      });
    });

    it("should return skipped result when registration is fully sponsored", async () => {
      const mockSponsorship = {
        ...createMockSponsorship({
          id: sponsorshipId,
          eventId,
          status: "PENDING",
          coversBasePrice: true,
          coveredAccessIds: [],
          totalAmount: 200,
        }),
        usages: [],
      };
      const mockRegistration = {
        id: registrationId,
        eventId,
        totalAmount: 300,
        baseAmount: 200,
        accessTypeIds: [],
        priceBreakdown: makeBreakdown(200),
        sponsorshipAmount: 300, // fully sponsored
        sponsorshipUsages: [],
      };

      prismaMock.sponsorship.findUnique.mockResolvedValue(mockSponsorship);
      prismaMock.registration.findUnique.mockResolvedValue(
        asMock(mockRegistration),
      );
      prismaMock.sponsorshipUsage.findUnique.mockResolvedValue(null);

      const result = await linkSponsorshipToRegistration(
        sponsorshipId,
        registrationId,
        adminUserId,
      );

      expect(result).toMatchObject({
        skipped: true,
        reason: expect.stringContaining("fully sponsored"),
      });
    });

    it("should return warnings when coverage overlaps with existing sponsorships", async () => {
      const existingSponsorshipId = faker.string.uuid();
      const mockSponsorship = {
        ...createMockSponsorship({
          id: sponsorshipId,
          eventId,
          status: "PENDING",
          coversBasePrice: true,
          coveredAccessIds: [],
          totalAmount: 200,
        }),
        usages: [],
      };
      const mockRegistration = {
        id: registrationId,
        eventId,
        totalAmount: 300,
        baseAmount: 200,
        accessTypeIds: [],
        priceBreakdown: makeBreakdown(200),
        sponsorshipAmount: 200,
        sponsorshipUsages: [
          {
            sponsorshipId: existingSponsorshipId,
            sponsorship: {
              code: "SP-EXIST",
              coversBasePrice: true, // Already covers base price
              coveredAccessIds: [],
            },
          },
        ],
      };

      prismaMock.sponsorship.findUnique.mockResolvedValue(mockSponsorship);
      prismaMock.registration.findUnique.mockResolvedValue(
        asMock(mockRegistration),
      );
      prismaMock.sponsorshipUsage.findUnique.mockResolvedValue(null);

      const mockUsage = {
        id: faker.string.uuid(),
        sponsorshipId,
        registrationId,
        amountApplied: 200,
      };

      prismaMock.$transaction.mockImplementation(async (fn: TxCallback) => {
        const txMock = {
          sponsorshipUsage: {
            create: vi.fn().mockResolvedValue(mockUsage),
            findMany: vi
              .fn()
              .mockResolvedValue([
                { amountApplied: 200 },
                { amountApplied: 200 },
              ]),
          },
          sponsorship: {
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          registration: { update: vi.fn().mockResolvedValue({}) },
          auditLog: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(txMock);
      });

      const result = await linkSponsorshipToRegistration(
        sponsorshipId,
        registrationId,
        adminUserId,
      );

      expect(result.skipped).toBe(false);
      const linked = result as LinkSponsorshipResult;
      expect(linked.warnings).toHaveLength(1);
      expect(linked.warnings[0]).toContain("Base price is already covered");
    });
  });

  describe("linkSponsorshipByCode", () => {
    const code = "SP-TEST";
    const registrationId = faker.string.uuid();

    it("should find sponsorship by code and link it", async () => {
      const sponsorshipId = faker.string.uuid();
      const mockRegistrationForLookup = {
        eventId,
      };
      const mockSponsorship = {
        ...createMockSponsorship({
          id: sponsorshipId,
          eventId,
          code,
          status: "PENDING",
          coversBasePrice: true,
          coveredAccessIds: [],
          totalAmount: 200,
        }),
        batch: {
          id: batchId,
          labName: "Test Lab",
          contactName: "Test Contact",
          email: "test@lab.com",
          phone: null,
        },
        usages: [],
      };
      const mockRegistration = {
        id: registrationId,
        eventId,
        totalAmount: 300,
        baseAmount: 200,
        accessTypeIds: [],
        priceBreakdown: makeBreakdown(200),
        sponsorshipAmount: 0,
        sponsorshipUsages: [],
      };

      prismaMock.registration.findUnique
        .mockResolvedValueOnce(asMock(mockRegistrationForLookup))
        .mockResolvedValueOnce(asMock(mockRegistration));
      prismaMock.sponsorship.findFirst.mockResolvedValue(
        asMock(mockSponsorship),
      );
      prismaMock.sponsorship.findUnique.mockResolvedValue(
        asMock(mockSponsorship),
      );
      prismaMock.sponsorshipUsage.findUnique.mockResolvedValue(null);

      const mockUsage = {
        id: faker.string.uuid(),
        sponsorshipId,
        registrationId,
        amountApplied: 200,
      };

      prismaMock.$transaction.mockImplementation(async (fn: TxCallback) => {
        const txMock = {
          sponsorshipUsage: {
            create: vi.fn().mockResolvedValue(mockUsage),
            findMany: vi.fn().mockResolvedValue([mockUsage]),
          },
          sponsorship: {
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          registration: { update: vi.fn().mockResolvedValue({}) },
          auditLog: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(txMock);
      });

      const result = await linkSponsorshipByCode(
        registrationId,
        code,
        adminUserId,
      );

      expect(result.skipped).toBe(false);
      const linked = result as LinkSponsorshipResult;
      expect(linked.usage.sponsorshipId).toBe(sponsorshipId);
    });

    it("should throw when registration not found", async () => {
      prismaMock.registration.findUnique.mockResolvedValue(null);

      await expect(
        linkSponsorshipByCode(registrationId, code, adminUserId),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.REGISTRATION_NOT_FOUND,
      });
    });

    it("should throw when code not found for event", async () => {
      prismaMock.registration.findUnique.mockResolvedValue(asMock({ eventId }));
      prismaMock.sponsorship.findFirst.mockResolvedValue(null);

      await expect(
        linkSponsorshipByCode(registrationId, code, adminUserId),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });
  });

  describe("unlinkSponsorshipFromRegistration", () => {
    const sponsorshipId = faker.string.uuid();
    const registrationId = faker.string.uuid();

    it("should unlink sponsorship successfully", async () => {
      const usageId = faker.string.uuid();

      prismaMock.sponsorshipUsage.findUnique.mockResolvedValue(
        asMock({
          id: usageId,
          sponsorshipId,
          registrationId,
          amountApplied: 200,
        }),
      );
      prismaMock.sponsorshipUsage.delete.mockResolvedValue(asMock({}));
      prismaMock.sponsorshipUsage.findMany.mockResolvedValue([]);
      prismaMock.sponsorshipUsage.count.mockResolvedValue(0);
      prismaMock.registration.update.mockResolvedValue(asMock({}));
      prismaMock.sponsorship.findUnique.mockResolvedValue(
        asMock({ status: "USED" }),
      );
      prismaMock.sponsorship.update.mockResolvedValue(asMock({}));
      prismaMock.auditLog.create.mockResolvedValue(asMock({}));

      await expect(
        unlinkSponsorshipFromRegistration(sponsorshipId, registrationId),
      ).resolves.toBeUndefined();
    });

    it("should throw when link not found", async () => {
      prismaMock.sponsorshipUsage.findUnique.mockResolvedValue(null);

      await expect(
        unlinkSponsorshipFromRegistration(sponsorshipId, registrationId),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it("should update sponsorship status to PENDING when no more usages", async () => {
      const usageId = faker.string.uuid();

      prismaMock.sponsorshipUsage.findUnique.mockResolvedValue(
        asMock({
          id: usageId,
          sponsorshipId,
          registrationId,
          amountApplied: 200,
        }),
      );
      prismaMock.sponsorshipUsage.delete.mockResolvedValue(asMock({}));
      prismaMock.sponsorshipUsage.findMany.mockResolvedValue([]);
      prismaMock.sponsorshipUsage.count.mockResolvedValue(0); // No more usages
      prismaMock.registration.update.mockResolvedValue(asMock({}));
      prismaMock.sponsorship.findUnique.mockResolvedValue(
        asMock({ status: "USED" }),
      );
      prismaMock.sponsorship.update.mockResolvedValue(asMock({}));
      prismaMock.auditLog.create.mockResolvedValue(asMock({}));

      await unlinkSponsorshipFromRegistration(sponsorshipId, registrationId);

      expect(prismaMock.sponsorship.update).toHaveBeenCalledWith({
        where: { id: sponsorshipId },
        data: { status: "PENDING" },
      });
    });
  });

  describe("getAvailableSponsorships", () => {
    const registrationId = faker.string.uuid();

    it("should return available sponsorships with applicable amounts", async () => {
      const mockRegistration = {
        id: registrationId,
        eventId,
        totalAmount: 300,
        baseAmount: 200,
        accessTypeIds: [],
        priceBreakdown: makeBreakdown(200),
        sponsorshipUsages: [],
      };
      const mockSponsorships = [
        {
          ...createMockSponsorship({
            eventId,
            status: "PENDING",
            coversBasePrice: true,
            totalAmount: 200,
          }),
          batch: { labName: "Lab A" },
        },
        {
          ...createMockSponsorship({
            eventId,
            status: "PENDING",
            coversBasePrice: false,
            coveredAccessIds: ["access-1"],
            totalAmount: 50,
          }),
          batch: { labName: "Lab B" },
        },
      ];

      prismaMock.registration.findUnique.mockResolvedValue(
        asMock(mockRegistration),
      );
      prismaMock.sponsorship.findMany.mockResolvedValue(mockSponsorships);

      const result = await getAvailableSponsorships(eventId, registrationId);

      expect(result).toHaveLength(2);
      expect(result[0].applicableAmount).toBe(200);
      expect(result[1].applicableAmount).toBe(0); // No overlap
    });

    it("should throw when registration not found", async () => {
      prismaMock.registration.findUnique.mockResolvedValue(null);

      await expect(
        getAvailableSponsorships(eventId, registrationId),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.REGISTRATION_NOT_FOUND,
      });
    });

    it("should throw when registration does not belong to event", async () => {
      const differentEventId = faker.string.uuid();
      const mockRegistration = {
        id: registrationId,
        eventId: differentEventId,
        totalAmount: 300,
        baseAmount: 200,
        accessTypeIds: [],
        priceBreakdown: makeBreakdown(),
        sponsorshipUsages: [],
      };

      prismaMock.registration.findUnique.mockResolvedValue(
        asMock(mockRegistration),
      );

      await expect(
        getAvailableSponsorships(eventId, registrationId),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.BAD_REQUEST,
      });
    });

    it("should detect conflicts with existing sponsorships", async () => {
      const existingSponsorshipId = faker.string.uuid();
      const mockRegistration = {
        id: registrationId,
        eventId,
        totalAmount: 300,
        baseAmount: 200,
        accessTypeIds: [],
        priceBreakdown: makeBreakdown(200),
        sponsorshipUsages: [
          {
            sponsorshipId: existingSponsorshipId,
            sponsorship: {
              code: "SP-EXIST",
              coversBasePrice: true,
              coveredAccessIds: [],
            },
          },
        ],
      };
      const mockSponsorships = [
        {
          ...createMockSponsorship({
            eventId,
            status: "PENDING",
            coversBasePrice: true, // Conflicts with existing
            totalAmount: 200,
          }),
          batch: { labName: "Lab A" },
        },
      ];

      prismaMock.registration.findUnique.mockResolvedValue(
        asMock(mockRegistration),
      );
      prismaMock.sponsorship.findMany.mockResolvedValue(mockSponsorships);

      const result = await getAvailableSponsorships(eventId, registrationId);

      expect(result).toHaveLength(1);
      expect(result[0].conflicts).toHaveLength(1);
      expect(result[0].conflicts[0]).toContain("Base price is already covered");
    });
  });

  describe("getLinkedSponsorships", () => {
    const registrationId = faker.string.uuid();

    it("should return linked sponsorships with usage info", async () => {
      const sponsorshipId = faker.string.uuid();
      const usageId = faker.string.uuid();
      const mockUsages = [
        {
          id: usageId,
          sponsorshipId,
          registrationId,
          amountApplied: 200,
          appliedAt: new Date(),
          sponsorship: {
            id: sponsorshipId,
            code: "SP-TEST",
            status: "USED",
            beneficiaryName: "Dr. Test",
            beneficiaryEmail: "test@example.com",
            coversBasePrice: true,
            coveredAccessIds: [],
            totalAmount: 200,
            batch: {
              id: batchId,
              labName: "Test Lab",
              contactName: "Contact",
              email: "lab@test.com",
            },
          },
        },
      ];

      prismaMock.sponsorshipUsage.findMany.mockResolvedValue(
        asMock(mockUsages),
      );

      const result = await getLinkedSponsorships(registrationId);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(sponsorshipId);
      expect(result[0].code).toBe("SP-TEST");
      expect(result[0].usage.id).toBe(usageId);
      expect(result[0].usage.amountApplied).toBe(200);
    });

    it("should return empty array when no linked sponsorships", async () => {
      prismaMock.sponsorshipUsage.findMany.mockResolvedValue([]);

      const result = await getLinkedSponsorships(registrationId);

      expect(result).toHaveLength(0);
    });
  });

  describe("recalculateUsageAmounts", () => {
    it("should do nothing when sponsorship not found", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txMock: any = {
        sponsorship: { findUnique: vi.fn().mockResolvedValue(null) },
        sponsorshipUsage: { update: vi.fn() },
        $executeRaw: vi.fn(),
      };

      await recalculateUsageAmounts(txMock, faker.string.uuid());

      expect(txMock.sponsorshipUsage.update).not.toHaveBeenCalled();
      expect(txMock.$executeRaw).not.toHaveBeenCalled();
    });

    it("should skip usages where registration was deleted", async () => {
      const sponsorshipId = faker.string.uuid();
      const mockSponsorship = {
        id: sponsorshipId,
        coversBasePrice: true,
        coveredAccessIds: [],
        totalAmount: 200,
        usages: [
          {
            id: faker.string.uuid(),
            amountApplied: 100,
            registration: null, // deleted
          },
        ],
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txMock: any = {
        sponsorship: {
          findUnique: vi.fn().mockResolvedValue(mockSponsorship),
        },
        sponsorshipUsage: { update: vi.fn() },
        $executeRaw: vi.fn(),
      };

      await recalculateUsageAmounts(txMock, sponsorshipId);

      expect(txMock.sponsorshipUsage.update).not.toHaveBeenCalled();
      expect(txMock.$executeRaw).not.toHaveBeenCalled();
    });

    it("should update usage amount and atomically adjust registration sponsorshipAmount by delta", async () => {
      const sponsorshipId = faker.string.uuid();
      const usageId = faker.string.uuid();
      const registrationId = faker.string.uuid();

      // Sponsorship covers base price, totalAmount = 200
      // Registration totalAmount = 300, baseAmount = 200
      // Old usage amountApplied = 150
      // New applicable amount = 200 (calculateApplicableAmount returns min(totalAmount, baseAmount) = 200)
      // Delta = 200 - 150 = 50
      const mockSponsorship = {
        id: sponsorshipId,
        coversBasePrice: true,
        coveredAccessIds: [],
        totalAmount: 200,
        usages: [
          {
            id: usageId,
            amountApplied: 150,
            registration: {
              id: registrationId,
              totalAmount: 300,
              baseAmount: 200,
              accessTypeIds: [],
              priceBreakdown: makeBreakdown(200),
            },
          },
        ],
      };

      const executeRawMock = vi.fn().mockResolvedValue(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txMock: any = {
        sponsorship: {
          findUnique: vi.fn().mockResolvedValue(mockSponsorship),
        },
        sponsorshipUsage: {
          update: vi.fn().mockResolvedValue({}),
        },
        $executeRaw: executeRawMock,
      };

      await recalculateUsageAmounts(txMock, sponsorshipId);

      // Usage should be updated to the new calculated amount (200)
      expect(txMock.sponsorshipUsage.update).toHaveBeenCalledWith({
        where: { id: usageId },
        data: { amountApplied: 200 },
      });

      // $executeRaw should be called once (atomic increment for the registration)
      expect(executeRawMock).toHaveBeenCalledTimes(1);
    });

    it("should apply negative delta when new amount is less than old amount", async () => {
      const sponsorshipId = faker.string.uuid();
      const usageId = faker.string.uuid();
      const registrationId = faker.string.uuid();

      // Old amount = 200, new applicable = 100 (coverage reduced)
      // Delta = 100 - 200 = -100
      const mockSponsorship = {
        id: sponsorshipId,
        coversBasePrice: false,
        coveredAccessIds: ["access-1"],
        totalAmount: 100,
        usages: [
          {
            id: usageId,
            amountApplied: 200,
            registration: {
              id: registrationId,
              totalAmount: 300,
              baseAmount: 200,
              accessTypeIds: ["access-1"],
              priceBreakdown: makeBreakdown(200, [
                { accessId: "access-1", subtotal: 100 },
              ]),
            },
          },
        ],
      };

      const executeRawMock = vi.fn().mockResolvedValue(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txMock: any = {
        sponsorship: {
          findUnique: vi.fn().mockResolvedValue(mockSponsorship),
        },
        sponsorshipUsage: {
          update: vi.fn().mockResolvedValue({}),
        },
        $executeRaw: executeRawMock,
      };

      await recalculateUsageAmounts(txMock, sponsorshipId);

      // Usage updated to 100 (new applicable amount)
      expect(txMock.sponsorshipUsage.update).toHaveBeenCalledWith({
        where: { id: usageId },
        data: { amountApplied: 100 },
      });

      // $executeRaw called once for the atomic decrement
      expect(executeRawMock).toHaveBeenCalledTimes(1);
    });

    it("should handle multiple usages across different registrations atomically", async () => {
      const sponsorshipId = faker.string.uuid();
      const usageId1 = faker.string.uuid();
      const usageId2 = faker.string.uuid();
      const registrationId1 = faker.string.uuid();
      const registrationId2 = faker.string.uuid();

      const mockSponsorship = {
        id: sponsorshipId,
        coversBasePrice: true,
        coveredAccessIds: [],
        totalAmount: 200,
        usages: [
          {
            id: usageId1,
            amountApplied: 100,
            registration: {
              id: registrationId1,
              totalAmount: 300,
              baseAmount: 200,
              accessTypeIds: [],
              priceBreakdown: makeBreakdown(200),
            },
          },
          {
            id: usageId2,
            amountApplied: 150,
            registration: {
              id: registrationId2,
              totalAmount: 400,
              baseAmount: 300,
              accessTypeIds: [],
              priceBreakdown: makeBreakdown(300),
            },
          },
        ],
      };

      const executeRawMock = vi.fn().mockResolvedValue(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txMock: any = {
        sponsorship: {
          findUnique: vi.fn().mockResolvedValue(mockSponsorship),
        },
        sponsorshipUsage: {
          update: vi.fn().mockResolvedValue({}),
        },
        $executeRaw: executeRawMock,
      };

      await recalculateUsageAmounts(txMock, sponsorshipId);

      // Both usages updated
      expect(txMock.sponsorshipUsage.update).toHaveBeenCalledTimes(2);
      // $executeRaw called once per registration (2 registrations)
      expect(executeRawMock).toHaveBeenCalledTimes(2);
    });

    it("should not call $executeRaw when sponsorship has no usages", async () => {
      const sponsorshipId = faker.string.uuid();
      const mockSponsorship = {
        id: sponsorshipId,
        coversBasePrice: true,
        coveredAccessIds: [],
        totalAmount: 200,
        usages: [],
      };

      const executeRawMock = vi.fn().mockResolvedValue(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const txMock: any = {
        sponsorship: {
          findUnique: vi.fn().mockResolvedValue(mockSponsorship),
        },
        sponsorshipUsage: { update: vi.fn() },
        $executeRaw: executeRawMock,
      };

      await recalculateUsageAmounts(txMock, sponsorshipId);

      expect(txMock.sponsorshipUsage.update).not.toHaveBeenCalled();
      expect(executeRawMock).not.toHaveBeenCalled();
    });
  });
});
