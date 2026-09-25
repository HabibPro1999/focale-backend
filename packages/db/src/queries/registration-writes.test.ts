import { describe, expect, it, vi } from "vitest";
import type { DbExecutor } from "../client";
import { updateRegistrationRow } from "./registrations";

describe("updateRegistrationRow", () => {
  it("refuses money columns, which only the settlement writer sets", async () => {
    const db = { update: vi.fn() } as unknown as DbExecutor;
    await expect(
      updateRegistrationRow("reg1", { note: "x", paymentStatus: "PAID" } as never, db),
    ).rejects.toThrow(/Money columns are written only through the settlement: paymentStatus/);
    expect((db as unknown as { update: ReturnType<typeof vi.fn> }).update).not.toHaveBeenCalled();
  });
});
