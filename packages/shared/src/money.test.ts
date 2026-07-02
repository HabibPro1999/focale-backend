import { describe, it, expect } from "vitest";
import {
  money,
  fromDecimal,
  toDecimal,
  addMoney,
  subtractMoney,
  multiplyMoney,
  assertSameCurrency,
} from "./money";

describe("money", () => {
  it("rejects non-integer minor units", () => {
    expect(() => money(1.5, "USD")).toThrow();
  });

  it("fromDecimal uses currency exponent and rounds half-up", () => {
    expect(fromDecimal(1.005, "USD")).toEqual({ amount: 101, currency: "USD" }); // 100.5 -> 101
    expect(fromDecimal(1.2345, "TND")).toEqual({ amount: 1235, currency: "TND" }); // 3 digits, 1234.5 -> 1235
  });

  it("toDecimal is inverse of fromDecimal scale", () => {
    expect(toDecimal(money(1234, "TND"))).toBe(1.234);
    expect(toDecimal(money(500, "USD"))).toBe(5);
  });

  it("add/subtract enforce same currency", () => {
    expect(addMoney(money(100, "USD"), money(50, "USD"))).toEqual(money(150, "USD"));
    expect(subtractMoney(money(100, "USD"), money(30, "USD"))).toEqual(money(70, "USD"));
    expect(() => assertSameCurrency(money(1, "USD"), money(1, "TND"))).toThrow();
    expect(() => addMoney(money(1, "USD"), money(1, "TND"))).toThrow();
  });

  it("multiply rounds half-up", () => {
    expect(multiplyMoney(money(101, "USD"), 0.5)).toEqual(money(51, "USD")); // 50.5 -> 51
    expect(multiplyMoney(money(100, "USD"), 3)).toEqual(money(300, "USD"));
  });
});
