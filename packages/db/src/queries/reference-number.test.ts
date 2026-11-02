import { afterEach, describe, expect, it } from "vitest";
import { formatReferenceNumber, referenceNumberPrefix } from "./registrations";

describe("registration reference numbers", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it.each([
    // Local time is already the next year east of UTC, and still the previous year west of it.
    ["Pacific/Kiritimati", "2027-12-31T23:30:00.000Z", "27-"],
    ["America/Los_Angeles", "2028-01-01T00:30:00.000Z", "28-"],
    ["UTC", "2028-01-01T00:30:00.000Z", "28-"],
  ])("takes the year in UTC whatever the process time zone (%s)", (zone, start, year) => {
    process.env.TZ = zone;
    expect(referenceNumberPrefix({ slug: "tshg", startDate: new Date(start) })).toBe(`${year}TSHG-`);
  });

  it("upper-cases the slug, maps . and _ to -, and keeps its first 12 characters", () => {
    const startDate = new Date("2027-03-01T09:00:00.000Z");
    expect(referenceNumberPrefix({ slug: "tshg.congres_2027-paris", startDate })).toBe("27-TSHG-CONGRES-");
    expect(referenceNumberPrefix({ slug: "congress-2027-paris", startDate })).toBe("27-CONGRESS-202-");
    expect(referenceNumberPrefix({ slug: "congress-2027-lyon", startDate })).toBe("27-CONGRESS-202-");
  });

  it("pads the sequence to three digits without truncating longer ones", () => {
    expect(formatReferenceNumber("27-TSHG-", 7)).toBe("27-TSHG-007");
    expect(formatReferenceNumber("27-TSHG-", 1000)).toBe("27-TSHG-1000");
  });
});
