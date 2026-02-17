import { describe, it, expect, vi } from "vitest";
import { faker } from "@faker-js/faker";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { createMockEventPricing } from "../../../tests/helpers/factories.js";
import { getSponsorshipStats } from "./sponsorships.service.js";

// groupBy has complex overloaded types that mockDeep doesn't handle
const mockGroupBy = vi.mocked(
  prismaMock.sponsorship.groupBy as unknown as (() => unknown) & {
    mockResolvedValue: (v: unknown) => void;
  },
);

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
