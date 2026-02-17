import { describe, it, expect, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import {
  createMockClient,
  createManyMockClients,
} from "../../../tests/helpers/factories.js";
import {
  createClient,
  getClientById,
  updateClient,
  listClients,
  deleteClient,
  clientExists,
} from "./clients.service.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { MODULE_IDS } from "./clients.schema.js";

// Mock audit and cache utilities
vi.mock("@shared/utils/audit.js", () => ({
  auditLog: vi.fn(),
  diffChanges: vi.fn(() => undefined),
}));

vi.mock("@shared/middleware/module.middleware.js", () => ({
  invalidateClientCache: vi.fn(),
}));

describe("Clients Service", () => {
  const clientId = "client-123";

  describe("createClient", () => {
    it("should create a client with required fields only", async () => {
      const mockClient = createMockClient({
        id: clientId,
        name: "Test Company",
        logo: null,
        primaryColor: null,
        email: null,
        phone: null,
        enabledModules: [...MODULE_IDS],
      });

      prismaMock.client.create.mockResolvedValue(mockClient);

      const result = await createClient({ name: "Test Company" }, "user-123");

      expect(result.id).toBe(clientId);
      expect(result.name).toBe("Test Company");
      expect(result.enabledModules).toEqual([...MODULE_IDS]);
      expect(prismaMock.client.create).toHaveBeenCalledWith({
        data: {
          name: "Test Company",
          logo: null,
          primaryColor: null,
          email: null,
          phone: null,
          enabledModules: [...MODULE_IDS],
        },
      });
    });

    it("should create a client with all optional fields", async () => {
      const mockClient = createMockClient({
        id: clientId,
        name: "Full Client",
        logo: "https://example.com/logo.png",
        primaryColor: "#FF5733",
        email: "contact@example.com",
        phone: "+216 12 345 678",
        enabledModules: ["pricing", "registrations"],
      });

      prismaMock.client.create.mockResolvedValue(mockClient);

      const result = await createClient(
        {
          name: "Full Client",
          logo: "https://example.com/logo.png",
          primaryColor: "#FF5733",
          email: "contact@example.com",
          phone: "+216 12 345 678",
          enabledModules: ["pricing", "registrations"],
        },
        "user-123",
      );

      expect(result.name).toBe("Full Client");
      expect(result.logo).toBe("https://example.com/logo.png");
      expect(result.primaryColor).toBe("#FF5733");
      expect(result.email).toBe("contact@example.com");
      expect(result.phone).toBe("+216 12 345 678");
      expect(result.enabledModules).toEqual(["pricing", "registrations"]);
    });

    it("should default to all modules when enabledModules not provided", async () => {
      const mockClient = createMockClient({
        name: "Default Modules Client",
        enabledModules: [...MODULE_IDS],
      });

      prismaMock.client.create.mockResolvedValue(mockClient);

      await createClient({ name: "Default Modules Client" }, "user-123");

      expect(prismaMock.client.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          enabledModules: [...MODULE_IDS],
        }),
      });
    });

    it("should handle nullable fields correctly", async () => {
      const mockClient = createMockClient({
        name: "Nullable Test",
        logo: null,
        primaryColor: null,
        email: null,
        phone: null,
      });

      prismaMock.client.create.mockResolvedValue(mockClient);

      const result = await createClient(
        {
          name: "Nullable Test",
          logo: null,
          primaryColor: null,
          email: null,
          phone: null,
        },
        "user-123",
      );

      expect(result.logo).toBeNull();
      expect(result.primaryColor).toBeNull();
      expect(result.email).toBeNull();
      expect(result.phone).toBeNull();
    });
  });

  describe("getClientById", () => {
    it("should return client when found", async () => {
      const mockClient = createMockClient({
        id: clientId,
        name: "Found Client",
      });

      prismaMock.client.findUnique.mockResolvedValue(mockClient);

      const result = await getClientById(clientId);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(clientId);
      expect(result?.name).toBe("Found Client");
      expect(prismaMock.client.findUnique).toHaveBeenCalledWith({
        where: { id: clientId },
      });
    });

    it("should return null when client not found", async () => {
      prismaMock.client.findUnique.mockResolvedValue(null);

      const result = await getClientById("non-existent-id");

      expect(result).toBeNull();
    });
  });

  describe("updateClient", () => {
    it("should update client name", async () => {
      const existingClient = createMockClient({
        id: clientId,
        name: "Old Name",
        enabledModules: ["pricing", "registrations"],
      });
      const updatedClient = createMockClient({
        id: clientId,
        name: "New Name",
        enabledModules: ["pricing", "registrations"],
      });

      prismaMock.client.findUnique.mockResolvedValue(existingClient);
      prismaMock.client.update.mockResolvedValue(updatedClient);

      const result = await updateClient(
        clientId,
        { name: "New Name" },
        "user-123",
      );

      expect(result.name).toBe("New Name");
      expect(prismaMock.client.update).toHaveBeenCalledWith({
        where: { id: clientId },
        data: { name: "New Name" },
      });
    });

    it("should update multiple fields at once", async () => {
      const existingClient = createMockClient({
        id: clientId,
        enabledModules: ["pricing"],
      });
      const updatedClient = createMockClient({
        id: clientId,
        name: "Updated Company",
        email: "new@example.com",
        phone: "+216 98 765 432",
        active: false,
        enabledModules: ["pricing"],
      });

      prismaMock.client.findUnique.mockResolvedValue(existingClient);
      prismaMock.client.update.mockResolvedValue(updatedClient);

      const result = await updateClient(
        clientId,
        {
          name: "Updated Company",
          email: "new@example.com",
          phone: "+216 98 765 432",
          active: false,
        },
        "user-123",
      );

      expect(result.name).toBe("Updated Company");
      expect(result.email).toBe("new@example.com");
      expect(result.phone).toBe("+216 98 765 432");
      expect(result.active).toBe(false);
    });

    it("should throw AppError when client not found", async () => {
      prismaMock.client.findUnique.mockResolvedValue(null);

      await expect(
        updateClient("non-existent-id", { name: "New Name" }, "user-123"),
      ).rejects.toThrow(AppError);

      await expect(
        updateClient("non-existent-id", { name: "New Name" }, "user-123"),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    describe("enabledModules one-way enable logic", () => {
      it("should merge new modules with existing modules (union)", async () => {
        const existingClient = createMockClient({
          id: clientId,
          enabledModules: ["pricing", "registrations"],
        });
        const updatedClient = createMockClient({
          id: clientId,
          enabledModules: ["pricing", "registrations", "sponsorships"],
        });

        prismaMock.client.findUnique.mockResolvedValue(existingClient);
        prismaMock.client.update.mockResolvedValue(updatedClient);

        const result = await updateClient(
          clientId,
          {
            enabledModules: ["sponsorships"],
          },
          "user-123",
        );

        // Should contain both existing and new modules
        expect(prismaMock.client.update).toHaveBeenCalledWith({
          where: { id: clientId },
          data: {
            enabledModules: expect.arrayContaining([
              "pricing",
              "registrations",
              "sponsorships",
            ]),
          },
        });
        expect(result.enabledModules).toContain("sponsorships");
      });

      it("should not remove existing modules when updating", async () => {
        const existingClient = createMockClient({
          id: clientId,
          enabledModules: [
            "pricing",
            "registrations",
            "sponsorships",
            "emails",
          ],
        });
        const updatedClient = createMockClient({
          id: clientId,
          enabledModules: [
            "pricing",
            "registrations",
            "sponsorships",
            "emails",
          ],
        });

        prismaMock.client.findUnique.mockResolvedValue(existingClient);
        prismaMock.client.update.mockResolvedValue(updatedClient);

        await updateClient(
          clientId,
          {
            enabledModules: ["pricing"], // Trying to set only pricing
          },
          "user-123",
        );

        // Should still contain all modules (one-way enable)
        expect(prismaMock.client.update).toHaveBeenCalledWith({
          where: { id: clientId },
          data: {
            enabledModules: expect.arrayContaining([
              "pricing",
              "registrations",
              "sponsorships",
              "emails",
            ]),
          },
        });
      });

      it("should handle duplicate modules in update input", async () => {
        const existingClient = createMockClient({
          id: clientId,
          enabledModules: ["pricing"],
        });
        const updatedClient = createMockClient({
          id: clientId,
          enabledModules: ["pricing", "emails"],
        });

        prismaMock.client.findUnique.mockResolvedValue(existingClient);
        prismaMock.client.update.mockResolvedValue(updatedClient);

        await updateClient(
          clientId,
          {
            enabledModules: ["pricing", "emails", "pricing"], // Duplicate pricing
          },
          "user-123",
        );

        // Should deduplicate modules
        const updateCall = prismaMock.client.update.mock.calls[0][0];
        const modules = updateCall.data.enabledModules as string[];
        const uniqueModules = [...new Set(modules)];
        expect(modules.length).toBe(uniqueModules.length);
      });

      it("should not include enabledModules in update if not provided", async () => {
        const existingClient = createMockClient({
          id: clientId,
          enabledModules: ["pricing"],
        });
        const updatedClient = createMockClient({
          id: clientId,
          name: "Just Name Update",
          enabledModules: ["pricing"],
        });

        prismaMock.client.findUnique.mockResolvedValue(existingClient);
        prismaMock.client.update.mockResolvedValue(updatedClient);

        await updateClient(clientId, { name: "Just Name Update" }, "user-123");

        // enabledModules should not be in the update data
        expect(prismaMock.client.update).toHaveBeenCalledWith({
          where: { id: clientId },
          data: { name: "Just Name Update" },
        });
      });
    });
  });

  describe("listClients", () => {
    it("should return paginated clients", async () => {
      const mockClients = createManyMockClients(3);

      prismaMock.client.findMany.mockResolvedValue(mockClients);
      prismaMock.client.count.mockResolvedValue(3);

      const result = await listClients({ page: 1, limit: 10 });

      expect(result.data).toHaveLength(3);
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(10);
      expect(result.meta.total).toBe(3);
      expect(result.meta.totalPages).toBe(1);
    });

    it("should calculate correct pagination for multiple pages", async () => {
      const mockClients = createManyMockClients(10);

      prismaMock.client.findMany.mockResolvedValue(mockClients);
      prismaMock.client.count.mockResolvedValue(25);

      const result = await listClients({ page: 2, limit: 10 });

      expect(result.meta.page).toBe(2);
      expect(result.meta.total).toBe(25);
      expect(result.meta.totalPages).toBe(3);
      expect(prismaMock.client.findMany).toHaveBeenCalledWith({
        where: {},
        skip: 10, // (page 2 - 1) * limit 10
        take: 10,
        orderBy: { createdAt: "desc" },
      });
    });

    it("should filter by active status", async () => {
      const activeClients = createManyMockClients(2).map((c) => ({
        ...c,
        active: true,
      }));

      prismaMock.client.findMany.mockResolvedValue(activeClients);
      prismaMock.client.count.mockResolvedValue(2);

      await listClients({ page: 1, limit: 10, active: true });

      expect(prismaMock.client.findMany).toHaveBeenCalledWith({
        where: { active: true },
        skip: 0,
        take: 10,
        orderBy: { createdAt: "desc" },
      });
    });

    it("should filter inactive clients", async () => {
      const inactiveClients = createManyMockClients(1).map((c) => ({
        ...c,
        active: false,
      }));

      prismaMock.client.findMany.mockResolvedValue(inactiveClients);
      prismaMock.client.count.mockResolvedValue(1);

      await listClients({ page: 1, limit: 10, active: false });

      expect(prismaMock.client.findMany).toHaveBeenCalledWith({
        where: { active: false },
        skip: 0,
        take: 10,
        orderBy: { createdAt: "desc" },
      });
    });

    it("should search by name (case-insensitive)", async () => {
      const mockClient = createMockClient({ name: "Acme Corporation" });

      prismaMock.client.findMany.mockResolvedValue([mockClient]);
      prismaMock.client.count.mockResolvedValue(1);

      await listClients({ page: 1, limit: 10, search: "acme" });

      expect(prismaMock.client.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { name: { contains: "acme", mode: "insensitive" } },
            { email: { contains: "acme", mode: "insensitive" } },
          ],
        },
        skip: 0,
        take: 10,
        orderBy: { createdAt: "desc" },
      });
    });

    it("should search by email (case-insensitive)", async () => {
      const mockClient = createMockClient({ email: "contact@acme.com" });

      prismaMock.client.findMany.mockResolvedValue([mockClient]);
      prismaMock.client.count.mockResolvedValue(1);

      await listClients({ page: 1, limit: 10, search: "acme.com" });

      expect(prismaMock.client.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { name: { contains: "acme.com", mode: "insensitive" } },
            { email: { contains: "acme.com", mode: "insensitive" } },
          ],
        },
        skip: 0,
        take: 10,
        orderBy: { createdAt: "desc" },
      });
    });

    it("should combine active filter and search", async () => {
      const mockClient = createMockClient({
        name: "Active Acme",
        active: true,
      });

      prismaMock.client.findMany.mockResolvedValue([mockClient]);
      prismaMock.client.count.mockResolvedValue(1);

      await listClients({ page: 1, limit: 10, active: true, search: "acme" });

      expect(prismaMock.client.findMany).toHaveBeenCalledWith({
        where: {
          active: true,
          OR: [
            { name: { contains: "acme", mode: "insensitive" } },
            { email: { contains: "acme", mode: "insensitive" } },
          ],
        },
        skip: 0,
        take: 10,
        orderBy: { createdAt: "desc" },
      });
    });

    it("should return empty results when no clients match", async () => {
      prismaMock.client.findMany.mockResolvedValue([]);
      prismaMock.client.count.mockResolvedValue(0);

      const result = await listClients({
        page: 1,
        limit: 10,
        search: "nonexistent",
      });

      expect(result.data).toHaveLength(0);
      expect(result.meta.total).toBe(0);
      expect(result.meta.totalPages).toBe(0);
    });

    it("should order by createdAt descending", async () => {
      const mockClients = createManyMockClients(3);

      prismaMock.client.findMany.mockResolvedValue(mockClients);
      prismaMock.client.count.mockResolvedValue(3);

      await listClients({ page: 1, limit: 10 });

      expect(prismaMock.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: "desc" },
        }),
      );
    });
  });

  describe("deleteClient", () => {
    it("should delete client with no dependencies", async () => {
      const mockClient = {
        ...createMockClient({ id: clientId }),
        _count: { users: 0, events: 0 },
      };

      prismaMock.client.findUnique.mockResolvedValue(mockClient as never);
      prismaMock.client.delete.mockResolvedValue(mockClient as never);

      await expect(deleteClient(clientId, "user-123")).resolves.toBeUndefined();

      expect(prismaMock.client.delete).toHaveBeenCalledWith({
        where: { id: clientId },
      });
    });

    it("should throw AppError when client not found", async () => {
      prismaMock.client.findUnique.mockResolvedValue(null);

      await expect(deleteClient("non-existent-id", "user-123")).rejects.toThrow(
        AppError,
      );

      await expect(
        deleteClient("non-existent-id", "user-123"),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it("should throw when client has associated users", async () => {
      const mockClientWithUsers = {
        ...createMockClient({ id: clientId }),
        _count: { users: 3, events: 0 },
      };

      prismaMock.client.findUnique.mockResolvedValue(
        mockClientWithUsers as never,
      );

      await expect(deleteClient(clientId, "user-123")).rejects.toThrow(
        AppError,
      );

      await expect(deleteClient(clientId, "user-123")).rejects.toMatchObject({
        statusCode: 409,
        code: ErrorCodes.CLIENT_HAS_DEPENDENCIES,
      });

      expect(prismaMock.client.delete).not.toHaveBeenCalled();
    });

    it("should throw when client has associated events", async () => {
      const mockClientWithEvents = {
        ...createMockClient({ id: clientId }),
        _count: { users: 0, events: 5 },
      };

      prismaMock.client.findUnique.mockResolvedValue(
        mockClientWithEvents as never,
      );

      await expect(deleteClient(clientId, "user-123")).rejects.toThrow(
        AppError,
      );

      await expect(deleteClient(clientId, "user-123")).rejects.toMatchObject({
        statusCode: 409,
        code: ErrorCodes.CLIENT_HAS_DEPENDENCIES,
      });

      expect(prismaMock.client.delete).not.toHaveBeenCalled();
    });

    it("should throw when client has both users and events", async () => {
      const mockClientWithDependencies = {
        ...createMockClient({ id: clientId }),
        _count: { users: 2, events: 3 },
      };

      prismaMock.client.findUnique.mockResolvedValue(
        mockClientWithDependencies as never,
      );

      await expect(deleteClient(clientId, "user-123")).rejects.toThrow(
        /Cannot delete client with 2 user\(s\) and 3 event\(s\)/,
      );
    });

    it("should include _count in findUnique query", async () => {
      const mockClient = {
        ...createMockClient({ id: clientId }),
        _count: { users: 0, events: 0 },
      };

      prismaMock.client.findUnique.mockResolvedValue(mockClient as never);
      prismaMock.client.delete.mockResolvedValue(mockClient as never);

      await deleteClient(clientId, "user-123");

      expect(prismaMock.client.findUnique).toHaveBeenCalledWith({
        where: { id: clientId },
        include: {
          _count: {
            select: {
              users: true,
              events: true,
            },
          },
        },
      });
    });
  });

  describe("clientExists", () => {
    it("should return true when client exists", async () => {
      prismaMock.client.count.mockResolvedValue(1);

      const result = await clientExists(clientId);

      expect(result).toBe(true);
      expect(prismaMock.client.count).toHaveBeenCalledWith({
        where: { id: clientId },
      });
    });

    it("should return false when client does not exist", async () => {
      prismaMock.client.count.mockResolvedValue(0);

      const result = await clientExists("non-existent-id");

      expect(result).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle empty string search gracefully", async () => {
      prismaMock.client.findMany.mockResolvedValue([]);
      prismaMock.client.count.mockResolvedValue(0);

      // Empty string is falsy, so OR clause should not be added
      await listClients({ page: 1, limit: 10, search: "" });

      expect(prismaMock.client.findMany).toHaveBeenCalledWith({
        where: {},
        skip: 0,
        take: 10,
        orderBy: { createdAt: "desc" },
      });
    });

    it("should handle special characters in search", async () => {
      prismaMock.client.findMany.mockResolvedValue([]);
      prismaMock.client.count.mockResolvedValue(0);

      await listClients({ page: 1, limit: 10, search: "test@company.com" });

      expect(prismaMock.client.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { name: { contains: "test@company.com", mode: "insensitive" } },
            { email: { contains: "test@company.com", mode: "insensitive" } },
          ],
        },
        skip: 0,
        take: 10,
        orderBy: { createdAt: "desc" },
      });
    });

    it("should handle very large page numbers", async () => {
      prismaMock.client.findMany.mockResolvedValue([]);
      prismaMock.client.count.mockResolvedValue(5);

      const result = await listClients({ page: 1000, limit: 10 });

      expect(result.data).toHaveLength(0);
      expect(prismaMock.client.findMany).toHaveBeenCalledWith({
        where: {},
        skip: 9990, // (1000 - 1) * 10
        take: 10,
        orderBy: { createdAt: "desc" },
      });
    });

    it("should handle updating client with empty input object", async () => {
      const existingClient = createMockClient({ id: clientId });
      const updatedClient = createMockClient({ id: clientId });

      prismaMock.client.findUnique.mockResolvedValue(existingClient);
      prismaMock.client.update.mockResolvedValue(updatedClient);

      await updateClient(clientId, {}, "user-123");

      expect(prismaMock.client.update).toHaveBeenCalledWith({
        where: { id: clientId },
        data: {},
      });
    });
  });
});
