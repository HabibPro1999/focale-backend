import { describe, expect, it } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { createMockClient } from "../../../tests/helpers/factories.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import {
  assertClientModuleEnabled,
  assertModuleEnabledForClient,
  isModuleEnabledForClient,
} from "./module-gates.js";

describe("client module gates", () => {
  describe("assertModuleEnabledForClient", () => {
    it("passes when the client is active and module is enabled", () => {
      const client = createMockClient({
        active: true,
        enabledModules: ["pricing"],
      });

      expect(() =>
        assertModuleEnabledForClient(client, "pricing"),
      ).not.toThrow();
    });

    it("throws when the client is inactive", () => {
      const client = createMockClient({
        active: false,
        enabledModules: ["pricing"],
      });

      expect(() => assertModuleEnabledForClient(client, "pricing")).toThrow(
        AppError,
      );
      expect(() => assertModuleEnabledForClient(client, "pricing")).toThrow(
        "Client is inactive",
      );
    });

    it("throws when the module is disabled", () => {
      const client = createMockClient({
        active: true,
        enabledModules: ["registrations"],
      });

      expect(() => assertModuleEnabledForClient(client, "pricing")).toThrow(
        AppError,
      );
      expect(() => assertModuleEnabledForClient(client, "pricing")).toThrow(
        "Pricing module is disabled for this client",
      );
    });

    it("throws cleanly when enabled modules are missing", () => {
      const client = {
        active: true,
        enabledModules: null,
      };

      expect(() => assertModuleEnabledForClient(client, "pricing")).toThrow(
        AppError,
      );
      expect(() => assertModuleEnabledForClient(client, "pricing")).toThrow(
        "Pricing module is disabled for this client",
      );
    });
  });

  describe("isModuleEnabledForClient", () => {
    it("returns true when the client is active and the module is listed", () => {
      const client = createMockClient({
        active: true,
        enabledModules: ["pricing"],
      });

      expect(isModuleEnabledForClient(client, "pricing")).toBe(true);
    });

    it("returns false when the module is not listed", () => {
      const client = createMockClient({
        active: true,
        enabledModules: ["registrations"],
      });

      expect(isModuleEnabledForClient(client, "pricing")).toBe(false);
    });

    it("returns false for inactive clients even when the module is listed", () => {
      const client = createMockClient({
        active: false,
        enabledModules: ["pricing"],
      });

      expect(isModuleEnabledForClient(client, "pricing")).toBe(false);
    });

    it("returns false for null clients or null enabled modules", () => {
      expect(isModuleEnabledForClient(null, "pricing")).toBe(false);
      expect(
        isModuleEnabledForClient(
          { active: true, enabledModules: null },
          "pricing",
        ),
      ).toBe(false);
    });
  });

  describe("assertClientModuleEnabled", () => {
    it("loads active state and enabled modules before checking", async () => {
      const client = createMockClient({
        id: "client-1",
        active: true,
        enabledModules: ["abstracts"],
      });
      prismaMock.client.findUnique.mockResolvedValue(client);

      await expect(
        assertClientModuleEnabled("client-1", "abstracts"),
      ).resolves.toBeUndefined();
      expect(prismaMock.client.findUnique).toHaveBeenCalledWith({
        where: { id: "client-1" },
        select: { id: true, active: true, enabledModules: true },
      });
    });

    it("throws not found when the client does not exist", async () => {
      prismaMock.client.findUnique.mockResolvedValue(null);

      await expect(
        assertClientModuleEnabled("missing-client", "pricing"),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it("throws forbidden when the client is inactive", async () => {
      prismaMock.client.findUnique.mockResolvedValue(
        createMockClient({
          active: false,
          enabledModules: ["pricing"],
        }),
      );

      await expect(
        assertClientModuleEnabled("client-1", "pricing"),
      ).rejects.toMatchObject({
        statusCode: 403,
        code: ErrorCodes.FORBIDDEN,
        message: "Client is inactive",
      });
    });

    it("throws forbidden when the module is disabled", async () => {
      prismaMock.client.findUnique.mockResolvedValue(
        createMockClient({
          active: true,
          enabledModules: ["registrations"],
        }),
      );

      await expect(
        assertClientModuleEnabled("client-1", "pricing"),
      ).rejects.toMatchObject({
        statusCode: 403,
        code: ErrorCodes.FORBIDDEN,
      });
    });
  });
});
