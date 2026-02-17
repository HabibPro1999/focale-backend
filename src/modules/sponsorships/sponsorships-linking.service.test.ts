import { describe, it, expect, vi } from "vitest";
import { faker } from "@faker-js/faker";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import {
  createMockEvent,
  createMockEventPricing,
  createMockEventAccess,
  createMockSponsorship,
} from "../../../tests/helpers/factories.js";

// Type for transaction callback - eslint-disable to allow any for mock flexibility
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxCallback = (tx: any) => Promise<unknown>;

// Mock values often don't match the full Prisma types - this is intentional
// since we only mock the fields the function actually uses
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asMock = <T>(value: T): any => value;

import {
  linkSponsorshipToRegistration,
  linkSponsorshipByCode,
  unlinkSponsorshipFromRegistration,
  getAvailableSponsorships,
  getLinkedSponsorships,
} from "./sponsorships-linking.service.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

// Suppress unused import warnings for factory helpers used implicitly
void createMockEvent;
void createMockEventPricing;
void createMockEventAccess;

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
        priceBreakdown: { calculatedBasePrice: 200, accessItems: [] },
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

      expect(result.usage.amountApplied).toBe(200);
      expect(result.registration.sponsorshipAmount).toBe(200);
      expect(result.warnings).toHaveLength(0);
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
        priceBreakdown: {},
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
        priceBreakdown: {},
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

    it("should throw when sponsorship coverage does not apply", async () => {
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
        priceBreakdown: {
          calculatedBasePrice: 200,
          accessItems: [{ accessId: "access-abc", subtotal: 100 }],
        },
        sponsorshipAmount: 0,
        sponsorshipUsages: [],
      };

      prismaMock.sponsorship.findUnique.mockResolvedValue(mockSponsorship);
      prismaMock.registration.findUnique.mockResolvedValue(
        asMock(mockRegistration),
      );
      prismaMock.sponsorshipUsage.findUnique.mockResolvedValue(null);

      await expect(
        linkSponsorshipToRegistration(
          sponsorshipId,
          registrationId,
          adminUserId,
        ),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.SPONSORSHIP_NOT_APPLICABLE,
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
        priceBreakdown: { calculatedBasePrice: 200, accessItems: [] },
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

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("Base price is already covered");
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
        priceBreakdown: { calculatedBasePrice: 200, accessItems: [] },
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

      expect(result.usage.sponsorshipId).toBe(sponsorshipId);
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
        priceBreakdown: { calculatedBasePrice: 200, accessItems: [] },
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
        priceBreakdown: {},
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
        priceBreakdown: { calculatedBasePrice: 200, accessItems: [] },
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
});
