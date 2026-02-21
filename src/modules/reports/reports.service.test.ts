import { describe, it, expect, vi, type Mock } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { getFinancialReport, exportRegistrations } from "./reports.service.js";

vi.mock("@shared/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// groupBy is an overloaded method — cast to access mock helpers
const groupByMock = prismaMock.registration.groupBy as unknown as Mock;

// Helper: build a minimal groupBy row for registration (by currency)
function makeGroupByCurrency(
  currency: string,
  opts: {
    count?: number;
    totalAmount?: number;
    paidAmount?: number;
    baseAmount?: number;
    accessAmount?: number;
    discountAmount?: number;
    sponsorshipAmount?: number;
  } = {},
) {
  return {
    currency,
    _count: opts.count ?? 0,
    _sum: {
      totalAmount: opts.totalAmount ?? 0,
      paidAmount: opts.paidAmount ?? 0,
      baseAmount: opts.baseAmount ?? 0,
      accessAmount: opts.accessAmount ?? 0,
      discountAmount: opts.discountAmount ?? 0,
      sponsorshipAmount: opts.sponsorshipAmount ?? 0,
    },
  };
}

// Helper: build a paymentStatus groupBy row
function makeGroupByStatus(status: string, count: number, totalAmount: number) {
  return {
    paymentStatus: status,
    _count: count,
    _sum: { totalAmount },
  };
}

// Helper: mock all groupBy calls for an empty event (all return [])
function mockEmptyGroupBys() {
  // getFinancialSummary: 4 groupBy calls (byCurrency, pending, refunded, waived)
  groupByMock
    .mockResolvedValueOnce([]) // byCurrency
    .mockResolvedValueOnce([]) // pendingByCurrency
    .mockResolvedValueOnce([]) // refundedByCurrency
    .mockResolvedValueOnce([]) // waivedByCurrency
    // getPaymentStatusBreakdown: 1 call
    .mockResolvedValueOnce([]);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Reports Service", () => {
  // ─── getFinancialReport ──────────────────────────────────────────────────
  describe("getFinancialReport", () => {
    it("returns all-zero summary with TND default for empty event", async () => {
      const eventId = "evt-001";

      mockEmptyGroupBys();
      // getAccessBreakdown: $queryRaw returns empty → early return (no findMany)
      prismaMock.$queryRaw.mockResolvedValueOnce([]);
      // getDailyTrend: $queryRaw returns empty
      prismaMock.$queryRaw.mockResolvedValueOnce([]);

      const result = await getFinancialReport(eventId, {});

      expect(result.eventId).toBe(eventId);
      expect(result.summary.totalRevenue).toBe(0);
      expect(result.summary.totalPending).toBe(0);
      expect(result.summary.totalRefunded).toBe(0);
      expect(result.summary.totalWaived).toBe(0);
      expect(result.summary.registrationCount).toBe(0);
      expect(result.summary.averageRegistrationValue).toBe(0);
      expect(result.summary.primaryCurrency).toBe("TND");
      expect(result.summary.currencies).toEqual([]);
      expect(result.byPaymentStatus).toEqual([]);
      expect(result.byAccessType).toEqual([]);
      expect(result.dailyTrend).toEqual([]);
    });

    it("aggregates single-currency registrations correctly", async () => {
      const eventId = "evt-002";

      // byCurrency: 3 registrations in TND, 800 paid of 1000 total
      groupByMock
        .mockResolvedValueOnce([
          makeGroupByCurrency("TND", {
            count: 3,
            totalAmount: 1000,
            paidAmount: 800,
            baseAmount: 900,
            accessAmount: 100,
            discountAmount: 50,
            sponsorshipAmount: 150,
          }),
        ])
        // pendingByCurrency: 200 pending (totalAmount - paidAmount)
        .mockResolvedValueOnce([
          { currency: "TND", _sum: { totalAmount: 200, paidAmount: 0 } },
        ])
        // refundedByCurrency
        .mockResolvedValueOnce([])
        // waivedByCurrency
        .mockResolvedValueOnce([
          {
            currency: "TND",
            _count: 1,
            _sum: { totalAmount: 100 },
          },
        ])
        // paymentStatus breakdown
        .mockResolvedValueOnce([
          makeGroupByStatus("PAID", 2, 800),
          makeGroupByStatus("PENDING", 1, 200),
        ]);

      prismaMock.$queryRaw
        .mockResolvedValueOnce([]) // access breakdown: empty
        .mockResolvedValueOnce([]); // daily trend: empty

      const result = await getFinancialReport(eventId, {});

      expect(result.summary.primaryCurrency).toBe("TND");
      expect(result.summary.registrationCount).toBe(3);
      expect(result.summary.totalRevenue).toBe(800); // paidAmount
      expect(result.summary.totalPending).toBe(200); // totalAmount - paidAmount
      expect(result.summary.totalWaived).toBe(100);
      expect(result.summary.waivedCount).toBe(1);
      expect(result.summary.baseRevenue).toBe(900);
      expect(result.summary.accessRevenue).toBe(100);
      expect(result.summary.discountsGiven).toBe(50);
      expect(result.summary.sponsorshipsApplied).toBe(150);
      expect(result.byPaymentStatus).toHaveLength(2);
      expect(result.byPaymentStatus[0]).toMatchObject({
        paymentStatus: "PAID",
        count: 2,
        totalAmount: 800,
      });
    });

    it("includes dateRange in response", async () => {
      const eventId = "evt-003";

      mockEmptyGroupBys();
      prismaMock.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await getFinancialReport(eventId, {
        startDate: "2024-01-01",
        endDate: "2024-12-31",
      });

      expect(result.dateRange.startDate).toBe(
        new Date("2024-01-01").toISOString(),
      );
      expect(result.dateRange.endDate).toBe(
        new Date("2024-12-31").toISOString(),
      );
    });

    it("picks the currency with the highest registration count as primary", async () => {
      const eventId = "evt-004";

      groupByMock
        .mockResolvedValueOnce([
          makeGroupByCurrency("TND", { count: 10 }),
          makeGroupByCurrency("EUR", { count: 20 }), // EUR has more → primary
        ])
        .mockResolvedValueOnce([]) // pending
        .mockResolvedValueOnce([]) // refunded
        .mockResolvedValueOnce([]) // waived
        .mockResolvedValueOnce([]); // payment status

      prismaMock.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await getFinancialReport(eventId, {});

      expect(result.summary.primaryCurrency).toBe("EUR");
    });
  });

  // ─── exportRegistrations ─────────────────────────────────────────────────
  describe("exportRegistrations", () => {
    const eventId = "evt-export";
    const eventSlug = "my-conference";

    // A minimal registration for CSV export
    function makeRegistration(overrides: Record<string, unknown> = {}) {
      return {
        id: "reg-001",
        email: "user@example.com",
        firstName: "Alice",
        lastName: "Smith",
        phone: "+1234567890",
        paymentStatus: "PAID",
        paymentMethod: "CASH",
        totalAmount: 500,
        paidAmount: 500,
        baseAmount: 400,
        accessAmount: 100,
        discountAmount: 0,
        sponsorshipCode: null,
        sponsorshipAmount: 0,
        submittedAt: new Date("2024-06-01T10:00:00Z"),
        paidAt: new Date("2024-06-01T11:00:00Z"),
        formData: {},
        accessTypeIds: [],
        priceBreakdown: {},
        currency: "TND",
        ...overrides,
      };
    }

    it("returns CSV with static headers and metadata", async () => {
      prismaMock.form.findFirst.mockResolvedValue(null);
      prismaMock.registration.findMany.mockResolvedValue([
        makeRegistration() as never,
      ]);
      prismaMock.registration.count.mockResolvedValue(1);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await exportRegistrations(eventId, eventSlug, {
        format: "csv",
        limit: 1000,
      });

      expect(result.contentType).toBe("text/csv");
      expect(result.filename).toMatch(/\.csv$/);
      expect(result.data).toContain("ID,Email,First Name,Last Name");
      expect(result.data).toContain("Access Types");
      expect(result.metadata).toMatchObject({
        total: 1,
        exported: 1,
        truncated: false,
      });
    });

    it("returns JSON format when requested", async () => {
      prismaMock.form.findFirst.mockResolvedValue(null);
      prismaMock.registration.findMany.mockResolvedValue([
        makeRegistration() as never,
      ]);
      prismaMock.registration.count.mockResolvedValue(1);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await exportRegistrations(eventId, eventSlug, {
        format: "json",
        limit: 1000,
      });

      expect(result.contentType).toBe("application/json");
      expect(result.filename).toMatch(/\.json$/);
      const parsed = JSON.parse(result.data);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
    });

    it("marks truncated=true when exported < total", async () => {
      prismaMock.form.findFirst.mockResolvedValue(null);
      prismaMock.registration.findMany.mockResolvedValue([
        makeRegistration() as never,
      ]);
      prismaMock.registration.count.mockResolvedValue(500); // total > exported
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await exportRegistrations(eventId, eventSlug, {
        format: "csv",
        limit: 1,
      });

      expect(result.metadata).toMatchObject({
        total: 500,
        exported: 1,
        truncated: true,
      });
    });

    it("includes form field values in CSV rows", async () => {
      const formSchema = {
        steps: [
          {
            fields: [
              { id: "specialty", label: "Specialty", type: "text" },
              { id: "country", label: "Country", type: "select" },
            ],
          },
        ],
      };
      prismaMock.form.findFirst.mockResolvedValue({
        schema: formSchema,
      } as never);
      prismaMock.registration.findMany.mockResolvedValue([
        makeRegistration({
          formData: { specialty: "Cardiology", country: "Tunisia" },
        }) as never,
      ]);
      prismaMock.registration.count.mockResolvedValue(1);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await exportRegistrations(eventId, eventSlug, {
        format: "csv",
        limit: 1000,
      });

      expect(result.data).toContain("Specialty");
      expect(result.data).toContain("Country");
      expect(result.data).toContain("Cardiology");
      expect(result.data).toContain("Tunisia");
    });

    it("resolves access type IDs to names in CSV", async () => {
      const accessId = "access-vip";
      prismaMock.form.findFirst.mockResolvedValue(null);
      prismaMock.registration.findMany.mockResolvedValue([
        makeRegistration({ accessTypeIds: [accessId] }) as never,
      ]);
      prismaMock.registration.count.mockResolvedValue(1);
      prismaMock.eventAccess.findMany.mockResolvedValue([
        { id: accessId, name: "VIP Pass" } as never,
      ]);

      const result = await exportRegistrations(eventId, eventSlug, {
        format: "csv",
        limit: 1000,
      });

      expect(result.data).toContain("VIP Pass");
    });

    // ─── CSV formula injection defense ─────────────────────────────────────
    describe("CSV formula injection defense", () => {
      const dangerousChars = [
        ["=SUM(A1)", "'=SUM(A1)"],
        ["+1234", "'+1234"],
        ["-1234", "'-1234"],
        ["@SUM", "'@SUM"],
        ["\t TAB", "'\t TAB"],
        ["\r RETURN", "'\r RETURN"],
      ];

      it.each(dangerousChars)(
        "prefixes %s with apostrophe in CSV output",
        async (dangerous, expected) => {
          prismaMock.form.findFirst.mockResolvedValue({
            schema: {
              steps: [
                { fields: [{ id: "field1", label: "Field1", type: "text" }] },
              ],
            },
          } as never);
          prismaMock.registration.findMany.mockResolvedValue([
            makeRegistration({ formData: { field1: dangerous } }) as never,
          ]);
          prismaMock.registration.count.mockResolvedValue(1);
          prismaMock.eventAccess.findMany.mockResolvedValue([]);

          const result = await exportRegistrations(eventId, eventSlug, {
            format: "csv",
            limit: 1000,
          });

          expect(result.data).toContain(expected);
        },
      );
    });

    // ─── CSV escaping ───────────────────────────────────────────────────────
    describe("CSV escaping", () => {
      it("wraps value with comma in double quotes", async () => {
        prismaMock.form.findFirst.mockResolvedValue({
          schema: {
            steps: [{ fields: [{ id: "f1", label: "Field", type: "text" }] }],
          },
        } as never);
        prismaMock.registration.findMany.mockResolvedValue([
          makeRegistration({ formData: { f1: "value,with,commas" } }) as never,
        ]);
        prismaMock.registration.count.mockResolvedValue(1);
        prismaMock.eventAccess.findMany.mockResolvedValue([]);

        const result = await exportRegistrations(eventId, eventSlug, {
          format: "csv",
          limit: 1000,
        });

        expect(result.data).toContain('"value,with,commas"');
      });

      it("escapes double quotes by doubling them", async () => {
        prismaMock.form.findFirst.mockResolvedValue({
          schema: {
            steps: [{ fields: [{ id: "f1", label: "Field", type: "text" }] }],
          },
        } as never);
        prismaMock.registration.findMany.mockResolvedValue([
          makeRegistration({ formData: { f1: 'say "hello"' } }) as never,
        ]);
        prismaMock.registration.count.mockResolvedValue(1);
        prismaMock.eventAccess.findMany.mockResolvedValue([]);

        const result = await exportRegistrations(eventId, eventSlug, {
          format: "csv",
          limit: 1000,
        });

        expect(result.data).toContain('"say ""hello"""');
      });

      it("wraps value with newline in double quotes", async () => {
        prismaMock.form.findFirst.mockResolvedValue({
          schema: {
            steps: [{ fields: [{ id: "f1", label: "Field", type: "text" }] }],
          },
        } as never);
        prismaMock.registration.findMany.mockResolvedValue([
          makeRegistration({ formData: { f1: "line1\nline2" } }) as never,
        ]);
        prismaMock.registration.count.mockResolvedValue(1);
        prismaMock.eventAccess.findMany.mockResolvedValue([]);

        const result = await exportRegistrations(eventId, eventSlug, {
          format: "csv",
          limit: 1000,
        });

        expect(result.data).toContain('"line1\nline2"');
      });

      it("outputs empty string for null/undefined formData fields", async () => {
        prismaMock.form.findFirst.mockResolvedValue({
          schema: {
            steps: [
              { fields: [{ id: "f1", label: "MissingField", type: "text" }] },
            ],
          },
        } as never);
        // formData does not contain field "f1"
        prismaMock.registration.findMany.mockResolvedValue([
          makeRegistration({ formData: {} }) as never,
        ]);
        prismaMock.registration.count.mockResolvedValue(1);
        prismaMock.eventAccess.findMany.mockResolvedValue([]);

        const result = await exportRegistrations(eventId, eventSlug, {
          format: "csv",
          limit: 1000,
        });

        // MissingField column should exist but its value should be empty
        const lines = result.data.split("\n");
        const headerCols = lines[0].split(",");
        const fieldIdx = headerCols.indexOf("MissingField");
        expect(fieldIdx).toBeGreaterThan(-1);

        const dataRow = lines[1].split(",");
        expect(dataRow[fieldIdx]).toBe("");
      });
    });

    // ─── Edge cases ─────────────────────────────────────────────────────────
    describe("edge cases", () => {
      it("returns empty CSV with only headers when there are no registrations", async () => {
        prismaMock.form.findFirst.mockResolvedValue(null);
        prismaMock.registration.findMany.mockResolvedValue([]);
        prismaMock.registration.count.mockResolvedValue(0);
        prismaMock.eventAccess.findMany.mockResolvedValue([]);

        const result = await exportRegistrations(eventId, eventSlug, {
          format: "csv",
          limit: 1000,
        });

        expect(result.data).toContain("ID,Email,First Name,Last Name");
        // Only the header row — no data rows
        const lines = result.data.split("\n").filter((l) => l.trim() !== "");
        expect(lines).toHaveLength(1);
        expect(result.metadata).toMatchObject({
          total: 0,
          exported: 0,
          truncated: false,
        });
      });

      it("returns empty JSON array when there are no registrations", async () => {
        prismaMock.form.findFirst.mockResolvedValue(null);
        prismaMock.registration.findMany.mockResolvedValue([]);
        prismaMock.registration.count.mockResolvedValue(0);
        prismaMock.eventAccess.findMany.mockResolvedValue([]);

        const result = await exportRegistrations(eventId, eventSlug, {
          format: "json",
          limit: 1000,
        });

        const parsed = JSON.parse(result.data);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed).toHaveLength(0);
        expect(result.metadata.total).toBe(0);
      });

      it("applies startDate filter to WHERE clause", async () => {
        prismaMock.form.findFirst.mockResolvedValue(null);
        prismaMock.registration.findMany.mockResolvedValue([]);
        prismaMock.registration.count.mockResolvedValue(0);
        prismaMock.eventAccess.findMany.mockResolvedValue([]);

        await exportRegistrations(eventId, eventSlug, {
          format: "csv",
          limit: 1000,
          startDate: "2024-01-01",
        });

        expect(prismaMock.registration.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              eventId,
              submittedAt: expect.objectContaining({
                gte: new Date("2024-01-01"),
              }),
            }),
          }),
        );
      });

      it("applies endDate filter to WHERE clause", async () => {
        prismaMock.form.findFirst.mockResolvedValue(null);
        prismaMock.registration.findMany.mockResolvedValue([]);
        prismaMock.registration.count.mockResolvedValue(0);
        prismaMock.eventAccess.findMany.mockResolvedValue([]);

        await exportRegistrations(eventId, eventSlug, {
          format: "csv",
          limit: 1000,
          endDate: "2024-12-31",
        });

        expect(prismaMock.registration.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              eventId,
              submittedAt: expect.objectContaining({
                lte: new Date("2024-12-31"),
              }),
            }),
          }),
        );
      });

      it("applies both startDate and endDate filters together", async () => {
        prismaMock.form.findFirst.mockResolvedValue(null);
        prismaMock.registration.findMany.mockResolvedValue([]);
        prismaMock.registration.count.mockResolvedValue(0);
        prismaMock.eventAccess.findMany.mockResolvedValue([]);

        await exportRegistrations(eventId, eventSlug, {
          format: "csv",
          limit: 1000,
          startDate: "2024-03-01",
          endDate: "2024-03-31",
        });

        expect(prismaMock.registration.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              submittedAt: expect.objectContaining({
                gte: new Date("2024-03-01"),
                lte: new Date("2024-03-31"),
              }),
            }),
          }),
        );
      });

      it("marks truncated=false when exported equals total", async () => {
        prismaMock.form.findFirst.mockResolvedValue(null);
        prismaMock.registration.findMany.mockResolvedValue([
          makeRegistration() as never,
          makeRegistration() as never,
        ]);
        prismaMock.registration.count.mockResolvedValue(2);
        prismaMock.eventAccess.findMany.mockResolvedValue([]);

        const result = await exportRegistrations(eventId, eventSlug, {
          format: "csv",
          limit: 1000,
        });

        expect(result.metadata).toMatchObject({
          total: 2,
          exported: 2,
          truncated: false,
        });
      });

      it("respects limit and reports truncation when more registrations exist than limit", async () => {
        // limit=2 but total=100 in the database
        prismaMock.form.findFirst.mockResolvedValue(null);
        prismaMock.registration.findMany.mockResolvedValue([
          makeRegistration() as never,
          makeRegistration() as never,
        ]);
        prismaMock.registration.count.mockResolvedValue(100);
        prismaMock.eventAccess.findMany.mockResolvedValue([]);

        const result = await exportRegistrations(eventId, eventSlug, {
          format: "csv",
          limit: 2,
        });

        expect(result.metadata).toMatchObject({
          total: 100,
          exported: 2,
          truncated: true,
        });
        // CSV should have header + 2 data rows
        const lines = result.data.split("\n").filter((l) => l.trim() !== "");
        expect(lines).toHaveLength(3); // 1 header + 2 data rows
      });
    });
  });
});
