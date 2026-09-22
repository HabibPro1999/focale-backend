import { describe, expect, it } from "vitest";
import { UpdateNetworkingConfigSchema } from "./networking";
describe("UpdateNetworkingConfigSchema", () => {
  it("does not inject defaults into partial updates", () => {
    expect(UpdateNetworkingConfigSchema.parse({})).toEqual({});
    expect(UpdateNetworkingConfigSchema.parse({ requireSecondFactor: true })).toEqual({ requireSecondFactor: true });
    expect(UpdateNetworkingConfigSchema.parse({ requireSecondFactor: true, expectedRevision: "version" })).toEqual({ requireSecondFactor: true, expectedRevision: "version" });
  });
  it("accepts revision metadata but still rejects unknown keys and invalid values", () => {
    expect(UpdateNetworkingConfigSchema.parse({ revision: "ignored" })).toEqual({ revision: "ignored" });
    expect(UpdateNetworkingConfigSchema.safeParse({ unknown: true }).success).toBe(false);
    expect(UpdateNetworkingConfigSchema.safeParse({ requireSecondFactor: "yes" }).success).toBe(false);
  });
});
