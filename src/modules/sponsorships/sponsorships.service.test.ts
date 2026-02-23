import { describe, it, expect, vi } from "vitest";
import { faker } from "@faker-js/faker";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import {
  createMockEvent,
  createMockEventPricing,
  createMockEventAccess,
  createMockForm,
  createMockSponsorship,
  createMockSponsorshipBatch,
} from "../../../tests/helpers/factories.js";

// Type for transaction callback - eslint-disable to allow any for mock flexibility
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxCallback = (tx: any) => Promise<unknown>;

// Mock values often don't match the full Prisma types - this is intentional
// since we only mock the fields the function actually uses
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asMock = <T>(value: T): any => value;

// groupBy has complex overloaded types that mockDeep doesn't handle
const mockGroupBy = vi.mocked(
  prismaMock.sponsorship.groupBy as unknown as (() => unknown) & {
    mockResolvedValue: (v: unknown) => void;
  },
);
import {
  listSponsorships,
  getSponsorshipById,
  getSponsorshipByCode,
  updateSponsorship,
  deleteSponsorship,
  cancelSponsorship,
  getSponsorshipClientId,
  getSponsorshipStats,
} from "./sponsorships.service.js";
import { createSponsorshipBatch } from "./sponsorships-batch.service.js";
import {
  generateUniqueCode,
  calculateApplicableAmount,
  detectCoverageOverlap,
  calculateTotalSponsorshipAmount,
  determineSponsorshipStatus,
} from "./sponsorships.utils.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";

// ============================================================================
// Utility Tests
// ============================================================================

describe("Sponsorship Utils", () => {
  describe("generateUniqueCode", () => {
    it("should generate code with SP- prefix and valid characters", async () => {
      prismaMock.sponsorship.findUnique.mockResolvedValue(null);
      const code = await generateUniqueCode(prismaMock as never);
      expect(code).toMatch(/^SP-[A-HJ-NP-Z2-9]{4}$/);
    });

    it("should retry when code already exists", async () => {
      prismaMock.sponsorship.findUnique
        .mockResolvedValueOnce({ id: "existing" } as never)
        .mockResolvedValueOnce(null);
      const code = await generateUniqueCode(prismaMock as never);
      expect(code).toMatch(/^SP-[A-HJ-NP-Z2-9]{4}$/);
      expect(prismaMock.sponsorship.findUnique).toHaveBeenCalledTimes(2);
    });

    it("should throw after max attempts", async () => {
      prismaMock.sponsorship.findUnique.mockResolvedValue({
        id: "existing",
      } as never);
      await expect(generateUniqueCode(prismaMock as never, 3)).rejects.toThrow(
        "Failed to generate unique sponsorship code",
      );
      expect(prismaMock.sponsorship.findUnique).toHaveBeenCalledTimes(3);
    });
  });

  describe("calculateApplicableAmount", () => {
    it("should return 0 when sponsorship covers nothing the registration has", () => {
      const sponsorship = {
        coversBasePrice: false,
        coveredAccessIds: ["access-xyz"],
        totalAmount: 100,
      };
      const registration = {
        totalAmount: 300,
        baseAmount: 200,
        accessTypeIds: ["access-abc"],
        priceBreakdown: {
          calculatedBasePrice: 200,
          accessItems: [{ accessId: "access-abc", subtotal: 100 }],
        },
      };

      const result = calculateApplicableAmount(sponsorship, registration);
      expect(result).toBe(0);
    });

    it("should apply base price when sponsored and registration has it", () => {
      const sponsorship = {
        coversBasePrice: true,
        coveredAccessIds: [],
        totalAmount: 200,
      };
      const registration = {
        totalAmount: 200,
        baseAmount: 200,
        accessTypeIds: [],
        priceBreakdown: {
          calculatedBasePrice: 200,
          accessItems: [],
        },
      };

      const result = calculateApplicableAmount(sponsorship, registration);
      expect(result).toBe(200);
    });

    it("should apply access items that overlap between sponsorship and registration", () => {
      const sponsorship = {
        coversBasePrice: false,
        coveredAccessIds: ["access-1", "access-2"],
        totalAmount: 150,
      };
      const registration = {
        totalAmount: 350,
        baseAmount: 200,
        accessTypeIds: ["access-1", "access-3"],
        priceBreakdown: {
          calculatedBasePrice: 200,
          accessItems: [
            { accessId: "access-1", subtotal: 50 },
            { accessId: "access-3", subtotal: 100 },
          ],
        },
      };

      const result = calculateApplicableAmount(sponsorship, registration);
      expect(result).toBe(50); // Only access-1 overlaps
    });

    it("should apply both base price and access items", () => {
      const sponsorship = {
        coversBasePrice: true,
        coveredAccessIds: ["access-1"],
        totalAmount: 250,
      };
      const registration = {
        totalAmount: 350,
        baseAmount: 200,
        accessTypeIds: ["access-1", "access-2"],
        priceBreakdown: {
          calculatedBasePrice: 200,
          accessItems: [
            { accessId: "access-1", subtotal: 50 },
            { accessId: "access-2", subtotal: 100 },
          ],
        },
      };

      const result = calculateApplicableAmount(sponsorship, registration);
      expect(result).toBe(250); // 200 base + 50 access-1
    });

    it("should not exceed registration total", () => {
      const sponsorship = {
        coversBasePrice: true,
        coveredAccessIds: [],
        totalAmount: 500,
      };
      const registration = {
        totalAmount: 200,
        baseAmount: 300, // Larger than totalAmount (edge case)
        accessTypeIds: [],
        priceBreakdown: {
          calculatedBasePrice: 300,
          accessItems: [],
        },
      };

      const result = calculateApplicableAmount(sponsorship, registration);
      expect(result).toBe(200); // Capped at registration total
    });

    it("should not exceed sponsorship total", () => {
      const sponsorship = {
        coversBasePrice: true,
        coveredAccessIds: ["access-1"],
        totalAmount: 100, // Less than what would be covered
      };
      const registration = {
        totalAmount: 300,
        baseAmount: 200,
        accessTypeIds: ["access-1"],
        priceBreakdown: {
          calculatedBasePrice: 200,
          accessItems: [{ accessId: "access-1", subtotal: 50 }],
        },
      };

      const result = calculateApplicableAmount(sponsorship, registration);
      expect(result).toBe(100); // Capped at sponsorship total
    });
  });

  describe("detectCoverageOverlap", () => {
    it("should return empty array when no overlap", () => {
      const existingUsages = [
        {
          sponsorshipId: "sp-1",
          sponsorship: {
            code: "SP-AAA1",
            coversBasePrice: true,
            coveredAccessIds: [],
          },
        },
      ];
      const newSponsorship = {
        coversBasePrice: false,
        coveredAccessIds: ["access-1"],
        totalAmount: 100,
      };

      const warnings = detectCoverageOverlap(existingUsages, newSponsorship);
      expect(warnings).toHaveLength(0);
    });

    it("should detect base price overlap", () => {
      const existingUsages = [
        {
          sponsorshipId: "sp-1",
          sponsorship: {
            code: "SP-AAA1",
            coversBasePrice: true,
            coveredAccessIds: [],
          },
        },
      ];
      const newSponsorship = {
        coversBasePrice: true,
        coveredAccessIds: [],
        totalAmount: 100,
      };

      const warnings = detectCoverageOverlap(existingUsages, newSponsorship);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Base price is already covered");
      expect(warnings[0]).toContain("SP-AAA1");
    });

    it("should detect access item overlap", () => {
      const existingUsages = [
        {
          sponsorshipId: "sp-1",
          sponsorship: {
            code: "SP-BBB2",
            coversBasePrice: false,
            coveredAccessIds: ["access-1", "access-2"],
          },
        },
      ];
      const newSponsorship = {
        coversBasePrice: false,
        coveredAccessIds: ["access-2", "access-3"],
        totalAmount: 100,
      };

      const warnings = detectCoverageOverlap(existingUsages, newSponsorship);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("access-2");
      expect(warnings[0]).toContain("SP-BBB2");
    });

    it("should detect multiple overlaps", () => {
      const existingUsages = [
        {
          sponsorshipId: "sp-1",
          sponsorship: {
            code: "SP-CCC3",
            coversBasePrice: true,
            coveredAccessIds: ["access-1"],
          },
        },
      ];
      const newSponsorship = {
        coversBasePrice: true,
        coveredAccessIds: ["access-1"],
        totalAmount: 200,
      };

      const warnings = detectCoverageOverlap(existingUsages, newSponsorship);
      expect(warnings).toHaveLength(2);
    });
  });

  describe("calculateTotalSponsorshipAmount", () => {
    it("should sum all amounts applied", () => {
      const usages = [
        { amountApplied: 100 },
        { amountApplied: 50 },
        { amountApplied: 75 },
      ];

      const total = calculateTotalSponsorshipAmount(usages);
      expect(total).toBe(225);
    });

    it("should return 0 for empty array", () => {
      const total = calculateTotalSponsorshipAmount([]);
      expect(total).toBe(0);
    });
  });

  describe("determineSponsorshipStatus", () => {
    it("should return PENDING when no usages", () => {
      const status = determineSponsorshipStatus({ status: "PENDING" }, 0);
      expect(status).toBe("PENDING");
    });

    it("should return USED when has usages", () => {
      const status = determineSponsorshipStatus({ status: "PENDING" }, 1);
      expect(status).toBe("USED");
    });

    it("should keep CANCELLED status regardless of usage count", () => {
      const status = determineSponsorshipStatus({ status: "CANCELLED" }, 0);
      expect(status).toBe("CANCELLED");

      const statusWithUsages = determineSponsorshipStatus(
        { status: "CANCELLED" },
        5,
      );
      expect(statusWithUsages).toBe("CANCELLED");
    });

    it("should return PENDING when USED status has no usages", () => {
      const status = determineSponsorshipStatus({ status: "USED" }, 0);
      expect(status).toBe("PENDING");
    });
  });
});

// ============================================================================
// Service Tests
// ============================================================================

describe("Sponsorships Service", () => {
  const eventId = faker.string.uuid();
  const formId = faker.string.uuid();
  const batchId = faker.string.uuid();

  describe("createSponsorshipBatch", () => {
    const validInput = {
      sponsor: {
        labName: "Acme Pharmaceuticals",
        contactName: "John Doe",
        email: "john@acme.com",
        phone: "+1234567890",
      },
      customFields: { notes: "VIP sponsors" },
      beneficiaries: [
        {
          name: "Dr. Jane Smith",
          email: "jane@hospital.com",
          phone: "+0987654321",
          coversBasePrice: true,
          coveredAccessIds: [],
        },
      ],
    };

    it("should create batch with sponsorships successfully", async () => {
      const mockEvent = createMockEvent({ id: eventId });
      const mockForm = createMockForm({ id: formId, eventId, type: "SPONSOR" });
      const mockBatch = createMockSponsorshipBatch({
        id: batchId,
        eventId,
        formId,
      });
      const mockSponsorship = createMockSponsorship({ eventId, batchId });
      const mockPricing = createMockEventPricing({ eventId, basePrice: 300 });

      prismaMock.event.findUnique.mockResolvedValue(mockEvent);
      prismaMock.form.findFirst.mockResolvedValue(mockForm);
      prismaMock.$transaction.mockImplementation(async (fn: TxCallback) => {
        const txMock = {
          sponsorshipBatch: { create: vi.fn().mockResolvedValue(mockBatch) },
          sponsorship: {
            create: vi.fn().mockResolvedValue(mockSponsorship),
            findUnique: vi.fn().mockResolvedValue(null), // For unique code check
          },
          eventPricing: { findUnique: vi.fn().mockResolvedValue(mockPricing) },
          eventAccess: { findMany: vi.fn().mockResolvedValue([]) },
          auditLog: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(txMock);
      });

      const result = await createSponsorshipBatch(eventId, formId, validInput);

      expect(result.batchId).toBe(batchId);
      expect(result.count).toBe(1);
    });

    it("should throw when event not found", async () => {
      prismaMock.event.findUnique.mockResolvedValue(null);

      await expect(
        createSponsorshipBatch(eventId, formId, validInput),
      ).rejects.toThrow(AppError);

      await expect(
        createSponsorshipBatch(eventId, formId, validInput),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it("should throw when sponsor form not found", async () => {
      const mockEvent = createMockEvent({ id: eventId });
      prismaMock.event.findUnique.mockResolvedValue(mockEvent);
      prismaMock.form.findFirst.mockResolvedValue(null);

      await expect(
        createSponsorshipBatch(eventId, formId, validInput),
      ).rejects.toThrow(AppError);
    });

    it("should throw when invalid access IDs provided", async () => {
      const mockEvent = createMockEvent({ id: eventId });
      const mockForm = createMockForm({ id: formId, eventId, type: "SPONSOR" });

      prismaMock.event.findUnique.mockResolvedValue(mockEvent);
      prismaMock.form.findFirst.mockResolvedValue(mockForm);
      prismaMock.eventAccess.findMany.mockResolvedValue([]); // No valid access items

      const inputWithAccess = {
        ...validInput,
        beneficiaries: [
          {
            name: "Dr. Jane Smith",
            email: "jane@hospital.com",
            coversBasePrice: false,
            coveredAccessIds: ["invalid-access-id"],
          },
        ],
      };

      await expect(
        createSponsorshipBatch(eventId, formId, inputWithAccess),
      ).rejects.toThrow(AppError);

      await expect(
        createSponsorshipBatch(eventId, formId, inputWithAccess),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.BAD_REQUEST,
      });
    });

    it("should create multiple sponsorships for multiple beneficiaries", async () => {
      const mockEvent = createMockEvent({ id: eventId });
      const mockForm = createMockForm({ id: formId, eventId, type: "SPONSOR" });
      const mockBatch = createMockSponsorshipBatch({
        id: batchId,
        eventId,
        formId,
      });
      const mockSponsorship1 = createMockSponsorship({ eventId, batchId });
      const mockSponsorship2 = createMockSponsorship({ eventId, batchId });
      const mockPricing = createMockEventPricing({ eventId, basePrice: 300 });

      prismaMock.event.findUnique.mockResolvedValue(mockEvent);
      prismaMock.form.findFirst.mockResolvedValue(mockForm);

      let sponsorshipCount = 0;
      prismaMock.$transaction.mockImplementation(async (fn: TxCallback) => {
        const txMock = {
          sponsorshipBatch: { create: vi.fn().mockResolvedValue(mockBatch) },
          sponsorship: {
            create: vi.fn().mockImplementation(() => {
              sponsorshipCount++;
              return sponsorshipCount === 1
                ? mockSponsorship1
                : mockSponsorship2;
            }),
            findUnique: vi.fn().mockResolvedValue(null),
          },
          eventPricing: { findUnique: vi.fn().mockResolvedValue(mockPricing) },
          eventAccess: { findMany: vi.fn().mockResolvedValue([]) },
          auditLog: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(txMock);
      });

      const inputWithMultipleBeneficiaries = {
        ...validInput,
        beneficiaries: [
          {
            name: "Dr. Jane Smith",
            email: "jane@hospital.com",
            coversBasePrice: true,
            coveredAccessIds: [],
          },
          {
            name: "Dr. John Doe",
            email: "john@hospital.com",
            coversBasePrice: true,
            coveredAccessIds: [],
          },
        ],
      };

      const result = await createSponsorshipBatch(
        eventId,
        formId,
        inputWithMultipleBeneficiaries,
      );
      expect(result.count).toBe(2);
    });
  });

  describe("listSponsorships", () => {
    it("should return paginated sponsorships", async () => {
      const mockSponsorships = [
        {
          ...createMockSponsorship({ eventId }),
          batch: {
            id: batchId,
            labName: "Lab 1",
            contactName: "Contact 1",
            email: "lab1@test.com",
          },
          usages: [],
        },
        {
          ...createMockSponsorship({ eventId }),
          batch: {
            id: batchId,
            labName: "Lab 2",
            contactName: "Contact 2",
            email: "lab2@test.com",
          },
          usages: [],
        },
      ];

      prismaMock.sponsorship.findMany.mockResolvedValue(mockSponsorships);
      prismaMock.sponsorship.count.mockResolvedValue(2);

      const result = await listSponsorships(eventId, {
        page: 1,
        limit: 10,
        sortBy: "createdAt",
        sortOrder: "desc",
      });

      expect(result.data).toHaveLength(2);
      expect(result.meta.total).toBe(2);
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(10);
      expect(result.meta.totalPages).toBe(1);
    });

    it("should filter by status", async () => {
      prismaMock.sponsorship.findMany.mockResolvedValue([]);
      prismaMock.sponsorship.count.mockResolvedValue(0);

      await listSponsorships(eventId, {
        page: 1,
        limit: 10,
        status: "PENDING",
        sortBy: "createdAt",
        sortOrder: "desc",
      });

      expect(prismaMock.sponsorship.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            eventId,
            status: "PENDING",
          }),
        }),
      );
    });

    it("should search across multiple fields", async () => {
      prismaMock.sponsorship.findMany.mockResolvedValue([]);
      prismaMock.sponsorship.count.mockResolvedValue(0);

      await listSponsorships(eventId, {
        page: 1,
        limit: 10,
        search: "test",
        sortBy: "createdAt",
        sortOrder: "desc",
      });

      expect(prismaMock.sponsorship.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ code: expect.any(Object) }),
              expect.objectContaining({ beneficiaryName: expect.any(Object) }),
              expect.objectContaining({
                batch: expect.objectContaining({ labName: expect.any(Object) }),
              }),
              expect.objectContaining({
                batch: expect.objectContaining({
                  contactName: expect.any(Object),
                }),
              }),
            ]),
          }),
        }),
      );
    });

    it("should sort by different fields", async () => {
      prismaMock.sponsorship.findMany.mockResolvedValue([]);
      prismaMock.sponsorship.count.mockResolvedValue(0);

      await listSponsorships(eventId, {
        page: 1,
        limit: 10,
        sortBy: "totalAmount",
        sortOrder: "desc",
      });

      expect(prismaMock.sponsorship.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { totalAmount: "desc" },
        }),
      );
    });
  });

  describe("getSponsorshipById", () => {
    it("should return sponsorship with full details", async () => {
      const sponsorshipId = faker.string.uuid();
      const accessId = faker.string.uuid();
      const mockSponsorship = {
        ...createMockSponsorship({
          id: sponsorshipId,
          eventId,
          coveredAccessIds: [accessId],
        }),
        batch: createMockSponsorshipBatch({ eventId }),
        usages: [],
      };
      const mockAccess = createMockEventAccess({
        id: accessId,
        name: "Workshop A",
        price: 50,
      });

      prismaMock.sponsorship.findUnique.mockResolvedValue(mockSponsorship);
      prismaMock.eventAccess.findMany.mockResolvedValue([mockAccess]);

      const result = await getSponsorshipById(sponsorshipId);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(sponsorshipId);
      expect(result?.coveredAccessItems).toHaveLength(1);
      expect(result?.coveredAccessItems[0].name).toBe("Workshop A");
    });

    it("should return null when not found", async () => {
      prismaMock.sponsorship.findUnique.mockResolvedValue(null);

      const result = await getSponsorshipById("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("getSponsorshipByCode", () => {
    it("should return sponsorship with batch info", async () => {
      const code = "SP-TEST";
      const mockSponsorship = {
        ...createMockSponsorship({ eventId, code }),
        batch: {
          id: batchId,
          labName: "Test Lab",
          contactName: "Test Contact",
          email: "test@lab.com",
          phone: "+1234567890",
        },
      };

      prismaMock.sponsorship.findFirst.mockResolvedValue(mockSponsorship);

      const result = await getSponsorshipByCode(eventId, code);

      expect(result).not.toBeNull();
      expect(result?.code).toBe(code);
      expect(result?.batch.labName).toBe("Test Lab");
    });

    it("should return null when code not found", async () => {
      prismaMock.sponsorship.findFirst.mockResolvedValue(null);

      const result = await getSponsorshipByCode(eventId, "INVALID");

      expect(result).toBeNull();
    });
  });

  describe("updateSponsorship", () => {
    it("should update beneficiary info", async () => {
      const sponsorshipId = faker.string.uuid();
      const mockSponsorship = {
        ...createMockSponsorship({ id: sponsorshipId, eventId }),
        usages: [],
      };
      const updatedSponsorship = {
        ...mockSponsorship,
        beneficiaryName: "New Name",
        batch: createMockSponsorshipBatch({ eventId }),
        usages: [],
      };

      // First call: initial findUnique for update check
      // Second call: getSponsorshipById at the end
      prismaMock.sponsorship.findUnique
        .mockResolvedValueOnce(mockSponsorship)
        .mockResolvedValueOnce(updatedSponsorship);
      prismaMock.sponsorship.update.mockResolvedValue(updatedSponsorship);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await updateSponsorship(sponsorshipId, {
        beneficiaryName: "New Name",
      });

      expect(result.beneficiaryName).toBe("New Name");
    });

    it("should recalculate total when coverage changes", async () => {
      const sponsorshipId = faker.string.uuid();
      const accessId = faker.string.uuid();
      const mockSponsorship = {
        ...createMockSponsorship({
          id: sponsorshipId,
          eventId,
          coversBasePrice: true,
        }),
        usages: [],
      };
      const mockPricing = createMockEventPricing({ eventId, basePrice: 200 });
      const mockAccess = createMockEventAccess({ id: accessId, price: 50 });

      prismaMock.sponsorship.findUnique
        .mockResolvedValueOnce(asMock(mockSponsorship))
        .mockResolvedValueOnce(
          asMock({
            ...mockSponsorship,
            coveredAccessIds: [accessId],
            batch: createMockSponsorshipBatch({ eventId }),
            usages: [],
          }),
        );
      prismaMock.eventPricing.findUnique.mockResolvedValue(mockPricing);
      prismaMock.eventAccess.findMany.mockResolvedValue([mockAccess]);

      const updateMock = vi.fn().mockResolvedValue({
        ...mockSponsorship,
        coveredAccessIds: [accessId],
      });

      prismaMock.$transaction.mockImplementation(async (fn: TxCallback) => {
        const txMock = {
          sponsorship: {
            update: updateMock,
          },
          auditLog: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(txMock);
      });

      await updateSponsorship(sponsorshipId, { coveredAccessIds: [accessId] });

      expect(updateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            totalAmount: expect.any(Number),
          }),
        }),
      );
    });

    it("should throw when sponsorship not found", async () => {
      prismaMock.sponsorship.findUnique.mockResolvedValue(null);

      await expect(
        updateSponsorship("non-existent", { beneficiaryName: "Test" }),
      ).rejects.toThrow(AppError);
    });

    it("should delegate to cancelSponsorship when status is CANCELLED", async () => {
      const sponsorshipId = faker.string.uuid();
      const mockSponsorship = {
        ...createMockSponsorship({ id: sponsorshipId, eventId }),
        usages: [],
      };
      const cancelledSponsorship = {
        ...mockSponsorship,
        status: "CANCELLED",
        batch: createMockSponsorshipBatch({ eventId }),
        usages: [],
      };

      // First call: initial findUnique for update check
      // Second call: cancelSponsorship internal check
      // Third call: getSponsorshipById at the end of cancelSponsorship
      prismaMock.sponsorship.findUnique
        .mockResolvedValueOnce(asMock(mockSponsorship))
        .mockResolvedValueOnce(asMock(mockSponsorship))
        .mockResolvedValueOnce(asMock(cancelledSponsorship));
      prismaMock.$transaction.mockImplementation(async (fn: TxCallback) => {
        const txMock = {
          sponsorship: {
            update: vi.fn().mockResolvedValue(cancelledSponsorship),
          },
          auditLog: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(txMock);
      });
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await updateSponsorship(sponsorshipId, {
        status: "CANCELLED",
      });

      expect(result.status).toBe("CANCELLED");
    });
  });

  describe("cancelSponsorship", () => {
    it("should cancel sponsorship without usages", async () => {
      const sponsorshipId = faker.string.uuid();
      const mockSponsorship = {
        ...createMockSponsorship({ id: sponsorshipId, eventId }),
        usages: [],
      };

      prismaMock.sponsorship.findUnique
        .mockResolvedValueOnce(asMock(mockSponsorship))
        .mockResolvedValueOnce(
          asMock({
            ...mockSponsorship,
            status: "CANCELLED",
            batch: createMockSponsorshipBatch({ eventId }),
            usages: [],
          }),
        );
      prismaMock.$transaction.mockImplementation(async (fn: TxCallback) => {
        const txMock = {
          sponsorship: {
            update: vi
              .fn()
              .mockResolvedValue({ ...mockSponsorship, status: "CANCELLED" }),
          },
          auditLog: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(txMock);
      });
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await cancelSponsorship(sponsorshipId);

      expect(result.status).toBe("CANCELLED");
    });

    it("should unlink from registrations when cancelling", async () => {
      const sponsorshipId = faker.string.uuid();
      const registrationId = faker.string.uuid();
      const mockSponsorship = {
        ...createMockSponsorship({ id: sponsorshipId, eventId }),
        usages: [{ registrationId }],
      };

      prismaMock.sponsorship.findUnique
        .mockResolvedValueOnce(asMock(mockSponsorship))
        .mockResolvedValueOnce(
          asMock({
            ...mockSponsorship,
            status: "CANCELLED",
            batch: createMockSponsorshipBatch({ eventId }),
            usages: [],
          }),
        );

      const mockTxFns = {
        sponsorshipUsage: {
          findUnique: vi.fn().mockResolvedValue({
            id: faker.string.uuid(),
            sponsorshipId,
            registrationId,
            amountApplied: 100,
          }),
          delete: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          count: vi.fn().mockResolvedValue(0),
        },
        registration: {
          update: vi.fn().mockResolvedValue({}),
          findUnique: vi.fn().mockResolvedValue({ totalAmount: 500 }),
        },
        sponsorship: {
          findUnique: vi.fn().mockResolvedValue({ status: "USED" }),
          update: vi
            .fn()
            .mockResolvedValue({ ...mockSponsorship, status: "CANCELLED" }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
      };

      prismaMock.$transaction.mockImplementation(async (fn: TxCallback) =>
        fn(mockTxFns),
      );
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await cancelSponsorship(sponsorshipId);

      expect(mockTxFns.sponsorshipUsage.delete).toHaveBeenCalled();
      expect(result.status).toBe("CANCELLED");
    });

    it("should throw when sponsorship not found", async () => {
      prismaMock.sponsorship.findUnique.mockResolvedValue(null);

      await expect(cancelSponsorship("non-existent")).rejects.toThrow(AppError);
    });
  });

  describe("deleteSponsorship", () => {
    it("should delete sponsorship without usages", async () => {
      const sponsorshipId = faker.string.uuid();
      const mockSponsorship = {
        ...createMockSponsorship({ id: sponsorshipId, eventId }),
        usages: [],
      };

      prismaMock.sponsorship.findUnique.mockResolvedValue(mockSponsorship);
      prismaMock.$transaction.mockImplementation(async (fn: TxCallback) => {
        const txMock = {
          sponsorship: { delete: vi.fn().mockResolvedValue({}) },
          auditLog: { create: vi.fn().mockResolvedValue({}) },
        };
        return fn(txMock);
      });

      await expect(deleteSponsorship(sponsorshipId)).resolves.toBeUndefined();
    });

    it("should unlink and delete sponsorship with usages", async () => {
      const sponsorshipId = faker.string.uuid();
      const registrationId = faker.string.uuid();
      const mockSponsorship = {
        ...createMockSponsorship({ id: sponsorshipId, eventId }),
        usages: [{ registrationId }],
      };

      prismaMock.sponsorship.findUnique.mockResolvedValue(mockSponsorship);

      const mockTxFns = {
        sponsorshipUsage: {
          findUnique: vi.fn().mockResolvedValue({
            id: faker.string.uuid(),
            sponsorshipId,
            registrationId,
            amountApplied: 100,
          }),
          delete: vi.fn().mockResolvedValue({}),
          findMany: vi.fn().mockResolvedValue([]),
          count: vi.fn().mockResolvedValue(0),
        },
        registration: {
          update: vi.fn().mockResolvedValue({}),
          findUnique: vi.fn().mockResolvedValue({ totalAmount: 500 }),
        },
        sponsorship: {
          findUnique: vi.fn().mockResolvedValue({ status: "USED" }),
          update: vi.fn().mockResolvedValue({}),
          delete: vi.fn().mockResolvedValue({}),
        },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
      };

      prismaMock.$transaction.mockImplementation(async (fn: TxCallback) =>
        fn(mockTxFns),
      );

      await deleteSponsorship(sponsorshipId);

      expect(mockTxFns.sponsorshipUsage.delete).toHaveBeenCalled();
      expect(mockTxFns.sponsorship.delete).toHaveBeenCalled();
    });

    it("should throw when sponsorship not found", async () => {
      prismaMock.sponsorship.findUnique.mockResolvedValue(null);

      await expect(deleteSponsorship("non-existent")).rejects.toThrow(AppError);
    });
  });

  describe("getSponsorshipClientId", () => {
    it("should return client ID for sponsorship", async () => {
      const clientId = faker.string.uuid();
      const sponsorshipId = faker.string.uuid();

      prismaMock.sponsorship.findUnique.mockResolvedValue(
        asMock({
          id: sponsorshipId,
          event: { clientId },
        }),
      );

      const result = await getSponsorshipClientId(sponsorshipId);

      expect(result).toBe(clientId);
    });

    it("should return null when sponsorship not found", async () => {
      prismaMock.sponsorship.findUnique.mockResolvedValue(null);

      const result = await getSponsorshipClientId("non-existent");

      expect(result).toBeNull();
    });
  });
});

// ============================================================================
// getSponsorshipStats
// ============================================================================

describe("getSponsorshipStats", () => {
  const eventId = faker.string.uuid();

  it("returns all-zero stats for empty event with TND default currency", async () => {
    prismaMock.eventPricing.findUnique.mockResolvedValue(null);
    mockGroupBy.mockResolvedValue([] as never);

    const result = await getSponsorshipStats(eventId);

    expect(result).toMatchObject({
      total: 0,
      totalAmount: 0,
      pending: { count: 0, amount: 0 },
      used: { count: 0, amount: 0 },
      cancelled: { count: 0, amount: 0 },
      currency: "TND",
    });
  });

  it("reads currency from eventPricing", async () => {
    const pricing = createMockEventPricing({ eventId, currency: "EUR" });
    prismaMock.eventPricing.findUnique.mockResolvedValue(pricing);
    mockGroupBy.mockResolvedValue([] as never);

    const result = await getSponsorshipStats(eventId);

    expect(result.currency).toBe("EUR");
  });

  it("defaults to TND when no pricing configured", async () => {
    prismaMock.eventPricing.findUnique.mockResolvedValue(null);
    mockGroupBy.mockResolvedValue([] as never);

    const result = await getSponsorshipStats(eventId);

    expect(result.currency).toBe("TND");
  });

  it("aggregates PENDING, USED, and CANCELLED counts and amounts", async () => {
    const pricing = createMockEventPricing({ eventId, currency: "TND" });
    prismaMock.eventPricing.findUnique.mockResolvedValue(pricing);

    mockGroupBy.mockResolvedValue([
      { status: "PENDING", _count: 5, _sum: { totalAmount: 1500 } },
      { status: "USED", _count: 10, _sum: { totalAmount: 3000 } },
      { status: "CANCELLED", _count: 2, _sum: { totalAmount: 600 } },
    ] as never);

    const result = await getSponsorshipStats(eventId);

    expect(result.total).toBe(17); // 5 + 10 + 2
    expect(result.totalAmount).toBe(5100); // 1500 + 3000 + 600
    expect(result.pending).toEqual({ count: 5, amount: 1500 });
    expect(result.used).toEqual({ count: 10, amount: 3000 });
    expect(result.cancelled).toEqual({ count: 2, amount: 600 });
  });

  it("handles partial grouping (only USED exists)", async () => {
    const pricing = createMockEventPricing({ eventId, currency: "TND" });
    prismaMock.eventPricing.findUnique.mockResolvedValue(pricing);

    mockGroupBy.mockResolvedValue([
      { status: "USED", _count: 3, _sum: { totalAmount: 900 } },
    ] as never);

    const result = await getSponsorshipStats(eventId);

    expect(result.total).toBe(3);
    expect(result.totalAmount).toBe(900);
    expect(result.pending).toEqual({ count: 0, amount: 0 });
    expect(result.used).toEqual({ count: 3, amount: 900 });
    expect(result.cancelled).toEqual({ count: 0, amount: 0 });
  });

  it("handles null totalAmount sum (no amounts set)", async () => {
    prismaMock.eventPricing.findUnique.mockResolvedValue(null);

    mockGroupBy.mockResolvedValue([
      { status: "PENDING", _count: 2, _sum: { totalAmount: null } },
    ] as never);

    const result = await getSponsorshipStats(eventId);

    expect(result.totalAmount).toBe(0); // null coerced to 0
    expect(result.pending.amount).toBe(0);
  });
});
