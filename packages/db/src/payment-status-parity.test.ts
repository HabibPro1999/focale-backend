import { describe, expect, it } from "vitest";
import { PaymentStatusSchema } from "@app/contracts";
import { PAYMENT_STATUSES } from "@app/shared";
import { paymentStatus } from "./schema/enums";

describe("payment status lists", () => {
  it("are the same in @app/shared, @app/contracts and the database enum", () => {
    expect([...PAYMENT_STATUSES].sort()).toEqual([...PaymentStatusSchema.options].sort());
    expect([...PAYMENT_STATUSES].sort()).toEqual([...paymentStatus.enumValues].sort());
  });
});
