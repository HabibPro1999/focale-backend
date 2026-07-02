import { describe, expect, it } from "vitest";
import {
  CreateClientSchema,
  UpdateClientSchema,
  ListClientsQuerySchema,
  ClientIdParamSchema,
  DEFAULT_ENABLED_MODULES,
  MODULE_IDS,
  normalizeEnabledModules,
} from "./clients";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("client contracts", () => {
  describe("MODULE_IDS / defaults", () => {
    it("has the 6 canonical modules including abstracts", () => {
      expect(MODULE_IDS).toEqual([
        "pricing",
        "registrations",
        "sponsorships",
        "emails",
        "certificates",
        "abstracts",
      ]);
      expect(DEFAULT_ENABLED_MODULES).toContain("abstracts");
    });

    it("dedupes via normalizeEnabledModules", () => {
      expect(normalizeEnabledModules(["pricing", "pricing", "emails"])).toEqual([
        "pricing",
        "emails",
      ]);
    });
  });

  describe("CreateClientSchema", () => {
    it("dedupes enabledModules at parse time", () => {
      const parsed = CreateClientSchema.parse({
        name: "Acme",
        enabledModules: ["pricing", "pricing"],
      });
      expect(parsed.enabledModules).toEqual(["pricing"]);
    });

    it("rejects an empty name", () => {
      expect(CreateClientSchema.safeParse({ name: "" }).success).toBe(false);
    });

    it("rejects unknown keys (strict)", () => {
      expect(
        CreateClientSchema.safeParse({ name: "Acme", nope: 1 }).success,
      ).toBe(false);
    });

    it("rejects a bad primaryColor and accepts a valid hex", () => {
      expect(
        CreateClientSchema.safeParse({ name: "A", primaryColor: "red" }).success,
      ).toBe(false);
      expect(
        CreateClientSchema.safeParse({ name: "A", primaryColor: "#FF5733" }).success,
      ).toBe(true);
    });

    it("rejects a bad url logo and a bad email", () => {
      expect(
        CreateClientSchema.safeParse({ name: "A", logo: "not-a-url" }).success,
      ).toBe(false);
      expect(
        CreateClientSchema.safeParse({ name: "A", email: "not-an-email" }).success,
      ).toBe(false);
    });
  });

  describe("UpdateClientSchema", () => {
    it("rejects an empty object with the refine message", () => {
      const result = UpdateClientSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          "At least one field must be provided for update",
        );
      }
    });

    it("accepts an empty enabledModules list", () => {
      const parsed = UpdateClientSchema.parse({ enabledModules: [] });
      expect(parsed.enabledModules).toEqual([]);
    });

    it("dedupes enabledModules at parse time", () => {
      const parsed = UpdateClientSchema.parse({
        enabledModules: ["pricing", "emails", "pricing"],
      });
      expect(parsed.enabledModules).toEqual(["pricing", "emails"]);
    });
  });

  describe("ListClientsQuerySchema", () => {
    it("coerces strings and applies defaults", () => {
      expect(ListClientsQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
      expect(ListClientsQuerySchema.parse({ page: "3", limit: "50" })).toMatchObject({
        page: 3,
        limit: 50,
      });
    });

    it("transforms active string into a boolean", () => {
      expect(ListClientsQuerySchema.parse({ active: "false" })).toMatchObject({
        active: false,
      });
      expect(ListClientsQuerySchema.parse({ active: "true" })).toMatchObject({
        active: true,
      });
    });

    it("caps limit at 100 and requires page >= 1", () => {
      expect(ListClientsQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
      expect(ListClientsQuerySchema.safeParse({ page: "0" }).success).toBe(false);
    });

    it("allows an empty-string search", () => {
      expect(ListClientsQuerySchema.parse({ search: "" }).search).toBe("");
    });
  });

  describe("ClientIdParamSchema", () => {
    it("requires a uuid", () => {
      expect(ClientIdParamSchema.safeParse({ id: UUID }).success).toBe(true);
      expect(ClientIdParamSchema.safeParse({ id: "not-a-uuid" }).success).toBe(false);
    });
  });
});
