import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpException } from "@nestjs/common";
import { ErrorCodes, DEFAULT_ENABLED_MODULES } from "@app/contracts";

vi.mock("@app/db", () => ({
  insertClient: vi.fn(),
  getClientById: vi.fn(),
  updateClientRow: vi.fn(),
  listClientsPage: vi.fn(),
  deleteClientRow: vi.fn(),
  getClientDeletionInfo: vi.fn(),
}));

vi.mock("../../core/auth/user-cache", () => ({
  invalidateUserCacheForClient: vi.fn().mockResolvedValue(undefined),
}));

import {
  insertClient,
  getClientById,
  updateClientRow,
  listClientsPage,
  deleteClientRow,
  getClientDeletionInfo,
  type ClientRow,
} from "@app/db";
import { invalidateUserCacheForClient } from "../../core/auth/user-cache";
import { ClientsService } from "./clients.service";

const ALL_MODULE_IDS = [...DEFAULT_ENABLED_MODULES];

const db = {
  insertClient: vi.mocked(insertClient),
  getClientById: vi.mocked(getClientById),
  updateClientRow: vi.mocked(updateClientRow),
  listClientsPage: vi.mocked(listClientsPage),
  deleteClientRow: vi.mocked(deleteClientRow),
  getClientDeletionInfo: vi.mocked(getClientDeletionInfo),
};
const invalidate = vi.mocked(invalidateUserCacheForClient);

function makeClient(overrides: Partial<ClientRow> = {}): ClientRow {
  return {
    id: "client-123",
    name: "Test Company",
    logo: null,
    primaryColor: null,
    email: null,
    phone: null,
    active: true,
    enabledModules: ALL_MODULE_IDS,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error("expected the promise to reject");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    expect(e.getStatus()).toBe(status);
    expect((e.getResponse() as { code: string }).code).toBe(code);
  }
}

describe("ClientsService", () => {
  const service = new ClientsService();
  const clientId = "client-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("create", () => {
    it("defaults optional fields to null and modules to the full set", async () => {
      db.insertClient.mockResolvedValue(makeClient({ enabledModules: ALL_MODULE_IDS }));

      const result = await service.create({ name: "Test Company" });

      expect(result.name).toBe("Test Company");
      expect(db.insertClient).toHaveBeenCalledWith({
        name: "Test Company",
        logo: null,
        primaryColor: null,
        email: null,
        phone: null,
        enabledModules: ALL_MODULE_IDS,
      });
    });

    it("includes abstracts in the default module set", async () => {
      db.insertClient.mockResolvedValue(makeClient());
      await service.create({ name: "X" });
      expect(ALL_MODULE_IDS).toContain("abstracts");
      expect(db.insertClient.mock.calls[0][0].enabledModules).toContain("abstracts");
    });

    it("passes explicit optional fields through", async () => {
      db.insertClient.mockResolvedValue(
        makeClient({
          logo: "https://example.com/logo.png",
          primaryColor: "#FF5733",
          email: "contact@example.com",
          phone: "+216 12 345 678",
          enabledModules: ["pricing", "registrations"],
        }),
      );

      await service.create({
        name: "Full Client",
        logo: "https://example.com/logo.png",
        primaryColor: "#FF5733",
        email: "contact@example.com",
        phone: "+216 12 345 678",
        enabledModules: ["pricing", "registrations"],
      });

      expect(db.insertClient).toHaveBeenCalledWith({
        name: "Full Client",
        logo: "https://example.com/logo.png",
        primaryColor: "#FF5733",
        email: "contact@example.com",
        phone: "+216 12 345 678",
        enabledModules: ["pricing", "registrations"],
      });
    });

    it("keeps explicit nulls as null", async () => {
      db.insertClient.mockResolvedValue(makeClient());
      await service.create({
        name: "Nullable",
        logo: null,
        primaryColor: null,
        email: null,
        phone: null,
      });
      expect(db.insertClient).toHaveBeenCalledWith(
        expect.objectContaining({
          logo: null,
          primaryColor: null,
          email: null,
          phone: null,
        }),
      );
    });
  });

  describe("getById", () => {
    it("returns the row when found", async () => {
      const row = makeClient({ name: "Found" });
      db.getClientById.mockResolvedValue(row);
      await expect(service.getById(clientId)).resolves.toBe(row);
    });

    it("returns null when not found", async () => {
      db.getClientById.mockResolvedValue(null);
      await expect(service.getById("missing")).resolves.toBeNull();
    });
  });

  describe("update", () => {
    it("passes only the provided keys and invalidates the cache", async () => {
      db.getClientById.mockResolvedValue(makeClient({ name: "Old" }));
      db.updateClientRow.mockResolvedValue(makeClient({ name: "New Name" }));

      const result = await service.update(clientId, { name: "New Name" });

      expect(result.name).toBe("New Name");
      expect(db.updateClientRow).toHaveBeenCalledWith(clientId, { name: "New Name" });
      expect(invalidate).toHaveBeenCalledWith(clientId);
    });

    it("invalidates the cache after ANY successful update (not just active flips)", async () => {
      db.getClientById.mockResolvedValue(makeClient());
      db.updateClientRow.mockResolvedValue(makeClient({ name: "Renamed" }));

      await service.update(clientId, { name: "Renamed", active: true });

      expect(invalidate).toHaveBeenCalledWith(clientId);
    });

    it("throws 404 when the client does not exist", async () => {
      db.getClientById.mockResolvedValue(null);
      await expectHttpError(
        service.update("missing", { name: "X" }),
        404,
        ErrorCodes.NOT_FOUND,
      );
    });

    it("replaces enabledModules with the provided list", async () => {
      db.getClientById.mockResolvedValue(makeClient());
      db.updateClientRow.mockResolvedValue(makeClient({ enabledModules: ["sponsorships"] }));

      await service.update(clientId, { enabledModules: ["sponsorships"] });

      expect(db.updateClientRow).toHaveBeenCalledWith(clientId, {
        enabledModules: ["sponsorships"],
      });
    });

    it("persists an empty enabledModules list (disable all)", async () => {
      db.getClientById.mockResolvedValue(makeClient());
      db.updateClientRow.mockResolvedValue(makeClient({ enabledModules: [] }));

      await service.update(clientId, { enabledModules: [] });

      expect(db.updateClientRow).toHaveBeenCalledWith(clientId, {
        enabledModules: [],
      });
    });

    it("dedupes enabledModules before persisting", async () => {
      db.getClientById.mockResolvedValue(makeClient());
      db.updateClientRow.mockResolvedValue(makeClient());

      await service.update(clientId, {
        enabledModules: ["pricing", "emails", "pricing"],
      });

      const modules = db.updateClientRow.mock.calls[0][1].enabledModules as string[];
      expect(modules).toEqual([...new Set(modules)]);
      expect(modules).toEqual(["pricing", "emails"]);
    });

    it("omits enabledModules from the update when not provided", async () => {
      db.getClientById.mockResolvedValue(makeClient());
      db.updateClientRow.mockResolvedValue(makeClient({ name: "Just Name" }));

      await service.update(clientId, { name: "Just Name" });

      expect(db.updateClientRow).toHaveBeenCalledWith(clientId, { name: "Just Name" });
    });

    it("rejects an empty update before any DB round trip", async () => {
      await expectHttpError(service.update(clientId, {}), 400, ErrorCodes.VALIDATION_ERROR);
      expect(db.getClientById).not.toHaveBeenCalled();
      expect(db.updateClientRow).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("computes pagination meta from data + total", async () => {
      db.listClientsPage.mockResolvedValue({
        data: [makeClient(), makeClient(), makeClient()],
        total: 25,
      });

      const result = await service.list({ page: 2, limit: 10 });

      expect(db.listClientsPage).toHaveBeenCalledWith({
        skip: 10,
        limit: 10,
        active: undefined,
        search: undefined,
      });
      expect(result.meta).toMatchObject({
        page: 2,
        limit: 10,
        total: 25,
        totalPages: 3,
        hasNext: true,
        hasPrev: true,
      });
    });

    it("uses skip = (page-1)*limit for large pages", async () => {
      db.listClientsPage.mockResolvedValue({ data: [], total: 5 });
      await service.list({ page: 1000, limit: 10 });
      expect(db.listClientsPage).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 9990 }),
      );
    });

    it("forwards the active filter and search term", async () => {
      db.listClientsPage.mockResolvedValue({ data: [], total: 0 });
      await service.list({ page: 1, limit: 10, active: true, search: "acme" });
      expect(db.listClientsPage).toHaveBeenCalledWith({
        skip: 0,
        limit: 10,
        active: true,
        search: "acme",
      });
    });

    it("returns totalPages 0 when there are no results", async () => {
      db.listClientsPage.mockResolvedValue({ data: [], total: 0 });
      const result = await service.list({ page: 1, limit: 10 });
      expect(result.data).toHaveLength(0);
      expect(result.meta.totalPages).toBe(0);
      expect(result.meta.hasNext).toBe(false);
      expect(result.meta.hasPrev).toBe(false);
    });
  });

  describe("remove", () => {
    it("deletes a client with no dependencies", async () => {
      db.getClientDeletionInfo.mockResolvedValue({ userCount: 0, eventCount: 0 });
      await expect(service.remove(clientId)).resolves.toBeUndefined();
      expect(db.deleteClientRow).toHaveBeenCalledWith(clientId);
    });

    it("throws 404 when the client does not exist", async () => {
      db.getClientDeletionInfo.mockResolvedValue(null);
      await expectHttpError(service.remove("missing"), 404, ErrorCodes.NOT_FOUND);
      expect(db.deleteClientRow).not.toHaveBeenCalled();
    });

    it("blocks (409) when the client has users", async () => {
      db.getClientDeletionInfo.mockResolvedValue({ userCount: 3, eventCount: 0 });
      await expectHttpError(
        service.remove(clientId),
        409,
        ErrorCodes.CLIENT_HAS_DEPENDENCIES,
      );
      expect(db.deleteClientRow).not.toHaveBeenCalled();
    });

    it("blocks (409) when the client has events", async () => {
      db.getClientDeletionInfo.mockResolvedValue({ userCount: 0, eventCount: 5 });
      await expectHttpError(
        service.remove(clientId),
        409,
        ErrorCodes.CLIENT_HAS_DEPENDENCIES,
      );
      expect(db.deleteClientRow).not.toHaveBeenCalled();
    });

    it("interpolates both counts in the 409 message", async () => {
      db.getClientDeletionInfo.mockResolvedValue({ userCount: 2, eventCount: 3 });
      try {
        await service.remove(clientId);
        throw new Error("expected rejection");
      } catch (err) {
        const message = (err as HttpException).getResponse() as { message: string };
        expect(message.message).toMatch(
          /Cannot delete client with 2 user\(s\) and 3 event\(s\)/,
        );
      }
    });
  });
});
