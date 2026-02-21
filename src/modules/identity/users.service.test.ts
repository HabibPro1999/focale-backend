import { describe, it, expect, vi, beforeEach } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { firebaseAuthMock } from "../../../tests/mocks/firebase.js";
import {
  createMockUser,
  createMockSuperAdmin,
  createMockClientAdmin,
  createMockClient,
  UserRole,
} from "../../../tests/helpers/factories.js";
import {
  createUser,
  getUserById,
  updateUser,
  listUsers,
  deleteUser,
} from "./users.service.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

// Mock the clients module
vi.mock("@clients", () => ({
  clientExists: vi.fn(),
}));

// Mock the auth middleware
vi.mock("@shared/middleware/auth.middleware.js", () => ({
  invalidateUserCache: vi.fn(),
}));

// Import the mocked functions
import { clientExists } from "@clients";
import { invalidateUserCache } from "@shared/middleware/auth.middleware.js";
const clientExistsMock = vi.mocked(clientExists);
const invalidateUserCacheMock = vi.mocked(invalidateUserCache);

describe("Users Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================================
  // createUser
  // ============================================================================
  describe("createUser", () => {
    const validClientAdminInput = {
      email: "test@example.com",
      password: "password123",
      name: "Test User",
      role: UserRole.CLIENT_ADMIN,
      clientId: "client-123",
    };

    const validSuperAdminInput = {
      email: "admin@example.com",
      password: "password123",
      name: "Super Admin",
      role: UserRole.SUPER_ADMIN,
      clientId: null,
    };

    it("should create a CLIENT_ADMIN user with valid client", async () => {
      const expectedUser = createMockClientAdmin("client-123", {
        id: "firebase-uid",
        email: validClientAdminInput.email,
        name: validClientAdminInput.name,
      });

      prismaMock.user.findUnique.mockResolvedValue(null); // No existing user
      clientExistsMock.mockResolvedValue(true);
      firebaseAuthMock.createUser.mockResolvedValue({ uid: "firebase-uid" });
      firebaseAuthMock.setCustomUserClaims.mockResolvedValue(undefined);
      prismaMock.user.create.mockResolvedValue(expectedUser);

      const result = await createUser(validClientAdminInput);

      expect(result).toEqual(expectedUser);
      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { email: validClientAdminInput.email },
      });
      expect(clientExistsMock).toHaveBeenCalledWith("client-123");
      expect(firebaseAuthMock.createUser).toHaveBeenCalledWith(
        validClientAdminInput.email,
        validClientAdminInput.password,
      );
      expect(firebaseAuthMock.setCustomUserClaims).toHaveBeenCalledWith(
        "firebase-uid",
        {
          role: UserRole.CLIENT_ADMIN,
          clientId: "client-123",
        },
      );
      expect(prismaMock.user.create).toHaveBeenCalledWith({
        data: {
          id: "firebase-uid",
          email: validClientAdminInput.email,
          name: validClientAdminInput.name,
          role: UserRole.CLIENT_ADMIN,
          clientId: "client-123",
        },
      });
    });

    it("should create a SUPER_ADMIN user without client", async () => {
      const expectedUser = createMockSuperAdmin({
        id: "firebase-uid",
        email: validSuperAdminInput.email,
        name: validSuperAdminInput.name,
      });

      prismaMock.user.findUnique.mockResolvedValue(null);
      firebaseAuthMock.createUser.mockResolvedValue({ uid: "firebase-uid" });
      firebaseAuthMock.setCustomUserClaims.mockResolvedValue(undefined);
      prismaMock.user.create.mockResolvedValue(expectedUser);

      const result = await createUser(validSuperAdminInput);

      expect(result).toEqual(expectedUser);
      expect(clientExistsMock).not.toHaveBeenCalled(); // No client validation for super admin
      expect(firebaseAuthMock.setCustomUserClaims).toHaveBeenCalledWith(
        "firebase-uid",
        {
          role: UserRole.SUPER_ADMIN,
          clientId: null,
        },
      );
    });

    it("should throw CONFLICT error if email already exists", async () => {
      const existingUser = createMockUser({
        email: validClientAdminInput.email,
      });
      prismaMock.user.findUnique.mockResolvedValue(existingUser);

      await expect(createUser(validClientAdminInput)).rejects.toThrow(AppError);
      await expect(createUser(validClientAdminInput)).rejects.toMatchObject({
        statusCode: 409,
        code: ErrorCodes.CONFLICT,
      });

      expect(firebaseAuthMock.createUser).not.toHaveBeenCalled();
    });

    it("should throw VALIDATION_ERROR if CLIENT_ADMIN without clientId", async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      const invalidInput = {
        ...validClientAdminInput,
        clientId: undefined,
      };

      await expect(createUser(invalidInput)).rejects.toThrow(AppError);
      await expect(createUser(invalidInput)).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
    });

    it("should throw VALIDATION_ERROR if SUPER_ADMIN with clientId", async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      const invalidInput = {
        ...validSuperAdminInput,
        clientId: "client-123",
      };

      await expect(createUser(invalidInput)).rejects.toThrow(AppError);
      await expect(createUser(invalidInput)).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
    });

    it("should throw BAD_REQUEST if clientId does not exist", async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      clientExistsMock.mockResolvedValue(false);

      await expect(createUser(validClientAdminInput)).rejects.toThrow(AppError);
      await expect(createUser(validClientAdminInput)).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.BAD_REQUEST,
      });
    });

    it("should propagate database errors during user creation", async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);
      clientExistsMock.mockResolvedValue(true);
      firebaseAuthMock.createUser.mockResolvedValue({ uid: "firebase-uid" });
      firebaseAuthMock.setCustomUserClaims.mockResolvedValue(undefined);
      firebaseAuthMock.deleteUser.mockResolvedValue(undefined);
      const dbError = new Error("Database error");
      prismaMock.user.create.mockRejectedValue(dbError);

      await expect(createUser(validClientAdminInput)).rejects.toThrow(
        "Database error",
      );

      // Verify Firebase user was deleted during rollback
      expect(firebaseAuthMock.deleteUser).toHaveBeenCalledWith("firebase-uid");
    });
  });

  // ============================================================================
  // getUserById
  // ============================================================================
  describe("getUserById", () => {
    it("should return user with client when found", async () => {
      const mockClient = createMockClient({ id: "client-123" });
      const mockUser = createMockClientAdmin("client-123", { id: "user-123" });
      const userWithClient = { ...mockUser, client: mockClient };

      prismaMock.user.findUnique.mockResolvedValue(userWithClient);

      const result = await getUserById("user-123");

      expect(result).toEqual(userWithClient);
      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { id: "user-123" },
        include: { client: true },
      });
    });

    it("should return user with null client for SUPER_ADMIN", async () => {
      const mockUser = createMockSuperAdmin({ id: "admin-123" });
      const userWithClient = { ...mockUser, client: null };

      prismaMock.user.findUnique.mockResolvedValue(userWithClient);

      const result = await getUserById("admin-123");

      expect(result).toEqual(userWithClient);
      expect(result?.client).toBeNull();
    });

    it("should return null when user not found", async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      const result = await getUserById("non-existent-id");

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // updateUser
  // ============================================================================
  describe("updateUser", () => {
    it("should update user name", async () => {
      const existingUser = createMockUser({ id: "user-123", name: "Old Name" });
      const mockClient = createMockClient({ id: existingUser.clientId! });
      const updatedUser = {
        ...existingUser,
        name: "New Name",
        client: mockClient,
      };

      prismaMock.user.findUnique.mockResolvedValue(existingUser);
      prismaMock.user.update.mockResolvedValue(updatedUser);

      const result = await updateUser("user-123", { name: "New Name" });

      expect(result.name).toBe("New Name");
      expect(prismaMock.user.update).toHaveBeenCalledWith({
        where: { id: "user-123" },
        data: { name: "New Name" },
        include: { client: true },
      });
    });

    it("should update user role and sync Firebase claims", async () => {
      const existingUser = createMockClientAdmin("client-123", {
        id: "user-123",
      });
      const updatedUser = {
        ...existingUser,
        role: UserRole.SUPER_ADMIN,
        clientId: null,
        client: null,
      };

      prismaMock.user.findUnique.mockResolvedValue(existingUser);
      firebaseAuthMock.setCustomUserClaims.mockResolvedValue(undefined);
      prismaMock.user.update.mockResolvedValue(updatedUser);

      const result = await updateUser("user-123", {
        role: UserRole.SUPER_ADMIN,
        clientId: null,
      });

      expect(result.role).toBe(UserRole.SUPER_ADMIN);
      expect(firebaseAuthMock.setCustomUserClaims).toHaveBeenCalledWith(
        "user-123",
        {
          role: UserRole.SUPER_ADMIN,
          clientId: null,
        },
      );
    });

    it("should update clientId and sync Firebase claims", async () => {
      const existingUser = createMockClientAdmin("client-123", {
        id: "user-123",
      });
      const newClient = createMockClient({ id: "client-456" });
      const updatedUser = {
        ...existingUser,
        clientId: "client-456",
        client: newClient,
      };

      prismaMock.user.findUnique.mockResolvedValue(existingUser);
      clientExistsMock.mockResolvedValue(true);
      firebaseAuthMock.setCustomUserClaims.mockResolvedValue(undefined);
      prismaMock.user.update.mockResolvedValue(updatedUser);

      const result = await updateUser("user-123", { clientId: "client-456" });

      expect(result.clientId).toBe("client-456");
      expect(clientExistsMock).toHaveBeenCalledWith("client-456");
      expect(firebaseAuthMock.setCustomUserClaims).toHaveBeenCalledWith(
        "user-123",
        {
          role: UserRole.CLIENT_ADMIN,
          clientId: "client-456",
        },
      );
    });

    it("should update active status without syncing Firebase claims", async () => {
      const existingUser = createMockUser({ id: "user-123", active: true });
      const mockClient = createMockClient({ id: existingUser.clientId! });
      const updatedUser = {
        ...existingUser,
        active: false,
        client: mockClient,
      };

      prismaMock.user.findUnique.mockResolvedValue(existingUser);
      prismaMock.user.update.mockResolvedValue(updatedUser);

      const result = await updateUser("user-123", { active: false });

      expect(result.active).toBe(false);
      // Should NOT sync Firebase claims when only active status changes
      expect(firebaseAuthMock.setCustomUserClaims).not.toHaveBeenCalled();
    });

    it("should throw NOT_FOUND when user does not exist", async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      await expect(
        updateUser("non-existent", { name: "New Name" }),
      ).rejects.toThrow(AppError);
      await expect(
        updateUser("non-existent", { name: "New Name" }),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it("should throw BAD_REQUEST when clientId does not exist", async () => {
      const existingUser = createMockUser({ id: "user-123" });
      prismaMock.user.findUnique.mockResolvedValue(existingUser);
      clientExistsMock.mockResolvedValue(false);

      await expect(
        updateUser("user-123", { clientId: "invalid-client" }),
      ).rejects.toThrow(AppError);
      await expect(
        updateUser("user-123", { clientId: "invalid-client" }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.BAD_REQUEST,
      });
    });

    // Cache invalidation tests
    it("should invalidate user cache after successful update", async () => {
      const existingUser = createMockUser({ id: "user-123", name: "Old Name" });
      const mockClient = createMockClient({ id: existingUser.clientId! });
      const updatedUser = {
        ...existingUser,
        name: "New Name",
        client: mockClient,
      };

      prismaMock.user.findUnique.mockResolvedValue(existingUser);
      prismaMock.user.update.mockResolvedValue(updatedUser);

      await updateUser("user-123", { name: "New Name" });

      expect(invalidateUserCacheMock).toHaveBeenCalledWith("user-123");
    });

    it("should invalidate user cache after successful delete", async () => {
      const existingUser = createMockUser({ id: "user-123" });

      prismaMock.user.findUnique.mockResolvedValue(existingUser);
      firebaseAuthMock.deleteUser.mockResolvedValue(undefined);
      prismaMock.user.delete.mockResolvedValue(existingUser);

      await deleteUser("user-123", "requesting-user-123");

      expect(invalidateUserCacheMock).toHaveBeenCalledWith("user-123");
    });

    // Role-clientId consistency in updateUser
    it("should throw VALIDATION_ERROR when updating to CLIENT_ADMIN without clientId", async () => {
      const existingUser = createMockSuperAdmin({ id: "admin-123" });
      prismaMock.user.findUnique.mockResolvedValue(existingUser);

      await expect(
        updateUser("admin-123", { role: UserRole.CLIENT_ADMIN }),
      ).rejects.toThrow(AppError);
      await expect(
        updateUser("admin-123", { role: UserRole.CLIENT_ADMIN }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
    });

    it("should throw VALIDATION_ERROR when updating to SUPER_ADMIN with clientId", async () => {
      const existingUser = createMockClientAdmin("client-123", {
        id: "user-123",
      });
      prismaMock.user.findUnique.mockResolvedValue(existingUser);

      await expect(
        updateUser("user-123", { role: UserRole.SUPER_ADMIN }),
      ).rejects.toThrow(AppError);
      await expect(
        updateUser("user-123", { role: UserRole.SUPER_ADMIN }),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
      // Note: user has clientId='client-123', and role is being set to SUPER_ADMIN
      // Effective: role=SUPER_ADMIN, clientId='client-123' -> should fail
    });
  });

  // ============================================================================
  // listUsers
  // ============================================================================
  describe("listUsers", () => {
    it("should return paginated users with default pagination", async () => {
      const mockUsers = [
        { ...createMockUser({ id: "user-1" }), client: createMockClient() },
        { ...createMockUser({ id: "user-2" }), client: createMockClient() },
      ];

      prismaMock.user.findMany.mockResolvedValue(mockUsers);
      prismaMock.user.count.mockResolvedValue(2);

      const result = await listUsers({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(2);
      expect(result.meta).toEqual({
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      });
      expect(prismaMock.user.findMany).toHaveBeenCalledWith({
        where: {},
        skip: 0,
        take: 20,
        orderBy: { createdAt: "desc" },
        include: { client: true },
      });
    });

    it("should filter by role", async () => {
      const superAdmins = [
        { ...createMockSuperAdmin({ id: "admin-1" }), client: null },
        { ...createMockSuperAdmin({ id: "admin-2" }), client: null },
      ];

      prismaMock.user.findMany.mockResolvedValue(superAdmins);
      prismaMock.user.count.mockResolvedValue(2);

      const result = await listUsers({
        page: 1,
        limit: 20,
        role: UserRole.SUPER_ADMIN,
      });

      expect(result.data).toHaveLength(2);
      expect(prismaMock.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { role: UserRole.SUPER_ADMIN },
        }),
      );
    });

    it("should filter by clientId", async () => {
      const clientUsers = [
        {
          ...createMockClientAdmin("client-123", { id: "user-1" }),
          client: createMockClient({ id: "client-123" }),
        },
      ];

      prismaMock.user.findMany.mockResolvedValue(clientUsers);
      prismaMock.user.count.mockResolvedValue(1);

      const result = await listUsers({
        page: 1,
        limit: 20,
        clientId: "client-123",
      });

      expect(result.data).toHaveLength(1);
      expect(prismaMock.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { clientId: "client-123" },
        }),
      );
    });

    it("should filter by active status", async () => {
      const activeUsers = [
        {
          ...createMockUser({ id: "user-1", active: true }),
          client: createMockClient(),
        },
      ];

      prismaMock.user.findMany.mockResolvedValue(activeUsers);
      prismaMock.user.count.mockResolvedValue(1);

      const result = await listUsers({ page: 1, limit: 20, active: true });

      expect(result.data).toHaveLength(1);
      expect(prismaMock.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { active: true },
        }),
      );
    });

    it("should search by name or email", async () => {
      const searchResults = [
        {
          ...createMockUser({
            id: "user-1",
            name: "John Doe",
            email: "john@example.com",
          }),
          client: createMockClient(),
        },
      ];

      prismaMock.user.findMany.mockResolvedValue(searchResults);
      prismaMock.user.count.mockResolvedValue(1);

      const result = await listUsers({ page: 1, limit: 20, search: "john" });

      expect(result.data).toHaveLength(1);
      expect(prismaMock.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { name: { contains: "john", mode: "insensitive" } },
              { email: { contains: "john", mode: "insensitive" } },
            ],
          },
        }),
      );
    });

    it("should handle pagination correctly", async () => {
      const mockUsers = Array.from({ length: 5 }, (_, i) => ({
        ...createMockUser({ id: `user-${i + 1}` }),
        client: createMockClient(),
      }));

      prismaMock.user.findMany.mockResolvedValue(mockUsers);
      prismaMock.user.count.mockResolvedValue(25); // 25 total, 5 per page

      const result = await listUsers({ page: 2, limit: 5 });

      expect(result.data).toHaveLength(5);
      expect(result.meta).toEqual({
        page: 2,
        limit: 5,
        total: 25,
        totalPages: 5,
        hasNext: true,
        hasPrev: true,
      });
      expect(prismaMock.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 5, // (page 2 - 1) * limit 5
          take: 5,
        }),
      );
    });

    it("should return empty result when no users match", async () => {
      prismaMock.user.findMany.mockResolvedValue([]);
      prismaMock.user.count.mockResolvedValue(0);

      const result = await listUsers({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(0);
      expect(result.meta.total).toBe(0);
      expect(result.meta.totalPages).toBe(0);
    });

    it("should combine multiple filters", async () => {
      prismaMock.user.findMany.mockResolvedValue([]);
      prismaMock.user.count.mockResolvedValue(0);

      await listUsers({
        page: 1,
        limit: 20,
        role: UserRole.CLIENT_ADMIN,
        clientId: "client-123",
        active: true,
        search: "test",
      });

      expect(prismaMock.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            role: UserRole.CLIENT_ADMIN,
            clientId: "client-123",
            active: true,
            OR: [
              { name: { contains: "test", mode: "insensitive" } },
              { email: { contains: "test", mode: "insensitive" } },
            ],
          },
        }),
      );
    });
  });

  // ============================================================================
  // deleteUser
  // ============================================================================
  describe("deleteUser", () => {
    it("should delete user from Firebase and database", async () => {
      const existingUser = createMockUser({ id: "user-123" });

      prismaMock.user.findUnique.mockResolvedValue(existingUser);
      prismaMock.user.delete.mockResolvedValue(existingUser);
      firebaseAuthMock.deleteUser.mockResolvedValue(undefined);

      await deleteUser("user-123", "requesting-user-456");

      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { id: "user-123" },
      });
      expect(prismaMock.user.delete).toHaveBeenCalledWith({
        where: { id: "user-123" },
      });
      expect(firebaseAuthMock.deleteUser).toHaveBeenCalledWith("user-123");
    });

    it("should throw NOT_FOUND when user does not exist", async () => {
      prismaMock.user.findUnique.mockResolvedValue(null);

      await expect(
        deleteUser("non-existent", "requesting-user-456"),
      ).rejects.toThrow(AppError);
      await expect(
        deleteUser("non-existent", "requesting-user-456"),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });

      expect(firebaseAuthMock.deleteUser).not.toHaveBeenCalled();
      expect(prismaMock.user.delete).not.toHaveBeenCalled();
    });

    it("should throw BAD_REQUEST when trying to delete own account", async () => {
      const existingUser = createMockUser({ id: "user-123" });
      prismaMock.user.findUnique.mockResolvedValue(existingUser);

      await expect(deleteUser("user-123", "user-123")).rejects.toThrow(
        AppError,
      );
      await expect(deleteUser("user-123", "user-123")).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.BAD_REQUEST,
        message: "Cannot delete your own account",
      });

      expect(prismaMock.user.delete).not.toHaveBeenCalled();
      expect(firebaseAuthMock.deleteUser).not.toHaveBeenCalled();
    });

    it("should throw BAD_REQUEST when deleting last super admin", async () => {
      const superAdmin = createMockSuperAdmin({ id: "admin-123" });

      prismaMock.user.findUnique.mockResolvedValue(superAdmin);
      prismaMock.user.count.mockResolvedValue(1); // Only one super admin

      await expect(
        deleteUser("admin-123", "requesting-user-456"),
      ).rejects.toThrow(AppError);
      await expect(
        deleteUser("admin-123", "requesting-user-456"),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.BAD_REQUEST,
        message: "Cannot delete the last super admin",
      });

      expect(prismaMock.user.delete).not.toHaveBeenCalled();
      expect(firebaseAuthMock.deleteUser).not.toHaveBeenCalled();
    });

    it("should delete super admin when there are multiple", async () => {
      const superAdmin = createMockSuperAdmin({ id: "admin-123" });

      prismaMock.user.findUnique.mockResolvedValue(superAdmin);
      prismaMock.user.count.mockResolvedValue(2); // Multiple super admins
      prismaMock.user.delete.mockResolvedValue(superAdmin);
      firebaseAuthMock.deleteUser.mockResolvedValue(undefined);

      await deleteUser("admin-123", "requesting-user-456");

      expect(prismaMock.user.delete).toHaveBeenCalledWith({
        where: { id: "admin-123" },
      });
      expect(firebaseAuthMock.deleteUser).toHaveBeenCalledWith("admin-123");
    });

    it("should reject deletion if count drops to 1 inside the transaction (TOCTOU guard)", async () => {
      // Simulates: initial check sees 2 super admins, but by the time the
      // transaction re-counts, a concurrent delete has reduced it to 1.
      const superAdmin = createMockSuperAdmin({ id: "admin-123" });

      prismaMock.user.findUnique.mockResolvedValue(superAdmin);
      // The transaction re-count sees 1 — the concurrent delete has already run.
      prismaMock.user.count.mockResolvedValue(1);

      await expect(
        deleteUser("admin-123", "requesting-user-456"),
      ).rejects.toThrow(AppError);
      await expect(
        deleteUser("admin-123", "requesting-user-456"),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.BAD_REQUEST,
        message: "Cannot delete the last super admin",
      });

      // The delete must not proceed when count is 1 inside the transaction
      expect(prismaMock.user.delete).not.toHaveBeenCalled();
      expect(firebaseAuthMock.deleteUser).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Role-Based Access Control Edge Cases
  // ============================================================================
  describe("Role-Based Access Control", () => {
    it("should handle transition from CLIENT_ADMIN to SUPER_ADMIN", async () => {
      const existingUser = createMockClientAdmin("client-123", {
        id: "user-123",
      });
      const updatedUser = {
        ...existingUser,
        role: UserRole.SUPER_ADMIN,
        clientId: null,
        client: null,
      };

      prismaMock.user.findUnique.mockResolvedValue(existingUser);
      firebaseAuthMock.setCustomUserClaims.mockResolvedValue(undefined);
      prismaMock.user.update.mockResolvedValue(updatedUser);

      const result = await updateUser("user-123", {
        role: UserRole.SUPER_ADMIN,
        clientId: null,
      });

      expect(result.role).toBe(UserRole.SUPER_ADMIN);
      expect(result.clientId).toBeNull();
      expect(firebaseAuthMock.setCustomUserClaims).toHaveBeenCalledWith(
        "user-123",
        {
          role: UserRole.SUPER_ADMIN,
          clientId: null,
        },
      );
    });

    it("should handle transition from SUPER_ADMIN to CLIENT_ADMIN", async () => {
      const existingUser = createMockSuperAdmin({ id: "admin-123" });
      const newClient = createMockClient({ id: "client-456" });
      const updatedUser = {
        ...existingUser,
        role: UserRole.CLIENT_ADMIN,
        clientId: "client-456",
        client: newClient,
      };

      prismaMock.user.findUnique.mockResolvedValue(existingUser);
      clientExistsMock.mockResolvedValue(true);
      firebaseAuthMock.setCustomUserClaims.mockResolvedValue(undefined);
      prismaMock.user.update.mockResolvedValue(updatedUser);

      const result = await updateUser("admin-123", {
        role: UserRole.CLIENT_ADMIN,
        clientId: "client-456",
      });

      expect(result.role).toBe(UserRole.CLIENT_ADMIN);
      expect(result.clientId).toBe("client-456");
      expect(firebaseAuthMock.setCustomUserClaims).toHaveBeenCalledWith(
        "admin-123",
        {
          role: UserRole.CLIENT_ADMIN,
          clientId: "client-456",
        },
      );
    });

    it("should preserve existing role when only updating clientId", async () => {
      const existingUser = createMockClientAdmin("client-123", {
        id: "user-123",
      });
      const newClient = createMockClient({ id: "client-456" });
      const updatedUser = {
        ...existingUser,
        clientId: "client-456",
        client: newClient,
      };

      prismaMock.user.findUnique.mockResolvedValue(existingUser);
      clientExistsMock.mockResolvedValue(true);
      firebaseAuthMock.setCustomUserClaims.mockResolvedValue(undefined);
      prismaMock.user.update.mockResolvedValue(updatedUser);

      await updateUser("user-123", { clientId: "client-456" });

      expect(firebaseAuthMock.setCustomUserClaims).toHaveBeenCalledWith(
        "user-123",
        {
          role: UserRole.CLIENT_ADMIN, // Preserves existing role
          clientId: "client-456",
        },
      );
    });
  });

  // ============================================================================
  // Client Association Edge Cases
  // ============================================================================
  describe("Client Association", () => {
    it("should allow creating CLIENT_ADMIN with valid client", async () => {
      const input = {
        email: "client-user@example.com",
        password: "password123",
        name: "Client User",
        role: UserRole.CLIENT_ADMIN,
        clientId: "valid-client-id",
      };

      prismaMock.user.findUnique.mockResolvedValue(null);
      clientExistsMock.mockResolvedValue(true);
      firebaseAuthMock.createUser.mockResolvedValue({ uid: "new-uid" });
      firebaseAuthMock.setCustomUserClaims.mockResolvedValue(undefined);

      const expectedUser = createMockClientAdmin("valid-client-id", {
        id: "new-uid",
        email: input.email,
        name: input.name,
      });
      prismaMock.user.create.mockResolvedValue(expectedUser);

      const result = await createUser(input);

      expect(result.clientId).toBe("valid-client-id");
      expect(clientExistsMock).toHaveBeenCalledWith("valid-client-id");
    });

    it("should allow null clientId for new CLIENT_ADMIN when validated later", async () => {
      // This test verifies the service correctly validates that CLIENT_ADMIN must have clientId
      const input = {
        email: "test@example.com",
        password: "password123",
        name: "Test User",
        role: UserRole.CLIENT_ADMIN,
        clientId: null as unknown as string, // Explicitly null
      };

      prismaMock.user.findUnique.mockResolvedValue(null);

      await expect(createUser(input)).rejects.toThrow(AppError);
      await expect(createUser(input)).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
    });

    it("should reject SUPER_ADMIN with non-null clientId", async () => {
      const input = {
        email: "admin@example.com",
        password: "password123",
        name: "Super Admin",
        role: UserRole.SUPER_ADMIN,
        clientId: "some-client-id",
      };

      prismaMock.user.findUnique.mockResolvedValue(null);

      await expect(createUser(input)).rejects.toThrow(AppError);
      await expect(createUser(input)).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.VALIDATION_ERROR,
      });
    });
  });
});
