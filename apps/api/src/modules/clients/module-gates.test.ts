import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpException } from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";

vi.mock("@app/db", () => ({
  findClientModuleState: vi.fn(),
  clientExists: vi.fn(),
}));

import { findClientModuleState } from "@app/db";
import {
  assertClientModuleEnabled,
  assertModuleEnabledForClient,
  isModuleEnabledForClient,
} from "./module-gates";

const findState = vi.mocked(findClientModuleState);

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
): Promise<void> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    expect(e.getStatus()).toBe(status);
    const body = e.getResponse() as { code: string; message: string };
    expect(body.code).toBe(code);
    if (message) expect(body.message).toBe(message);
  }
}

describe("client module gates", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("assertModuleEnabledForClient", () => {
    it("passes when active and the module is enabled", () => {
      expect(() =>
        assertModuleEnabledForClient(
          { active: true, enabledModules: ["pricing"] },
          "pricing",
        ),
      ).not.toThrow();
    });

    it("throws 'Client is inactive' when inactive", () => {
      try {
        assertModuleEnabledForClient(
          { active: false, enabledModules: ["pricing"] },
          "pricing",
        );
        throw new Error("expected throw");
      } catch (err) {
        const e = err as HttpException;
        expect(e.getStatus()).toBe(403);
        expect((e.getResponse() as { message: string }).message).toBe(
          "Client is inactive",
        );
      }
    });

    it("throws a module-disabled message when the module is missing", () => {
      try {
        assertModuleEnabledForClient(
          { active: true, enabledModules: ["registrations"] },
          "pricing",
        );
        throw new Error("expected throw");
      } catch (err) {
        expect((( err as HttpException).getResponse() as { message: string }).message).toBe(
          "Pricing module is disabled for this client",
        );
      }
    });

    it("does not crash when enabledModules is null", () => {
      try {
        assertModuleEnabledForClient(
          { active: true, enabledModules: null },
          "pricing",
        );
        throw new Error("expected throw");
      } catch (err) {
        expect((( err as HttpException).getResponse() as { message: string }).message).toBe(
          "Pricing module is disabled for this client",
        );
      }
    });
  });

  describe("isModuleEnabledForClient", () => {
    it("true when active and listed", () => {
      expect(
        isModuleEnabledForClient({ active: true, enabledModules: ["pricing"] }, "pricing"),
      ).toBe(true);
    });

    it("false when not listed", () => {
      expect(
        isModuleEnabledForClient({ active: true, enabledModules: ["registrations"] }, "pricing"),
      ).toBe(false);
    });

    it("false when inactive even if listed", () => {
      expect(
        isModuleEnabledForClient({ active: false, enabledModules: ["pricing"] }, "pricing"),
      ).toBe(false);
    });

    it("false for null client or null enabledModules", () => {
      expect(isModuleEnabledForClient(null, "pricing")).toBe(false);
      expect(
        isModuleEnabledForClient({ active: true, enabledModules: null }, "pricing"),
      ).toBe(false);
    });
  });

  describe("assertClientModuleEnabled", () => {
    it("loads state then passes when enabled", async () => {
      findState.mockResolvedValue({ active: true, enabledModules: ["abstracts"] });
      await expect(
        assertClientModuleEnabled("client-1", "abstracts"),
      ).resolves.toBeUndefined();
      expect(findState).toHaveBeenCalledWith("client-1");
    });

    it("throws 404 when the client is not found", async () => {
      findState.mockResolvedValue(null);
      await expectHttpError(
        assertClientModuleEnabled("missing", "pricing"),
        404,
        ErrorCodes.NOT_FOUND,
      );
    });

    it("throws 403 'Client is inactive' when inactive", async () => {
      findState.mockResolvedValue({ active: false, enabledModules: ["pricing"] });
      await expectHttpError(
        assertClientModuleEnabled("client-1", "pricing"),
        403,
        ErrorCodes.FORBIDDEN,
        "Client is inactive",
      );
    });

    it("throws 403 when the module is disabled", async () => {
      findState.mockResolvedValue({ active: true, enabledModules: ["registrations"] });
      await expectHttpError(
        assertClientModuleEnabled("client-1", "pricing"),
        403,
        ErrorCodes.FORBIDDEN,
      );
    });
  });
});
