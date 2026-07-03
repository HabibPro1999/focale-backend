import { describe, expect, it } from "vitest";
import type { EventAccessWithPrereqIds } from "@app/db";
import { groupAccess } from "./access-grouping";

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

type Item = { id: string; type: string; spotsRemaining: number | null; isFull: boolean };
function scheduled(result: ReturnType<typeof groupAccess>): Item[] {
  return result.groups.flatMap((g) => g.slots.flatMap((s) => s.items as Item[]));
}

describe("groupAccess", () => {
  it("returns empty groups when no active access", () => {
    expect(groupAccess([], {}, [], NOW).groups).toHaveLength(0);
  });

  it("groups items by date", () => {
    const result = groupAccess(
      [
        access({ id: "ws-1", type: "WORKSHOP", startsAt: new Date("2025-06-01T09:00:00Z") }),
        access({ id: "d-1", type: "DINNER", startsAt: new Date("2025-06-02T19:00:00Z") }),
      ],
      {},
      [],
      NOW,
    );
    expect(result.groups).toHaveLength(2);
    const items = scheduled(result);
    expect(items.filter((i) => i.type === "WORKSHOP")).toHaveLength(1);
    expect(items.filter((i) => i.type === "DINNER")).toHaveLength(1);
  });

  it("creates time slots within a date group", () => {
    const slot1 = new Date("2025-06-01T09:00:00Z");
    const slot2 = new Date("2025-06-01T14:00:00Z");
    const result = groupAccess(
      [
        access({ id: "ws-1", startsAt: slot1 }),
        access({ id: "ws-2", startsAt: slot1 }),
        access({ id: "ws-3", startsAt: slot2 }),
      ],
      {},
      [],
      NOW,
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].slots).toHaveLength(2);
  });

  it("selectionType is single for 2+ parallel items, multiple for one", () => {
    const t = new Date("2025-06-01T09:00:00Z");
    const single = groupAccess(
      [access({ id: "ws-1", startsAt: t }), access({ id: "ws-2", startsAt: t })],
      {},
      [],
      NOW,
    );
    expect(single.groups[0].slots[0].selectionType).toBe("single");

    const multiple = groupAccess([access({ id: "ws-1", startsAt: t })], {}, [], NOW);
    expect(multiple.groups[0].slots[0].selectionType).toBe("multiple");
  });

  it("filters items by availability window", () => {
    const result = groupAccess(
      [
        access({ id: "available", startsAt: new Date("2025-06-01T09:00:00Z") }),
        access({ id: "not-yet", availableFrom: new Date("2025-06-02T00:00:00Z") }),
        access({ id: "expired", availableTo: new Date("2025-05-31T00:00:00Z") }),
      ],
      {},
      [],
      NOW,
    );
    const items = scheduled(result);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("available");
  });

  it("filters items by form-based conditions", () => {
    const items = [
      access({
        id: "for-doctors",
        startsAt: new Date("2025-06-01T09:00:00Z"),
        conditions: [{ fieldId: "profession", operator: "equals", value: "doctor" }],
      }),
      access({ id: "for-everyone", startsAt: new Date("2025-06-01T09:00:00Z"), conditions: null }),
    ];
    expect(scheduled(groupAccess(items, { profession: "doctor" }, [], NOW))).toHaveLength(2);
    expect(scheduled(groupAccess(items, { profession: "nurse" }, [], NOW))).toHaveLength(1);
  });

  it("treats an empty conditions array as condition-free", () => {
    const result = groupAccess(
      [access({ id: "condition-free", conditionLogic: "OR", conditions: [] })],
      {},
      [],
      NOW,
    );
    expect(scheduled(result).map((i) => i.id)).toEqual(["condition-free"]);
  });

  it("filters items by access prerequisites", () => {
    const items = [
      access({ id: "basic", type: "SESSION" }),
      access({ id: "advanced", type: "WORKSHOP", requiredAccess: [{ id: "basic" }] }),
    ];
    expect(
      scheduled(groupAccess(items, {}, [], NOW)).filter((i) => i.type === "WORKSHOP"),
    ).toHaveLength(0);
    expect(
      scheduled(groupAccess(items, {}, ["basic"], NOW)).filter((i) => i.type === "WORKSHOP"),
    ).toHaveLength(1);
  });

  it("annotates spotsRemaining/isFull without removing full items", () => {
    const result = groupAccess(
      [
        access({ id: "full", maxCapacity: 10, paidCount: 10 }),
        access({ id: "open", maxCapacity: 20, paidCount: 5 }),
        access({ id: "unlimited", maxCapacity: null, paidCount: 100 }),
      ],
      {},
      [],
      NOW,
    );
    const items = scheduled(result);
    const full = items.find((i) => i.id === "full");
    expect(full?.isFull).toBe(true);
    expect(full?.spotsRemaining).toBe(0);
    const open = items.find((i) => i.id === "open");
    expect(open?.spotsRemaining).toBe(15);
    expect(open?.isFull).toBe(false);
    const unlimited = items.find((i) => i.id === "unlimited");
    expect(unlimited?.spotsRemaining).toBeNull();
    expect(unlimited?.isFull).toBe(false);
  });

  it("keeps full addon items in the addonGroup", () => {
    const result = groupAccess(
      [
        access({
          id: "full-ws",
          type: "WORKSHOP",
          maxCapacity: 5,
          paidCount: 5,
          startsAt: new Date("2025-06-01T09:00:00Z"),
        }),
        access({ id: "full-addon", type: "ADDON", maxCapacity: 1, paidCount: 1 }),
        access({
          id: "open-ws",
          type: "WORKSHOP",
          maxCapacity: 10,
          paidCount: 3,
          startsAt: new Date("2025-06-01T09:00:00Z"),
        }),
      ],
      {},
      [],
      NOW,
    );
    const items = scheduled(result);
    expect(items.find((i) => i.id === "full-ws")).toBeDefined();
    expect(items.find((i) => i.id === "open-ws")).toBeDefined();
    expect(result.addonGroup).not.toBeNull();
    expect(result.addonGroup?.items).toHaveLength(1);
  });

  it("includes OTHER type items in date groups", () => {
    const result = groupAccess(
      [
        access({
          id: "excursion",
          type: "OTHER",
          name: "City Tour",
          groupLabel: "Excursions",
          startsAt: new Date("2025-06-01T10:00:00Z"),
        }),
      ],
      {},
      [],
      NOW,
    );
    expect(result.groups).toHaveLength(1);
    const items = scheduled(result);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("OTHER");
  });

  it("orders date groups chronologically", () => {
    const result = groupAccess(
      [
        access({ id: "d3", type: "OTHER", startsAt: new Date("2025-06-03T10:00:00Z") }),
        access({ id: "d1", type: "SESSION", startsAt: new Date("2025-06-01T10:00:00Z") }),
        access({ id: "d2", type: "WORKSHOP", startsAt: new Date("2025-06-02T10:00:00Z") }),
      ],
      {},
      [],
      NOW,
    );
    expect(result.groups).toHaveLength(3);
    expect(result.groups[0].dateKey).toBe("2025-06-01");
    expect(result.groups[1].dateKey).toBe("2025-06-02");
    expect(result.groups[2].dateKey).toBe("2025-06-03");
  });
});
