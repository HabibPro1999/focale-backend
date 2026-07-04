// Pins the load-bearing retry semantics of withTxnRetry / isSerializationFailure
// (fix #4 consolidation): 5 attempts total, retry ONLY on SQLSTATE 40001/40P01,
// rethrow the ORIGINAL error. No DB needed — withTxnRetry just wraps a fn.
import { describe, expect, it, vi } from "vitest";
import { isSerializationFailure, pgUniqueViolation, withTxnRetry } from "./txn";

const err = (code?: string) => Object.assign(new Error("boom"), { code });
// drizzle-orm wraps every driver error in DrizzleQueryError: the pg error
// (with .code/.constraint) lives on .cause, the wrapper has no code.
const wrapped = (cause: unknown) =>
  Object.assign(new Error("Failed query"), { cause });

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

  it("unwraps DrizzleQueryError-style wrappers via .cause", () => {
    expect(isSerializationFailure(wrapped(err("40001")))).toBe(true);
    expect(isSerializationFailure(wrapped(wrapped(err("40P01"))))).toBe(true);
    expect(isSerializationFailure(wrapped(err("23505")))).toBe(false);
    expect(isSerializationFailure(wrapped(new Error("no code")))).toBe(false);
  });
});

describe("pgUniqueViolation", () => {
  it("detects a bare pg 23505 and surfaces the constraint", () => {
    const e = Object.assign(new Error("dup"), {
      code: "23505",
      constraint: "registrations_email_form_id_key",
    });
    expect(pgUniqueViolation(e)).toEqual({
      constraint: "registrations_email_form_id_key",
    });
    expect(pgUniqueViolation(err("40001"))).toBeNull();
    expect(pgUniqueViolation(null)).toBeNull();
  });

  it("unwraps DrizzleQueryError-style wrappers via .cause", () => {
    const e = Object.assign(new Error("dup"), {
      code: "23505",
      constraint: "outbox_dedupe_key_key",
    });
    expect(pgUniqueViolation(wrapped(e))).toEqual({
      constraint: "outbox_dedupe_key_key",
    });
    const noConstraint = Object.assign(new Error("dup"), { code: "23505" });
    expect(pgUniqueViolation(wrapped(noConstraint))).toEqual({ constraint: "" });
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
