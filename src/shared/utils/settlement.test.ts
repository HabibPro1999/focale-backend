import { describe, expect, it } from "vitest";
import { calculateSettlement } from "./settlement.js";

describe("calculateSettlement", () => {
  it("marks zero-total registrations settled without sponsorship", () => {
    expect(
      calculateSettlement({
        totalAmount: 0,
        paidAmount: 0,
        sponsorshipAmount: 0,
      }),
    ).toEqual({
      amountDue: 0,
      netAmount: 0,
      isSettled: true,
      isPartiallyPaid: false,
    });
  });

  it("tracks partial coverage", () => {
    expect(
      calculateSettlement({
        totalAmount: 300,
        paidAmount: 100,
        sponsorshipAmount: 50,
      }),
    ).toMatchObject({
      amountDue: 150,
      netAmount: 250,
      isSettled: false,
      isPartiallyPaid: true,
    });
  });

  it("caps amount due at zero for overpayment", () => {
    expect(
      calculateSettlement({
        totalAmount: 300,
        paidAmount: 400,
        sponsorshipAmount: 0,
      }),
    ).toMatchObject({
      amountDue: 0,
      isSettled: true,
      isPartiallyPaid: false,
    });
  });
});
