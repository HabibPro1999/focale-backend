import { describe, it, expect, beforeEach } from "vitest";
import { prismaMock, asGroupByMock } from "../../../tests/mocks/prisma.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import {
  getFinancialReport,
  getEventAnalytics,
  exportRegistrations,
} from "./reports.service.js";

// Prisma's `groupBy` overload signature blocks vitest-mock-extended from
// exposing the standard Mock surface. asGroupByMock centralizes the necessary
// type assertion in `tests/mocks/prisma.ts`.
const registrationGroupBy = asGroupByMock(prismaMock.registration.groupBy);
const sponsorshipGroupBy = asGroupByMock(prismaMock.sponsorship.groupBy);

// ============================================================================
// getFinancialReport
// ============================================================================

describe("getFinancialReport", () => {
  const eventId = "evt-001";

  beforeEach(() => {
    // Default stubs for all parallel queries inside getFinancialReport.
    registrationGroupBy.mockResolvedValue([]);
    prismaMock.registration.aggregate.mockResolvedValue({
      _sum: {
        totalAmount: 0,
        paidAmount: 0,
        baseAmount: 0,
        accessAmount: 0,
        discountAmount: 0,
        sponsorshipAmount: 0,
      },
      _avg: { totalAmount: 0 },
      _count: 0,
      _min: {},
      _max: {},
    } as never);
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.eventAccess.findMany.mockResolvedValue([]);
  });

  it("should return a report with empty results when no registrations exist", async () => {
    const result = await getFinancialReport(eventId, {});

    expect(result.eventId).toBe(eventId);
    expect(result.generatedAt).toBeDefined();
    expect(result.dateRange).toEqual({ startDate: null, endDate: null });
    expect(result.summary.registrationCount).toBe(0);
    expect(result.summary.totalRevenue).toBe(0);
    expect(result.summary.currencies).toEqual([]);
    expect(result.byPaymentStatus).toEqual([]);
    expect(result.byAccessType).toEqual([]);
    expect(result.dailyTrend).toEqual([]);
  });

  it("should pass date range filters into the where clause", async () => {
    const startDate = "2025-01-01T00:00:00.000Z";
    const endDate = "2025-01-31T23:59:59.000Z";

    await getFinancialReport(eventId, { startDate, endDate });

    // The first groupBy call (byCurrency) should contain date filters.
    const firstCall = registrationGroupBy.mock.calls[0];
    const where = (firstCall[0] as { where: Record<string, unknown> }).where;
    expect(where.eventId).toBe(eventId);
    expect(where.submittedAt).toEqual({
      gte: new Date(startDate),
      lte: new Date(endDate),
    });
  });

  it("should build correct currency summaries from grouped data", async () => {
    // Promise.all interleaves groupBy calls:
    //   call 1: getFinancialSummary -> byCurrency
    //   call 2: getPaymentStatusBreakdown -> paymentStatus (starts concurrently)
    //   call 3: getFinancialSummary -> pendingByCurrency
    //   call 4: getFinancialSummary -> refundedByCurrency
    registrationGroupBy
      .mockResolvedValueOnce([
        {
          currency: "TND",
          _sum: {
            totalAmount: 1000,
            paidAmount: 800,
            baseAmount: 600,
            accessAmount: 200,
            discountAmount: 50,
            sponsorshipAmount: 100,
          },
          _count: 5,
        },
      ] as never)
      .mockResolvedValueOnce([
        { paymentStatus: "PAID", _count: 3, _sum: { totalAmount: 600 } },
      ] as never)
      .mockResolvedValueOnce([
        {
          currency: "TND",
          _sum: { totalAmount: 300, paidAmount: 100 },
        },
      ] as never)
      .mockResolvedValueOnce([
        {
          currency: "TND",
          _sum: { totalAmount: 50 },
        },
      ] as never);

    prismaMock.registration.aggregate.mockResolvedValue({
      _sum: {
        totalAmount: 1000,
        paidAmount: 800,
        baseAmount: 600,
        accessAmount: 200,
        discountAmount: 50,
        sponsorshipAmount: 100,
      },
      _avg: { totalAmount: 200 },
      _count: 5,
      _min: {},
      _max: {},
    } as never);

    const result = await getFinancialReport(eventId, {});

    expect(result.summary.totalRevenue).toBe(800);
    expect(result.summary.registrationCount).toBe(5);
    expect(result.summary.averageRegistrationValue).toBe(200);
    expect(result.summary.primaryCurrency).toBe("TND");
    expect(result.summary.currencies).toHaveLength(1);
    expect(result.summary.currencies[0]).toMatchObject({
      currency: "TND",
      totalRevenue: 800,
      totalPending: 200, // totalAmount(300) - paidAmount(100)
      totalRefunded: 50,
      registrationCount: 5,
    });
  });

  it("should default primaryCurrency to TND when there are no registrations", async () => {
    const result = await getFinancialReport(eventId, {});
    expect(result.summary.primaryCurrency).toBe("TND");
  });

  it("should map payment status breakdown correctly", async () => {
    // call 1: byCurrency, call 2: paymentStatus, call 3: pending, call 4: refunded
    registrationGroupBy
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        { paymentStatus: "PAID", _count: 10, _sum: { totalAmount: 5000 } },
        { paymentStatus: "PENDING", _count: 3, _sum: { totalAmount: 900 } },
      ] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    const result = await getFinancialReport(eventId, {});

    expect(result.byPaymentStatus).toEqual([
      { paymentStatus: "PAID", count: 10, totalAmount: 5000 },
      { paymentStatus: "PENDING", count: 3, totalAmount: 900 },
    ]);
  });

  it("should map daily trend from raw query results", async () => {
    const mockDate = new Date("2025-03-15");
    // First $queryRaw = getAccessBreakdown, second = getDailyTrend
    prismaMock.$queryRaw
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        { date: mockDate, count: BigInt(4), total_amount: BigInt(2000) },
      ] as never);

    const result = await getFinancialReport(eventId, {});

    expect(result.dailyTrend).toEqual([
      { date: "2025-03-15", count: 4, totalAmount: 2000 },
    ]);
  });
});

// ============================================================================
// getEventAnalytics
// ============================================================================

describe("getEventAnalytics", () => {
  const eventId = "evt-002";

  beforeEach(() => {
    registrationGroupBy.mockResolvedValue([]);
    prismaMock.eventAccess.findMany.mockResolvedValue([]);
    sponsorshipGroupBy.mockResolvedValue([]);
  });

  it("should return zeroed analytics when no data exists", async () => {
    const result = await getEventAnalytics(eventId);

    expect(result.eventId).toBe(eventId);
    expect(result.registrations.total).toBe(0);
    expect(result.payments).toEqual({
      paid: 0,
      verifying: 0,
      pending: 0,
      partial: 0,
      sponsored: 0,
      waived: 0,
      refunded: 0,
    });
    expect(result.paymentMethods).toEqual({
      bankTransfer: 0,
      online: 0,
      cash: 0,
      labSponsorship: 0,
      unset: 0,
    });
    expect(result.accessItems).toEqual([]);
    expect(result.sponsorships.total).toBe(0);
  });

  it("should aggregate payment statuses from grouped data", async () => {
    registrationGroupBy
      .mockResolvedValueOnce([
        { paymentStatus: "PAID", _count: 10 },
        { paymentStatus: "PENDING", _count: 5 },
        { paymentStatus: "SPONSORED", _count: 2 },
      ] as never)
      .mockResolvedValueOnce([
        { paymentMethod: "BANK_TRANSFER", _count: 8 },
        { paymentMethod: null, _count: 9 },
      ] as never);

    const result = await getEventAnalytics(eventId);

    expect(result.registrations.total).toBe(17);
    expect(result.payments.paid).toBe(10);
    expect(result.payments.pending).toBe(5);
    expect(result.payments.sponsored).toBe(2);
    expect(result.payments.verifying).toBe(0);
    expect(result.paymentMethods.bankTransfer).toBe(8);
    expect(result.paymentMethods.unset).toBe(9);
  });

  it("should compute fillPercentage for access items with capacity", async () => {
    prismaMock.eventAccess.findMany.mockResolvedValue([
      {
        id: "acc-1",
        name: "VIP",
        type: "WORKSHOP",
        registeredCount: 75,
        maxCapacity: 100,
      },
      {
        id: "acc-2",
        name: "General",
        type: "CONFERENCE",
        registeredCount: 50,
        maxCapacity: null,
      },
    ] as never);

    const result = await getEventAnalytics(eventId);

    expect(result.accessItems).toHaveLength(2);
    expect(result.accessItems[0]).toMatchObject({
      id: "acc-1",
      name: "VIP",
      fillPercentage: 75,
    });
    expect(result.accessItems[1]).toMatchObject({
      id: "acc-2",
      name: "General",
      fillPercentage: null,
    });
  });

  it("should return fillPercentage null when maxCapacity is zero", async () => {
    prismaMock.eventAccess.findMany.mockResolvedValue([
      {
        id: "acc-3",
        name: "Free",
        type: "OTHER",
        registeredCount: 10,
        maxCapacity: 0,
      },
    ] as never);

    const result = await getEventAnalytics(eventId);

    expect(result.accessItems[0].fillPercentage).toBeNull();
  });

  it("should aggregate sponsorship statuses", async () => {
    sponsorshipGroupBy.mockResolvedValue([
      { status: "APPROVED", _count: 3 },
      { status: "PENDING", _count: 7 },
    ] as never);

    const result = await getEventAnalytics(eventId);

    expect(result.sponsorships.total).toBe(10);
    expect(result.sponsorships.byStatus).toEqual([
      { status: "APPROVED", count: 3 },
      { status: "PENDING", count: 7 },
    ]);
  });
});

// ============================================================================
// exportRegistrations
// ============================================================================

describe("exportRegistrations", () => {
  const eventId = "evt-003";

  it("should throw 404 when event does not exist", async () => {
    prismaMock.event.findUnique.mockResolvedValue(null);

    await expect(
      exportRegistrations(eventId, { format: "csv" }),
    ).rejects.toThrow(AppError);
    await expect(
      exportRegistrations(eventId, { format: "csv" }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: ErrorCodes.NOT_FOUND,
    });
  });

  it("should export as JSON when format is json", async () => {
    prismaMock.event.findUnique.mockResolvedValue({
      slug: "my-event",
    } as never);
    prismaMock.registration.findMany.mockResolvedValue([]);

    const result = await exportRegistrations(eventId, { format: "json" });

    expect(result.filename).toMatch(/^my-event-registrations-.*\.json$/);
    expect(result.contentType).toBe("application/json");
    expect(JSON.parse(result.data as string)).toEqual([]);
  });

  it("should export CSV with correct headers and data", async () => {
    prismaMock.event.findUnique.mockResolvedValue({
      slug: "test-event",
    } as never);

    const mockRegistration = {
      id: "reg-1",
      email: "test@example.com",
      firstName: "John",
      lastName: "Doe",
      phone: "+216555",
      paymentStatus: "PAID",
      paymentMethod: "CASH",
      totalAmount: 500,
      paidAmount: 500,
      baseAmount: 400,
      accessAmount: 100,
      discountAmount: 0,
      sponsorshipCode: null,
      sponsorshipAmount: 0,
      submittedAt: new Date("2025-06-01T10:00:00Z"),
      paidAt: new Date("2025-06-01T12:00:00Z"),
      formData: { company: "Acme" },
    };
    prismaMock.registration.findMany.mockResolvedValue([
      mockRegistration,
    ] as never);

    const result = await exportRegistrations(eventId, { format: "csv" });

    expect(result.filename).toMatch(/^test-event-registrations-.*\.csv$/);
    expect(result.contentType).toBe("text/csv");

    const lines = (result.data as string).split("\n");
    expect(lines[0]).toContain("ID");
    expect(lines[0]).toContain("Email");
    expect(lines[0]).toContain("company");
    expect(lines[1]).toContain("reg-1");
    expect(lines[1]).toContain("test@example.com");
    expect(lines[1]).toContain("Acme");
  });

  it("should include multiple dynamic formData keys across registrations", async () => {
    prismaMock.event.findUnique.mockResolvedValue({
      slug: "evt",
    } as never);
    prismaMock.registration.findMany.mockResolvedValue([
      {
        id: "r-1",
        email: "a@b.com",
        firstName: null,
        lastName: null,
        phone: null,
        paymentStatus: "PAID",
        paymentMethod: null,
        totalAmount: 0,
        paidAmount: 0,
        baseAmount: 0,
        accessAmount: 0,
        discountAmount: 0,
        sponsorshipCode: null,
        sponsorshipAmount: 0,
        submittedAt: new Date(),
        paidAt: null,
        formData: { city: "Tunis" },
      },
      {
        id: "r-2",
        email: "c@d.com",
        firstName: null,
        lastName: null,
        phone: null,
        paymentStatus: "PENDING",
        paymentMethod: null,
        totalAmount: 0,
        paidAmount: 0,
        baseAmount: 0,
        accessAmount: 0,
        discountAmount: 0,
        sponsorshipCode: null,
        sponsorshipAmount: 0,
        submittedAt: new Date(),
        paidAt: null,
        formData: { specialty: "Cardiology" },
      },
    ] as never);

    const result = await exportRegistrations(eventId, { format: "csv" });
    const header = (result.data as string).split("\n")[0];

    // Both dynamic keys should appear in the header (sorted alphabetically)
    expect(header).toContain("city");
    expect(header).toContain("specialty");
  });

  it("should apply date range filters to the registration query", async () => {
    prismaMock.event.findUnique.mockResolvedValue({
      slug: "evt",
    } as never);
    prismaMock.registration.findMany.mockResolvedValue([]);

    await exportRegistrations(eventId, {
      format: "csv",
      startDate: "2025-01-01T00:00:00.000Z",
      endDate: "2025-01-31T23:59:59.000Z",
    });

    const call = prismaMock.registration.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(call.where.eventId).toBe(eventId);
    expect(call.where.submittedAt).toEqual({
      gte: new Date("2025-01-01T00:00:00.000Z"),
      lte: new Date("2025-01-31T23:59:59.000Z"),
    });
  });
});
