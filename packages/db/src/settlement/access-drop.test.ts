import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
  lockRegistrationForUpdate: vi.fn(),
  insertAuditLog: vi.fn(),
  recorded: [] as Array<{ changes: unknown }>,
}));
vi.mock("@app/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app/shared")>();
  return { ...actual, createLogger: () => mocks.log };
});
vi.mock("../client", () => ({ getDb: vi.fn() }));
vi.mock("../locks", () => ({ lockRegistrationForUpdate: mocks.lockRegistrationForUpdate }));
vi.mock("../outbox", () => ({ enqueueOutboxEvent: vi.fn(), insertAuditLog: mocks.insertAuditLog }));
vi.mock("../txn", () => {
  const tx = {
    select: () => ({ from: () => ({ where: async () => mocks.recorded }) }),
  };
  return { withLockingTxn: (fn: (t: typeof tx) => unknown) => fn(tx) };
});

import { recordOverpaidDropSkip, type OverpaidDropSkip } from "./access-drop";

// Plan 2.8 decision 4: an access drop that would leave a registration overpaid
// is skipped (the registration keeps the item); each skip is logged at warn and
// recorded on the registration's history.

const skip: OverpaidDropSkip = {
  accessId: "acc-gala",
  accessName: "Gala",
  reason: "capacity_reached",
  paidAmount: 450,
  amountDue: 500,
  amountDueWithoutAccess: 300,
};

const changes = {
  accessKept: { old: "Gala", new: "capacity_reached" },
  accessId: { old: null, new: "acc-gala" },
  paidAmount: { old: null, new: 450 },
  amountDue: { old: null, new: 500 },
  amountDueWithoutAccess: { old: null, new: 300 },
};

describe("recordOverpaidDropSkip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recorded = [];
    mocks.lockRegistrationForUpdate.mockResolvedValue(true);
  });

  it("logs the skip at warn and records it on the registration's history", async () => {
    expect(await recordOverpaidDropSkip("reg1", skip)).toBe(true);

    expect(mocks.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ registrationId: "reg1", ...skip }),
      expect.stringContaining("access drop skipped"),
    );
    expect(mocks.lockRegistrationForUpdate).toHaveBeenCalledWith(expect.anything(), "reg1");
    expect(mocks.insertAuditLog).toHaveBeenCalledWith(
      {
        entityType: "Registration",
        entityId: "reg1",
        action: "ACCESS_DROP_SKIPPED_OVERPAID",
        changes,
        performedBy: "SYSTEM",
      },
      expect.anything(),
    );
  });

  it("does not repeat an identical entry, but still logs the skip", async () => {
    // jsonb comes back with its keys reordered.
    const { amountDueWithoutAccess, ...rest } = changes;
    mocks.recorded = [{ changes: { amountDueWithoutAccess, ...rest } }];

    expect(await recordOverpaidDropSkip("reg1", skip)).toBe(false);

    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
  });

  it("records a new entry when the amounts changed", async () => {
    mocks.recorded = [{ changes }];

    expect(await recordOverpaidDropSkip("reg1", { ...skip, paidAmount: 480 })).toBe(true);

    expect(mocks.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.objectContaining({ paidAmount: { old: null, new: 480 } }),
      }),
      expect.anything(),
    );
  });

  it("writes nothing for a registration deleted since", async () => {
    mocks.lockRegistrationForUpdate.mockResolvedValue(false);

    expect(await recordOverpaidDropSkip("reg1", skip)).toBe(false);

    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
  });
});
