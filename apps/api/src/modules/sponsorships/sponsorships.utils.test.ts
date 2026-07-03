import { describe, it, expect } from "vitest";
import {
  calculateApplicableAmount,
  calculateTotalSponsorshipAmount,
  detectCoverageOverlap,
  determineSponsorshipStatus,
  generateSponsorshipCode,
  getAccessTypeKey,
  validateCoveredAccessTimeOverlap,
  type AccessItemForOverlapCheck,
  type ExistingUsage,
} from "./sponsorships.utils";

// ============================================================================
// validateCoveredAccessTimeOverlap
// ============================================================================

const item = (
  id: string,
  name: string,
  type: string,
  startsAt: Date | null,
  endsAt: Date | null,
  groupLabel: string | null = null,
): AccessItemForOverlapCheck => ({ id, name, type, groupLabel, startsAt, endsAt });

describe("validateCoveredAccessTimeOverlap", () => {
  it("flags two overlapping items in the same type group", () => {
    const errors = validateCoveredAccessTimeOverlap(
      ["a1", "a2"],
      [
        item("a1", "Workshop A", "WORKSHOP", new Date("2025-04-16T10:00:00Z"), new Date("2025-04-16T12:00:00Z")),
        item("a2", "Workshop B", "WORKSHOP", new Date("2025-04-16T11:00:00Z"), new Date("2025-04-16T13:00:00Z")),
      ],
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Workshop A");
    expect(errors[0]).toContain("Workshop B");
    expect(errors[0]).toContain("overlap");
  });

  it("passes non-overlapping items in same group", () => {
    const errors = validateCoveredAccessTimeOverlap(
      ["a1", "a2"],
      [
        item("a1", "A", "WORKSHOP", new Date("2025-04-16T10:00:00Z"), new Date("2025-04-16T12:00:00Z")),
        item("a2", "B", "WORKSHOP", new Date("2025-04-16T12:00:00Z"), new Date("2025-04-16T14:00:00Z")),
      ],
    );
    expect(errors).toHaveLength(0);
  });

  it("does not group across different types even if times overlap", () => {
    const errors = validateCoveredAccessTimeOverlap(
      ["a1", "a2"],
      [
        item("a1", "A", "WORKSHOP", new Date("2025-04-16T10:00:00Z"), new Date("2025-04-16T12:00:00Z")),
        item("a2", "B", "MEAL", new Date("2025-04-16T11:00:00Z"), new Date("2025-04-16T13:00:00Z")),
      ],
    );
    expect(errors).toHaveLength(0);
  });

  it("ignores items with null start/end", () => {
    const errors = validateCoveredAccessTimeOverlap(
      ["a1", "a2"],
      [
        item("a1", "A", "WORKSHOP", new Date("2025-04-16T10:00:00Z"), new Date("2025-04-16T12:00:00Z")),
        item("a2", "B", "WORKSHOP", null, null),
      ],
    );
    expect(errors).toHaveLength(0);
  });

  it("treats touching boundaries (aEnd === bStart) as non-conflicting", () => {
    const errors = validateCoveredAccessTimeOverlap(
      ["a1", "a2"],
      [
        item("a1", "A", "WORKSHOP", new Date("2025-04-16T10:00:00Z"), new Date("2025-04-16T12:00:00Z")),
        item("a2", "B", "WORKSHOP", new Date("2025-04-16T12:00:00Z"), new Date("2025-04-16T14:00:00Z")),
      ],
    );
    expect(errors).toHaveLength(0);
  });

  it("groups OTHER by groupLabel (same label conflicts)", () => {
    const errors = validateCoveredAccessTimeOverlap(
      ["a1", "a2"],
      [
        item("a1", "Custom A", "OTHER", new Date("2025-04-16T10:00:00Z"), new Date("2025-04-16T12:00:00Z"), "VIP"),
        item("a2", "Custom B", "OTHER", new Date("2025-04-16T11:00:00Z"), new Date("2025-04-16T13:00:00Z"), "VIP"),
      ],
    );
    expect(errors).toHaveLength(1);
  });

  it("does not group OTHER with different labels", () => {
    const errors = validateCoveredAccessTimeOverlap(
      ["a1", "a2"],
      [
        item("a1", "Custom A", "OTHER", new Date("2025-04-16T10:00:00Z"), new Date("2025-04-16T12:00:00Z"), "VIP"),
        item("a2", "Custom B", "OTHER", new Date("2025-04-16T11:00:00Z"), new Date("2025-04-16T13:00:00Z"), "Premium"),
      ],
    );
    expect(errors).toHaveLength(0);
  });

  it("returns empty for single item and empty array", () => {
    expect(
      validateCoveredAccessTimeOverlap(
        ["a1"],
        [item("a1", "A", "WORKSHOP", new Date(), new Date())],
      ),
    ).toHaveLength(0);
    expect(validateCoveredAccessTimeOverlap([], [])).toHaveLength(0);
  });

  it("detects multiple overlaps within same group", () => {
    const errors = validateCoveredAccessTimeOverlap(
      ["a1", "a2", "a3"],
      [
        item("a1", "A", "WORKSHOP", new Date("2025-04-16T10:00:00Z"), new Date("2025-04-16T12:00:00Z")),
        item("a2", "B", "WORKSHOP", new Date("2025-04-16T11:00:00Z"), new Date("2025-04-16T13:00:00Z")),
        item("a3", "C", "WORKSHOP", new Date("2025-04-16T11:30:00Z"), new Date("2025-04-16T14:00:00Z")),
      ],
    );
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("getAccessTypeKey", () => {
  it("returns the type verbatim for non-OTHER", () => {
    expect(getAccessTypeKey("WORKSHOP", null)).toBe("WORKSHOP");
    expect(getAccessTypeKey("ACCOMMODATION", "ignored")).toBe("ACCOMMODATION");
  });
  it("returns OTHER:<label> for OTHER", () => {
    expect(getAccessTypeKey("OTHER", "VIP")).toBe("OTHER:VIP");
    expect(getAccessTypeKey("OTHER", null)).toBe("OTHER:");
    expect(getAccessTypeKey("OTHER", "")).toBe("OTHER:");
  });
});

// ============================================================================
// generateSponsorshipCode
// ============================================================================

describe("generateSponsorshipCode", () => {
  it("produces SP- + 8 chars from the allowed charset", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateSponsorshipCode();
      expect(code).toMatch(/^SP-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
      expect(code).not.toMatch(/[OIL01]/);
    }
  });
});

// ============================================================================
// calculateApplicableAmount (shared math, re-exported)
// ============================================================================

describe("calculateApplicableAmount", () => {
  const reg = {
    totalAmount: 500,
    baseAmount: 100,
    accessTypeIds: ["acc1", "acc2"],
    priceBreakdown: {
      calculatedBasePrice: 100,
      accessItems: [
        { accessId: "acc1", subtotal: 200 },
        { accessId: "acc2", subtotal: 150 },
      ],
    },
  };

  it("returns 0 with no overlap", () => {
    expect(
      calculateApplicableAmount(
        { coversBasePrice: false, coveredAccessIds: ["other"], totalAmount: 300 },
        reg,
      ),
    ).toBe(0);
  });

  it("applies base price only", () => {
    expect(
      calculateApplicableAmount(
        { coversBasePrice: true, coveredAccessIds: [], totalAmount: 100 },
        reg,
      ),
    ).toBe(100);
  });

  it("applies only overlapping access items", () => {
    expect(
      calculateApplicableAmount(
        { coversBasePrice: false, coveredAccessIds: ["acc1", "zzz"], totalAmount: 999 },
        reg,
      ),
    ).toBe(200);
  });

  it("combines base + access", () => {
    expect(
      calculateApplicableAmount(
        { coversBasePrice: true, coveredAccessIds: ["acc1", "acc2"], totalAmount: 999 },
        reg,
      ),
    ).toBe(450);
  });

  it("caps at registration total", () => {
    expect(
      calculateApplicableAmount(
        { coversBasePrice: true, coveredAccessIds: ["acc1", "acc2"], totalAmount: 999 },
        { ...reg, totalAmount: 300 },
      ),
    ).toBe(300);
  });

  it("caps at sponsorship total", () => {
    expect(
      calculateApplicableAmount(
        { coversBasePrice: true, coveredAccessIds: ["acc1", "acc2"], totalAmount: 120 },
        reg,
      ),
    ).toBe(120);
  });
});

// ============================================================================
// detectCoverageOverlap
// ============================================================================

describe("detectCoverageOverlap", () => {
  const usage = (
    code: string,
    coversBasePrice: boolean,
    coveredAccessIds: string[],
  ): ExistingUsage => ({
    sponsorshipId: `sp-${code}`,
    sponsorship: { code, coversBasePrice, coveredAccessIds },
  });

  it("no overlap → no warnings", () => {
    expect(
      detectCoverageOverlap([usage("SP-A", false, ["x"])], {
        coversBasePrice: false,
        coveredAccessIds: ["y"],
        totalAmount: 100,
      }),
    ).toEqual([]);
  });

  it("base-price overlap warning", () => {
    const w = detectCoverageOverlap([usage("SP-A", true, [])], {
      coversBasePrice: true,
      coveredAccessIds: [],
      totalAmount: 100,
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("Base price is already covered");
  });

  it("access-item overlap warning", () => {
    const w = detectCoverageOverlap([usage("SP-A", false, ["acc1"])], {
      coversBasePrice: false,
      coveredAccessIds: ["acc1"],
      totalAmount: 100,
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("acc1");
  });

  it("multiple simultaneous overlaps", () => {
    const w = detectCoverageOverlap([usage("SP-A", true, ["acc1"])], {
      coversBasePrice: true,
      coveredAccessIds: ["acc1"],
      totalAmount: 100,
    });
    expect(w).toHaveLength(2);
  });
});

// ============================================================================
// calculateTotalSponsorshipAmount / determineSponsorshipStatus
// ============================================================================

describe("calculateTotalSponsorshipAmount", () => {
  it("sums amounts", () => {
    expect(
      calculateTotalSponsorshipAmount([{ amountApplied: 100 }, { amountApplied: 50 }]),
    ).toBe(150);
  });
  it("returns 0 for empty", () => {
    expect(calculateTotalSponsorshipAmount([])).toBe(0);
  });
});

describe("determineSponsorshipStatus", () => {
  it("PENDING when no usages", () => {
    expect(determineSponsorshipStatus({ status: "PENDING" }, 0)).toBe("PENDING");
  });
  it("USED when has usages", () => {
    expect(determineSponsorshipStatus({ status: "PENDING" }, 2)).toBe("USED");
  });
  it("CANCELLED stays CANCELLED even with usages", () => {
    expect(determineSponsorshipStatus({ status: "CANCELLED" }, 3)).toBe("CANCELLED");
  });
  it("USED downgrades to PENDING when usages hit 0", () => {
    expect(determineSponsorshipStatus({ status: "USED" }, 0)).toBe("PENDING");
  });
});
