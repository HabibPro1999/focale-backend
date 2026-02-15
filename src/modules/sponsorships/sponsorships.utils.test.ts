import { describe, it, expect } from "vitest";
import {
  validateCoveredAccessTimeOverlap,
  getAccessTypeKey,
  type AccessItemForOverlapCheck,
} from "./sponsorships.utils.js";

describe("validateCoveredAccessTimeOverlap", () => {
  const createAccessItem = (
    id: string,
    name: string,
    type: string,
    startsAt: Date | null,
    endsAt: Date | null,
    groupLabel: string | null = null,
  ): AccessItemForOverlapCheck => ({
    id,
    name,
    type,
    groupLabel,
    startsAt,
    endsAt,
  });

  it("should return error for two overlapping items in same type group", () => {
    const items: AccessItemForOverlapCheck[] = [
      createAccessItem(
        "a1",
        "Workshop A",
        "WORKSHOP",
        new Date("2025-04-16T10:00:00Z"),
        new Date("2025-04-16T12:00:00Z"),
      ),
      createAccessItem(
        "a2",
        "Workshop B",
        "WORKSHOP",
        new Date("2025-04-16T11:00:00Z"),
        new Date("2025-04-16T13:00:00Z"),
      ),
    ];

    const errors = validateCoveredAccessTimeOverlap(["a1", "a2"], items);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Workshop A");
    expect(errors[0]).toContain("Workshop B");
    expect(errors[0]).toContain("overlap");
  });

  it("should return empty array for two non-overlapping items in same group", () => {
    const items: AccessItemForOverlapCheck[] = [
      createAccessItem(
        "a1",
        "Workshop A",
        "WORKSHOP",
        new Date("2025-04-16T10:00:00Z"),
        new Date("2025-04-16T12:00:00Z"),
      ),
      createAccessItem(
        "a2",
        "Workshop B",
        "WORKSHOP",
        new Date("2025-04-16T12:00:00Z"),
        new Date("2025-04-16T14:00:00Z"),
      ),
    ];

    const errors = validateCoveredAccessTimeOverlap(["a1", "a2"], items);

    expect(errors).toHaveLength(0);
  });

  it("should return empty array for items in different type groups", () => {
    const items: AccessItemForOverlapCheck[] = [
      createAccessItem(
        "a1",
        "Workshop A",
        "WORKSHOP",
        new Date("2025-04-16T10:00:00Z"),
        new Date("2025-04-16T12:00:00Z"),
      ),
      createAccessItem(
        "a2",
        "Meal B",
        "MEAL",
        new Date("2025-04-16T11:00:00Z"),
        new Date("2025-04-16T13:00:00Z"),
      ),
    ];

    const errors = validateCoveredAccessTimeOverlap(["a1", "a2"], items);

    expect(errors).toHaveLength(0);
  });

  it("should ignore items with null startsAt or endsAt", () => {
    const items: AccessItemForOverlapCheck[] = [
      createAccessItem(
        "a1",
        "Workshop A",
        "WORKSHOP",
        new Date("2025-04-16T10:00:00Z"),
        new Date("2025-04-16T12:00:00Z"),
      ),
      createAccessItem("a2", "Workshop B", "WORKSHOP", null, null),
    ];

    const errors = validateCoveredAccessTimeOverlap(["a1", "a2"], items);

    expect(errors).toHaveLength(0);
  });

  it("should NOT conflict when aEnd === bStart (boundary case)", () => {
    const items: AccessItemForOverlapCheck[] = [
      createAccessItem(
        "a1",
        "Workshop A",
        "WORKSHOP",
        new Date("2025-04-16T10:00:00Z"),
        new Date("2025-04-16T12:00:00Z"),
      ),
      createAccessItem(
        "a2",
        "Workshop B",
        "WORKSHOP",
        new Date("2025-04-16T12:00:00Z"),
        new Date("2025-04-16T14:00:00Z"),
      ),
    ];

    const errors = validateCoveredAccessTimeOverlap(["a1", "a2"], items);

    expect(errors).toHaveLength(0);
  });

  it("should group items with type OTHER and same groupLabel together", () => {
    const items: AccessItemForOverlapCheck[] = [
      createAccessItem(
        "a1",
        "Custom A",
        "OTHER",
        new Date("2025-04-16T10:00:00Z"),
        new Date("2025-04-16T12:00:00Z"),
        "VIP",
      ),
      createAccessItem(
        "a2",
        "Custom B",
        "OTHER",
        new Date("2025-04-16T11:00:00Z"),
        new Date("2025-04-16T13:00:00Z"),
        "VIP",
      ),
    ];

    const errors = validateCoveredAccessTimeOverlap(["a1", "a2"], items);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Custom A");
    expect(errors[0]).toContain("Custom B");
  });

  it("should NOT group items with type OTHER and different groupLabels", () => {
    const items: AccessItemForOverlapCheck[] = [
      createAccessItem(
        "a1",
        "Custom A",
        "OTHER",
        new Date("2025-04-16T10:00:00Z"),
        new Date("2025-04-16T12:00:00Z"),
        "VIP",
      ),
      createAccessItem(
        "a2",
        "Custom B",
        "OTHER",
        new Date("2025-04-16T11:00:00Z"),
        new Date("2025-04-16T13:00:00Z"),
        "Premium",
      ),
    ];

    const errors = validateCoveredAccessTimeOverlap(["a1", "a2"], items);

    expect(errors).toHaveLength(0);
  });

  it("should return empty array for single item", () => {
    const items: AccessItemForOverlapCheck[] = [
      createAccessItem(
        "a1",
        "Workshop A",
        "WORKSHOP",
        new Date("2025-04-16T10:00:00Z"),
        new Date("2025-04-16T12:00:00Z"),
      ),
    ];

    const errors = validateCoveredAccessTimeOverlap(["a1"], items);

    expect(errors).toHaveLength(0);
  });

  it("should return empty array for empty array", () => {
    const errors = validateCoveredAccessTimeOverlap([], []);

    expect(errors).toHaveLength(0);
  });

  it("should detect multiple overlaps within same group", () => {
    const items: AccessItemForOverlapCheck[] = [
      createAccessItem(
        "a1",
        "Workshop A",
        "WORKSHOP",
        new Date("2025-04-16T10:00:00Z"),
        new Date("2025-04-16T12:00:00Z"),
      ),
      createAccessItem(
        "a2",
        "Workshop B",
        "WORKSHOP",
        new Date("2025-04-16T11:00:00Z"),
        new Date("2025-04-16T13:00:00Z"),
      ),
      createAccessItem(
        "a3",
        "Workshop C",
        "WORKSHOP",
        new Date("2025-04-16T11:30:00Z"),
        new Date("2025-04-16T14:00:00Z"),
      ),
    ];

    const errors = validateCoveredAccessTimeOverlap(["a1", "a2", "a3"], items);

    // Should have 3 errors: A-B, A-C, B-C
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("getAccessTypeKey", () => {
  it("should return type for non-OTHER types", () => {
    expect(getAccessTypeKey("WORKSHOP", null)).toBe("WORKSHOP");
    expect(getAccessTypeKey("MEAL", null)).toBe("MEAL");
    expect(getAccessTypeKey("ACCOMMODATION", "ignored")).toBe("ACCOMMODATION");
  });

  it("should return OTHER:groupLabel for OTHER type", () => {
    expect(getAccessTypeKey("OTHER", "VIP")).toBe("OTHER:VIP");
    expect(getAccessTypeKey("OTHER", "Premium")).toBe("OTHER:Premium");
  });

  it("should return OTHER: for OTHER type with null groupLabel", () => {
    expect(getAccessTypeKey("OTHER", null)).toBe("OTHER:");
  });

  it("should return OTHER: for OTHER type with empty groupLabel", () => {
    expect(getAccessTypeKey("OTHER", "")).toBe("OTHER:");
  });
});
