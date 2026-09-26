import { describe, expect, it } from "vitest";
import { PriceBreakdownSchema } from "./pricing";
import { checkStoredJson } from "./stored-json";

// The stored `registrations.price_breakdown` document (plan 5.2b). The shapes
// below are every shape a registration writer has stored, legacy and current
// (from the git history of the writers); each must be a valid stored document
// as it is, so reading it under JSONB_VALIDATION=enforce refuses nothing and
// parsing it changes nothing.

const line = { accessId: "a1", name: "Workshop", unitPrice: 100, quantity: 2, subtotal: 150 };

const priced = {
  basePrice: 200,
  appliedRules: [{ ruleId: "r1", ruleName: "Members", effect: -50, reason: "Base price set to 150" }],
  calculatedBasePrice: 150,
  accessItems: [line],
  accessTotal: 150,
  subtotal: 300,
  sponsorships: [
    { code: "SP-1", amount: 50, valid: true },
    { code: "typo", amount: 0, valid: false },
  ],
  sponsorshipTotal: 50,
  total: 250,
  currency: "TND",
};

const afterDrop = { accessItems: [], accessTotal: 0, subtotal: 150, sponsorshipTotal: 50, total: 100 };

const storedShapes: Array<[string, unknown]> = [
  ["admin create, edit or repricing: the pricing output", { ...priced, droppedAccessItems: [] }],
  [
    "public signup: lines marked confirmed",
    { ...priced, accessItems: [{ ...line, status: "confirmed" }], droppedAccessItems: [] },
  ],
  ["created before dropped items were recorded (April 2026): no droppedAccessItems", priced],
  [
    "an item dropped when its capacity filled",
    { ...priced, ...afterDrop, droppedAccessItems: [{ ...line, status: "confirmed", reason: "capacity_reached" }] },
  ],
  [
    "an item dropped when it was deactivated",
    { ...priced, ...afterDrop, droppedAccessItems: [{ ...line, reason: "deactivated" }] },
  ],
  [
    "a free registration",
    {
      ...priced,
      basePrice: 0,
      appliedRules: [],
      calculatedBasePrice: 0,
      accessItems: [],
      accessTotal: 0,
      subtotal: 0,
      sponsorships: [],
      sponsorshipTotal: 0,
      total: 0,
    },
  ],
];

describe("PriceBreakdownSchema as the stored registrations.price_breakdown document", () => {
  it.each(storedShapes)("accepts %s, unchanged", (_shape, document) => {
    expect(checkStoredJson(PriceBreakdownSchema, document)).toEqual([]);
    expect(PriceBreakdownSchema.parse(document)).toEqual(document);
  });

  it("reports what no writer stores, by path and code", () => {
    expect(checkStoredJson(PriceBreakdownSchema, { ...priced, discount: 10 })).toEqual([
      { path: "discount", code: "stripped_key" },
    ]);
    expect(
      checkStoredJson(PriceBreakdownSchema, {
        ...priced,
        droppedAccessItems: [{ ...line, reason: "refunded" }],
      }),
    ).toEqual([{ path: "droppedAccessItems[0].reason", code: "invalid_value" }]);
    expect(
      checkStoredJson(PriceBreakdownSchema, { ...priced, accessItems: [{ ...line, status: "pending" }] }),
    ).toEqual([{ path: "accessItems[0].status", code: "invalid_value" }]);
    expect(
      checkStoredJson(PriceBreakdownSchema, { ...priced, accessItems: [{ ...line, name: null }] }),
    ).toEqual([{ path: "accessItems[0].name", code: "invalid_type" }]);
  });

  it("reports an empty document (dev seeds and test factories) as missing every field", () => {
    const issues = checkStoredJson(PriceBreakdownSchema, {});
    expect(issues.map((issue) => issue.path).sort()).toEqual(
      [
        "accessItems",
        "accessTotal",
        "appliedRules",
        "basePrice",
        "calculatedBasePrice",
        "currency",
        "sponsorshipTotal",
        "sponsorships",
        "subtotal",
        "total",
      ].sort(),
    );
    expect(new Set(issues.map((issue) => issue.code))).toEqual(new Set(["invalid_type"]));
  });
});
