import { describe, expect, it, vi } from "vitest";
import type { DbExecutor } from "./client";
import {
  lockEventForUpdate,
  lockRegistrationForUpdate,
  lockRegistrationsForUpdate,
  lockSponsorshipByCodeForUpdate,
} from "./locks";

describe("row lock helpers outside the database", () => {
  it("refuse a non-transaction executor before sending any query", async () => {
    const select = vi.fn();
    const root = { select } as unknown as DbExecutor;
    await expect(lockRegistrationForUpdate(root, "a")).rejects.toThrow(
      "lockRegistrationForUpdate must run inside a transaction",
    );
    await expect(lockRegistrationsForUpdate(root, [])).rejects.toThrow(/inside a transaction/);
    await expect(lockSponsorshipByCodeForUpdate(root, "event", "SP-CODE")).rejects.toThrow(/inside a transaction/);
    await expect(lockEventForUpdate(root, "event")).rejects.toThrow(/inside a transaction/);
    expect(select).not.toHaveBeenCalled();
  });

  it("sends nothing for an empty id list", async () => {
    const select = vi.fn();
    const tx = { select, rollback: vi.fn() } as unknown as DbExecutor;
    await expect(lockRegistrationsForUpdate(tx, [])).resolves.toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });
});
