import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../queries/access", () => ({
  casIncrementAccessPaidCount: vi.fn(),
  casDecrementAccessPaidCount: vi.fn(),
  getAccessCapacityInfo: vi.fn(),
  getAccessPaidCount: vi.fn(),
}));

import * as access from "../queries/access";
import type { DbExecutor } from "../client";
import {
  AccessCapacityExceededError,
  AccessNotFoundError,
  AccessPaidCountUnderflowError,
  applyPaidAccessDelta,
  releasePaidAccess,
  takePaidAccess,
} from "./paid-access";

const m = access as unknown as Record<string, ReturnType<typeof vi.fn>>;
const tx = {} as DbExecutor;

beforeEach(() => vi.resetAllMocks());

describe("takePaidAccess / releasePaidAccess", () => {
  it("take within capacity without a follow-up read", async () => {
    m.casIncrementAccessPaidCount.mockResolvedValue(true);
    await takePaidAccess(tx, "access-1", 1);
    expect(m.getAccessCapacityInfo).not.toHaveBeenCalled();
  });

  it("report a missing item", async () => {
    m.casIncrementAccessPaidCount.mockResolvedValue(false);
    m.getAccessCapacityInfo.mockResolvedValue(null);
    await expect(takePaidAccess(tx, "x", 1)).rejects.toBeInstanceOf(AccessNotFoundError);
  });

  it("report the remaining places when the item is full", async () => {
    m.casIncrementAccessPaidCount.mockResolvedValue(false);
    m.getAccessCapacityInfo.mockResolvedValue({ name: "Workshop", maxCapacity: 10, paidCount: 8 });
    const error = await takePaidAccess(tx, "access-1", 3).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccessCapacityExceededError);
    expect(error).toMatchObject({
      remaining: 2,
      requested: 3,
      message: "Workshop has insufficient capacity (2 spots remaining, requested 3)",
    });
  });

  it("report an underflow", async () => {
    m.casDecrementAccessPaidCount.mockResolvedValue(false);
    m.getAccessPaidCount.mockResolvedValue({ paidCount: 1 });
    const error = await releasePaidAccess(tx, "access-1", 2).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccessPaidCountUnderflowError);
    expect(error).toMatchObject({ paidCount: 1, requested: 2 });
  });
});

describe("applyPaidAccessDelta", () => {
  it("increments only newly-paid access quantities", async () => {
    m.casIncrementAccessPaidCount.mockResolvedValue(true);
    const items = [
      { accessId: "access-1", quantity: 1 },
      { accessId: "access-2", quantity: 1 },
    ];
    const result = await applyPaidAccessDelta(
      tx,
      { status: "PARTIAL", priceBreakdown: { accessItems: items }, coveredAccessIds: new Set(["access-1"]) },
      { status: "PARTIAL", priceBreakdown: { accessItems: items }, coveredAccessIds: new Set(["access-1", "access-2"]) },
    );
    expect(m.casIncrementAccessPaidCount).toHaveBeenCalledTimes(1);
    expect(m.casIncrementAccessPaidCount).toHaveBeenCalledWith("access-2", 1, tx);
    expect(result).toEqual({ incremented: ["access-2"], decremented: [] });
  });

  it("decrements partial coverage on refund", async () => {
    m.casDecrementAccessPaidCount.mockResolvedValue(true);
    const breakdown = { accessItems: [{ accessId: "access-1", quantity: 2 }] };
    const result = await applyPaidAccessDelta(
      tx,
      { status: "PARTIAL", priceBreakdown: breakdown, coveredAccessIds: new Set(["access-1"]) },
      { status: "REFUNDED", priceBreakdown: breakdown },
    );
    expect(m.casDecrementAccessPaidCount).toHaveBeenCalledWith("access-1", 2, tx);
    expect(m.casIncrementAccessPaidCount).not.toHaveBeenCalled();
    expect(result).toEqual({ incremented: [], decremented: ["access-1"] });
  });

  it("does nothing when a fully settled registration stays settled", async () => {
    const breakdown = { accessItems: [{ accessId: "access-1", quantity: 1 }] };
    await applyPaidAccessDelta(tx, { status: "SPONSORED", priceBreakdown: breakdown }, { status: "PAID", priceBreakdown: breakdown });
    expect(m.casIncrementAccessPaidCount).not.toHaveBeenCalled();
    expect(m.casDecrementAccessPaidCount).not.toHaveBeenCalled();
  });

  it("stops at the first item that does not fit", async () => {
    m.casIncrementAccessPaidCount.mockResolvedValueOnce(false);
    m.getAccessCapacityInfo.mockResolvedValue({ name: "Gala", maxCapacity: 1, paidCount: 1 });
    const breakdown = {
      accessItems: [
        { accessId: "gala", quantity: 1 },
        { accessId: "lunch", quantity: 1 },
      ],
    };
    await expect(
      applyPaidAccessDelta(tx, { status: "PENDING", priceBreakdown: breakdown }, { status: "PAID", priceBreakdown: breakdown }),
    ).rejects.toBeInstanceOf(AccessCapacityExceededError);
    expect(m.casIncrementAccessPaidCount).toHaveBeenCalledTimes(1);
  });
});
