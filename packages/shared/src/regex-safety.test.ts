import { describe, expect, it } from "vitest";
import { isSafePattern } from "./regex-safety";

describe("isSafePattern", () => {
  it("accepts simple single-quantifier patterns", () => {
    for (const p of [
      "a+",
      "a*",
      "a?",
      "[a-z]+",
      "\\d{4}",
      "(abc)+",
      "^[^@]+@[^@]+\\.[a-z]{2,}$",
      "[0-9]{2,4}",
    ]) {
      expect(isSafePattern(p), p).toBe(true);
    }
  });

  it("rejects nested quantifiers (star height > 1)", () => {
    for (const p of [
      "(a+)+",
      "(a*)*",
      "(a+)*",
      "(?:a+)+",
      "([a-z]+)+$",
      "(a+b+)+",
    ]) {
      expect(isSafePattern(p), p).toBe(false);
    }
  });

  it("rejects oversized bounded repetitions", () => {
    expect(isSafePattern("a{1000}")).toBe(false);
    expect(isSafePattern("a{1,500}")).toBe(false);
  });

  it("rejects invalid regex syntax (fails closed)", () => {
    expect(isSafePattern("(")).toBe(false);
    expect(isSafePattern("[a-z")).toBe(false);
    expect(isSafePattern("a)")).toBe(false);
  });
});
