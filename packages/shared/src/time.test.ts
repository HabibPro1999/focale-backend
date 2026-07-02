import { describe, it, expect } from "vitest";
import { addMinutes, addDays, startOfDayUtc, isPast, toIso } from "./time";

describe("time", () => {
  const base = new Date("2026-07-02T12:30:45.000Z");

  it("addMinutes / addDays", () => {
    expect(toIso(addMinutes(base, 30))).toBe("2026-07-02T13:00:45.000Z");
    expect(toIso(addDays(base, 1))).toBe("2026-07-03T12:30:45.000Z");
  });

  it("startOfDayUtc zeroes the time in UTC", () => {
    expect(toIso(startOfDayUtc(base))).toBe("2026-07-02T00:00:00.000Z");
  });

  it("isPast", () => {
    expect(isPast(new Date("2000-01-01T00:00:00.000Z"), base)).toBe(true);
    expect(isPast(addDays(base, 1), base)).toBe(false);
  });
});
