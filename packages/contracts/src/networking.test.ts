import { describe, expect, it } from "vitest";
import { NetworkingAdminProfileUpdateSchema, NetworkingParticipantListQuerySchema as schema, NetworkingProfileUpdateSchema, NetworkingSpaceSchema, NetworkingSpaceUpdateSchema, NetworkingTableSchema, NetworkingTableUpdateSchema, UpdateNetworkingConfigSchema } from "./networking";
describe("UpdateNetworkingConfigSchema", () => {
  it("does not inject defaults into partial updates", () => {
    expect(UpdateNetworkingConfigSchema.parse({})).toEqual({});
    expect(UpdateNetworkingConfigSchema.parse({ requireSecondFactor: true })).toEqual({ requireSecondFactor: true });
    expect(UpdateNetworkingConfigSchema.parse({ requireSecondFactor: true, expectedRevision: "version" })).toEqual({ requireSecondFactor: true, expectedRevision: "version" });
  });
  it("rejects a stray read-only revision, unknown keys and invalid values", () => {
    expect(UpdateNetworkingConfigSchema.safeParse({ revision: "ignored" }).success).toBe(false);
    expect(UpdateNetworkingConfigSchema.safeParse({ unknown: true }).success).toBe(false);
    expect(UpdateNetworkingConfigSchema.safeParse({ requireSecondFactor: "yes" }).success).toBe(false);
  });
});

describe("inventory PATCH schemas", () => {
  it("keeps empty patches empty", () => {
    expect(NetworkingSpaceUpdateSchema.parse({})).toEqual({});
    expect(NetworkingTableUpdateSchema.parse({})).toEqual({});
  });
  it("preserves inactive status and location on a capacity-only space patch", () => {
    const existing = { name: "Space", kind: "STAND", capacity: 5, active: false, location: "Hall B" };
    const patch = NetworkingSpaceUpdateSchema.parse({ capacity: 10 });
    expect(patch).toEqual({ capacity: 10 });
    expect({ ...existing, ...patch }).toEqual({ ...existing, capacity: 10 });
  });
  it("renames a STAND without injecting kind, capacity, active, or location", () => {
    const existing = { name: "Stand", kind: "STAND", capacity: 2, active: false, location: "Hall B" };
    const patch = NetworkingTableUpdateSchema.parse({ name: "Renamed" });
    expect(patch).toEqual({ name: "Renamed" });
    expect({ ...existing, ...patch }).toEqual({ ...existing, name: "Renamed" });
  });
  it("still rejects unknown fields, invalid objects and invalid field types", () => {
    for (const schema of [NetworkingSpaceUpdateSchema, NetworkingTableUpdateSchema]) {
      for (const input of [null, [], "invalid", { unknown: true }, { active: "false" }, { capacity: "2" }, { kind: "OTHER" }, { location: 1 }]) {
        expect(schema.safeParse(input).success).toBe(false);
      }
    }
  });
  it("preserves create defaults", () => {
    expect(NetworkingSpaceSchema.parse({ name: "Space", kind: "TABLE", capacity: 10 })).toEqual({
      name: "Space", kind: "TABLE", capacity: 10, location: "", active: true,
    });
    const spaceId = "123e4567-e89b-42d3-a456-426614174000";
    expect(NetworkingTableSchema.parse({ spaceId, name: "Table" })).toEqual({
      spaceId, name: "Table", capacity: 2, location: "", active: true, kind: "TABLE",
    });
  });
});

it("participant pagination preserves opt-in, validates limits and bounds opaque cursors", async () => {
  expect(schema.parse({})).toEqual({});
  expect(schema.parse({ limit: "200" })).toEqual({ limit: 200 });
  expect(schema.parse({ cursor: "opaque" })).toEqual({ cursor: "opaque" });
  for (const limit of ["", "no", "1.5", "0", "201", -1, null]) expect(schema.safeParse({ limit }).success).toBe(false);
  for (const cursor of ["", "x".repeat(2049), "not base64!", ["a"], null]) expect(schema.safeParse({ cursor }).success).toBe(false);
});

it.each([
  ["participant", NetworkingProfileUpdateSchema],
  ["admin", NetworkingAdminProfileUpdateSchema],
] as const)("%s profile PATCH can only remove a photo, never point it at an arbitrary URL", (_label, profile) => {
  expect(profile.parse({ photoUrl: null })).toEqual({ photoUrl: null });
  for (const photoUrl of ["https://storage.example/networking/other/profiles/x/photo.webp", "https://evil.example/a.webp", ""])
    expect(profile.safeParse({ photoUrl }).success).toBe(false);
});
