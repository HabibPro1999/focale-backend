import { describe, it, expect, vi } from "vitest";
import { withTxnRetry } from "./with-txn-retry.js";

// Mimics a CockroachDB/Postgres retryable serialization failure (SQLSTATE 40001).
function serializationError(): Error {
  return Object.assign(new Error("restart transaction: TransactionRetryError"), {
    code: "40001",
  });
}

describe("withTxnRetry", () => {
  it("returns the result without retrying on success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    await expect(withTxnRetry(fn, { baseDelayMs: 0 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on a serialization failure, then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(serializationError())
      .mockResolvedValueOnce("ok");

    await expect(withTxnRetry(fn, { baseDelayMs: 0 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const err = serializationError();
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      withTxnRetry(fn, { maxAttempts: 3, baseDelayMs: 0 }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-serialization error", async () => {
    const err = new Error("boom");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withTxnRetry(fn, { baseDelayMs: 0 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
