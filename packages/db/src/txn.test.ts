// Pins the load-bearing retry semantics of withTxnRetry / isSerializationFailure
// (fix #4 consolidation): 5 attempts total, retry ONLY on SQLSTATE 40001/40P01,
// rethrow the ORIGINAL error. No DB needed — withTxnRetry just wraps a fn.
import { describe, expect, it, vi } from "vitest";
import { isSerializationFailure, withTxnRetry } from "./txn";

const err = (code?: string) => Object.assign(new Error("boom"), { code });

describe("isSerializationFailure", () => {
  it("true only for 40001 / 40P01, by code", () => {
    expect(isSerializationFailure(err("40001"))).toBe(true);
    expect(isSerializationFailure(err("40P01"))).toBe(true);
    expect(isSerializationFailure(err("23505"))).toBe(false);
    expect(isSerializationFailure(err(undefined))).toBe(false);
    expect(isSerializationFailure(null)).toBe(false);
    // Message text alone is NOT retried (spec: code-only) — a deliberate
    // narrowing from the old identity.ts copy's message-regex fallback.
    expect(isSerializationFailure(new Error("serialization failure"))).toBe(false);
  });
});

describe("withTxnRetry", () => {
  it("returns the value without retrying on success", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    await expect(withTxnRetry(fn)).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a non-serialization error; rethrows it immediately", async () => {
    const boom = err("23505");
    const fn = vi.fn().mockRejectedValue(boom);
    await expect(withTxnRetry(fn)).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a 40001 up to 5 total attempts, then rethrows the original", async () => {
    const boom = err("40001");
    const fn = vi.fn().mockRejectedValue(boom);
    await expect(withTxnRetry(fn)).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it("retries 40P01 and succeeds if a later attempt resolves", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err("40P01"))
      .mockRejectedValueOnce(err("40001"))
      .mockResolvedValue("ok");
    await expect(withTxnRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
