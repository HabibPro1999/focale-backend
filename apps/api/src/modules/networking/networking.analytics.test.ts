import { describe, expect, it } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
import type { NetworkingTableUsageSources } from "@app/db";
import { networkingTableUsage } from "./networking.analytics";

/**
 * Table occupancy is the one analytics figure computed in TypeScript (the
 * inventory policy decides each meeting's station). Every other figure is an
 * SQL aggregate: `networking.analytics.db.test.ts` holds them to the pre-4.9
 * calculator and to these definitions on a real database.
 */
const event = { startDate: new Date("2030-05-01T00:00:00Z"), endDate: new Date("2030-05-03T00:00:00Z") };
// One opening hour, 00:00–01:00 in Tunis (23:00–00:00 UTC): 12 five-minute quanta.
const config = NetworkingConfigSchema.parse({
  timezone: "Africa/Tunis",
  openingHours: [{ date: "2030-05-02", start: "00:00", end: "01:00" }],
});
const table = (id: string, overrides: Partial<NetworkingTableUsageSources["tables"][number]> = {}) => ({
  id, name: id, location: "Zone A", kind: "TABLE" as const, active: true, spaceId: null, ownerProfileId: null, ...overrides,
});
const meeting = (id: string, tableId: string, requesterId: string, recipientId: string, standTableId: string | null = null) => ({
  id,
  tableId,
  startsAt: new Date("2030-05-01T23:00:00Z"),
  endsAt: new Date("2030-05-01T23:30:00Z"),
  requester: { id: requesterId, standTableId: null },
  recipient: { id: recipientId, standTableId },
});

describe("networking table usage", () => {
  it("uses the same current inventory in the occupancy numerator and denominator", () => {
    const usage = networkingTableUsage({
      tables: [table("active"), table("inactive", { active: false, location: "Zone B" })],
      spaces: [],
      representatives: [],
      meetings: [meeting("current", "active", "a", "b"), meeting("old", "inactive", "a", "b")],
    }, config, event);
    expect(usage.find((row) => row.tableId === "active")).toMatchObject({ availableMinutes: 60, occupiedMinutes: 30, occupancyRate: 0.5, meetings: 1 });
    expect(usage.find((row) => row.tableId === "inactive")).toMatchObject({ active: false, availableMinutes: 0, occupiedMinutes: 0, meetings: 1 });
  });

  it("counts one independent meeting station for each exhibitor representative", () => {
    const usage = networkingTableUsage({
      tables: [table("stand", { kind: "STAND", ownerProfileId: "a" })],
      spaces: [],
      representatives: [{ id: "a", standTableId: "stand" }, { id: "b", standTableId: "stand" }],
      meetings: [meeting("first", "stand", "visitor-a", "a", "stand"), meeting("second", "stand", "visitor-b", "b", "stand")],
    }, config, event);
    expect(usage[0]).toMatchObject({ availableMinutes: 120, occupiedMinutes: 60, occupancyRate: 0.5, meetings: 2 });
  });

  it("offers no station in an inactive space, and none at a stand without an active representative", () => {
    const usage = networkingTableUsage({
      tables: [table("closed-space", { spaceId: "hall" }), table("stand", { kind: "STAND", ownerProfileId: "gone" })],
      spaces: [{ id: "hall", active: false }],
      representatives: [],
      meetings: [meeting("m", "stand", "visitor", "gone", "stand")],
    }, config, event);
    expect(usage.map((row) => [row.tableId, row.availableMinutes, row.occupiedMinutes])).toEqual([
      ["closed-space", 0, 0],
      ["stand", 0, 0],
    ]);
  });

  it("leaves a meeting with an unlisted participant out of the occupied minutes", () => {
    const usage = networkingTableUsage({
      tables: [table("t")],
      spaces: [],
      representatives: [],
      meetings: [{ ...meeting("m", "t", "a", "b"), recipient: null }],
    }, config, event);
    expect(usage[0]).toMatchObject({ availableMinutes: 60, occupiedMinutes: 0, meetings: 1 });
  });
});
