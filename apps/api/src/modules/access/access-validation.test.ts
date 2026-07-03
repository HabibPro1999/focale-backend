import { describe, expect, it } from "vitest";
import type { EventAccessWithPrereqIds } from "@app/db";
import type { AccessSelection } from "@app/contracts";
import { validateSelections } from "./access-validation";

const NOW = new Date("2025-06-01T10:00:00Z");

function access(
  o: Partial<EventAccessWithPrereqIds> & { id: string },
): EventAccessWithPrereqIds {
  return {
    eventId: "event-123",
    type: "WORKSHOP",
    name: "Access",
    description: null,
    location: null,
    startsAt: null,
    endsAt: null,
    price: 0,
    currency: "TND",
    maxCapacity: null,
    registeredCount: 0,
    paidCount: 0,
    availableFrom: null,
    availableTo: null,
    conditions: null,
    conditionLogic: "AND",
    sortOrder: 0,
    active: true,
    groupLabel: null,
    allowCompanion: false,
    includedInBase: false,
    companionPrice: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    requiredAccess: [],
    ...o,
  } as EventAccessWithPrereqIds;
}

const sel = (accessId: string, quantity = 1): AccessSelection => ({ accessId, quantity });

describe("validateSelections", () => {
  it("is valid for empty selections (still runs mandatory-included check)", () => {
    const result = validateSelections([], [], [], {}, undefined, NOW);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("flags a mandatory includedInBase item that is not selected", () => {
    const result = validateSelections(
      [],
      [{ id: "inc", name: "Lunch", conditions: null, conditionLogic: "AND" }],
      [],
      {},
      undefined,
      NOW,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("est inclus");
  });

  it("validates that all selected items exist", () => {
    const result = validateSelections(
      [access({ id: "access-1" })],
      [],
      [sel("access-1"), sel("non-existent")],
      {},
      undefined,
      NOW,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("not found"))).toBe(true);
  });

  it("detects time conflicts within the same type", () => {
    const start = new Date("2025-06-01T09:00:00Z");
    const end = new Date("2025-06-01T12:00:00Z");
    const result = validateSelections(
      [
        access({ id: "ws-1", name: "A", startsAt: start, endsAt: end }),
        access({ id: "ws-2", name: "B", startsAt: start, endsAt: end }),
      ],
      [],
      [sel("ws-1"), sel("ws-2")],
      {},
      undefined,
      NOW,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Time conflict"))).toBe(true);
  });

  it("allows the same time across different types", () => {
    const t = new Date("2025-06-01T09:00:00Z");
    const result = validateSelections(
      [
        access({ id: "ws", type: "WORKSHOP", startsAt: t }),
        access({ id: "se", type: "SESSION", startsAt: t }),
      ],
      [],
      [sel("ws"), sel("se")],
      {},
      undefined,
      NOW,
    );
    expect(result.valid).toBe(true);
  });

  it("requires prerequisites to be selected", () => {
    const items = [
      access({ id: "basic", name: "Basic" }),
      access({ id: "adv", name: "Advanced", requiredAccess: [{ id: "basic" }] }),
    ];
    expect(
      validateSelections(items, [], [sel("adv")], {}, undefined, NOW).errors.some((e) =>
        e.includes("prerequisite"),
      ),
    ).toBe(true);
    expect(
      validateSelections(items, [], [sel("basic"), sel("adv")], {}, undefined, NOW).valid,
    ).toBe(true);
  });

  it("validates date availability windows", () => {
    const notYet = validateSelections(
      [access({ id: "not-yet", availableFrom: new Date("2025-06-05T00:00:00Z") })],
      [],
      [sel("not-yet")],
      {},
      undefined,
      NOW,
    );
    expect(notYet.errors.some((e) => e.includes("not yet available"))).toBe(true);

    const expired = validateSelections(
      [access({ id: "expired", availableTo: new Date("2025-05-31T00:00:00Z") })],
      [],
      [sel("expired")],
      {},
      undefined,
      NOW,
    );
    expect(expired.errors.some((e) => e.includes("no longer available"))).toBe(true);
  });

  it("validates form-based conditions", () => {
    const result = validateSelections(
      [
        access({
          id: "doc",
          name: "Medical",
          conditions: [{ fieldId: "profession", operator: "equals", value: "doctor" }],
        }),
      ],
      [],
      [sel("doc")],
      { profession: "nurse" },
      undefined,
      NOW,
    );
    expect(result.errors.some((e) => e.includes("form answers"))).toBe(true);
  });

  it("does not reject empty OR condition arrays", () => {
    const result = validateSelections(
      [access({ id: "free", conditionLogic: "OR", conditions: [] })],
      [],
      [sel("free")],
      {},
      undefined,
      NOW,
    );
    expect(result.valid).toBe(true);
  });

  it("validates capacity based on paidCount", () => {
    const result = validateSelections(
      [access({ id: "limited", maxCapacity: 10, paidCount: 9 })],
      [],
      [sel("limited", 2)],
      {},
      undefined,
      NOW,
    );
    expect(result.errors.some((e) => e.includes("full"))).toBe(true);
  });

  it("passes when all checks succeed", () => {
    const result = validateSelections(
      [access({ id: "ok", maxCapacity: 50, paidCount: 10 })],
      [],
      [sel("ok")],
      {},
      undefined,
      NOW,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("handles AND / OR condition logic", () => {
    const andItem = access({
      id: "and",
      conditionLogic: "AND",
      conditions: [
        { fieldId: "profession", operator: "equals", value: "doctor" },
        { fieldId: "specialty", operator: "equals", value: "cardiology" },
      ],
    });
    expect(
      validateSelections([andItem], [], [sel("and")], { profession: "doctor", specialty: "neuro" }, undefined, NOW).valid,
    ).toBe(false);
    expect(
      validateSelections([andItem], [], [sel("and")], { profession: "doctor", specialty: "cardiology" }, undefined, NOW).valid,
    ).toBe(true);

    const orItem = access({
      id: "or",
      conditionLogic: "OR",
      conditions: [
        { fieldId: "profession", operator: "equals", value: "doctor" },
        { fieldId: "profession", operator: "equals", value: "nurse" },
      ],
    });
    expect(
      validateSelections([orItem], [], [sel("or")], { profession: "nurse" }, undefined, NOW).valid,
    ).toBe(true);
  });

  it("grandfathers existing inactive items but still enforces conditions", () => {
    const item = access({ id: "old", active: false });
    // Not grandfathered → inactive error.
    expect(
      validateSelections([item], [], [sel("old")], {}, undefined, NOW).errors.some((e) =>
        e.includes("inactive"),
      ),
    ).toBe(true);
    // Grandfathered → passes.
    expect(
      validateSelections([item], [], [sel("old")], {}, new Set(["old"]), NOW).valid,
    ).toBe(true);
  });
});
