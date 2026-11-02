import { ErrorCodes } from "@app/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  assertPaidAmountWithinNet,
  assertPaidInFull,
  assertValidSelections,
  netOf,
} from "./registrations.guards";

describe("registration guards", () => {
  it("netOf is gross minus sponsorship, floored at 0", () => {
    expect(netOf({ totalAmount: 100, sponsorshipAmount: 40 })).toBe(60);
    expect(netOf({ totalAmount: 100, sponsorshipAmount: 140 })).toBe(0);
  });

  it("assertPaidAmountWithinNet refuses only an amount above the net", () => {
    expect(() => assertPaidAmountWithinNet(60, 60)).not.toThrow();
    expect(() => assertPaidAmountWithinNet(0, 60)).not.toThrow();
    expect(() => assertPaidAmountWithinNet(61, 60)).toThrow(
      expect.objectContaining({ code: ErrorCodes.BAD_REQUEST, statusCode: 400 }),
    );
  });

  it("assertPaidInFull refuses less than the net with the amounts", () => {
    expect(() => assertPaidInFull(60, 60)).not.toThrow();
    expect(() => assertPaidInFull(59, 60)).toThrow(
      expect.objectContaining({
        code: ErrorCodes.PAID_AMOUNT_BELOW_DUE,
        statusCode: 400,
        details: { amountDue: 60, paidAmount: 59 },
      }),
    );
  });

  it("assertValidSelections passes the executor and existing items, and lists every error", async () => {
    const access = {
      validateAccessSelections: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
    };
    const exec = { marker: true } as never;
    const existing = new Set(["a"]);
    const selections = [{ accessId: "a", quantity: 1 }];
    await assertValidSelections(access as never, "ev1", selections, { x: 1 }, { existingAccessIds: existing, exec });
    expect(access.validateAccessSelections).toHaveBeenCalledWith("ev1", selections, { x: 1 }, existing, exec);

    access.validateAccessSelections.mockResolvedValue({ valid: false, errors: ["full", "ineligible"] });
    await expect(assertValidSelections(access as never, "ev1", selections, {})).rejects.toMatchObject({
      code: ErrorCodes.BAD_REQUEST,
      statusCode: 400,
      message: "Invalid access selections: full, ineligible",
      details: { errors: ["full", "ineligible"] },
    });
  });
});
