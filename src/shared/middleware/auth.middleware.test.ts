import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import {
  firebaseAuthMock,
  createMockDecodedToken,
} from "../../../tests/mocks/firebase.js";
import {
  createMockUser,
  createMockSuperAdmin,
  createMockClientAdmin,
} from "../../../tests/helpers/factories.js";
import {
  requireAuth,
  requireRole,
  requireSuperAdmin,
  requireAdmin,
  canAccessClient,
  clearUserCache,
} from "./auth.middleware.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { UserRole } from "@shared/constants/roles.js";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock Fastify request object for testing middleware.
 */
function createMockRequest(
  overrides: Partial<FastifyRequest> = {},
): FastifyRequest {
  return {
    headers: {},
    user: undefined,
    ...overrides,
  } as FastifyRequest;
}

/**
 * Creates a mock Fastify reply object for testing middleware.
 */
function createMockReply(): FastifyReply {
  return {} as FastifyReply;
}

// ============================================================================
// requireAuth Tests
// ============================================================================

describe("requireAuth", () => {
  const mockReply = createMockReply();

  beforeEach(() => {
    clearUserCache();
  });

  describe("Authorization Header Validation", () => {
    it("should throw 401 when authorization header is missing", async () => {
      const request = createMockRequest({ headers: {} });

      await expect(requireAuth(request, mockReply)).rejects.toThrow(AppError);

      try {
        await requireAuth(request, mockReply);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(401);
        expect((error as AppError).code).toBe(ErrorCodes.UNAUTHORIZED);
        expect((error as AppError).message).toBe(
          "Missing or invalid authorization header",
        );
      }
    });

    it("should throw 401 when authorization header is empty string", async () => {
      const request = createMockRequest({ headers: { authorization: "" } });

      await expect(requireAuth(request, mockReply)).rejects.toThrow(AppError);
    });

    it("should throw 401 when authorization header does not start with Bearer", async () => {
      const request = createMockRequest({
        headers: { authorization: "Basic some-token" },
      });

      await expect(requireAuth(request, mockReply)).rejects.toThrow(AppError);

      try {
        await requireAuth(request, mockReply);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(401);
        expect((error as AppError).message).toBe(
          "Missing or invalid authorization header",
        );
      }
    });

    it("should throw 401 when Bearer is present but token is missing", async () => {
      const request = createMockRequest({
        headers: { authorization: "Bearer " },
      });

      // Token would be empty string, Firebase would reject it
      firebaseAuthMock.verifyIdToken.mockRejectedValue(
        new Error("Invalid token"),
      );

      await expect(requireAuth(request, mockReply)).rejects.toThrow(AppError);
    });
  });

  describe("Token Verification", () => {
    it("should throw 401 when token is invalid", async () => {
      const request = createMockRequest({
        headers: { authorization: "Bearer invalid-token" },
      });

      firebaseAuthMock.verifyIdToken.mockRejectedValue(
        new Error("Invalid token"),
      );

      await expect(requireAuth(request, mockReply)).rejects.toThrow(AppError);

      try {
        await requireAuth(request, mockReply);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(401);
        expect((error as AppError).code).toBe(ErrorCodes.INVALID_TOKEN);
        expect((error as AppError).message).toBe("Invalid or expired token");
      }
    });

    it("should throw 401 when token is expired", async () => {
      const request = createMockRequest({
        headers: { authorization: "Bearer expired-token" },
      });

      const expiredError = new Error("Token expired");
      expiredError.name = "auth/id-token-expired";
      firebaseAuthMock.verifyIdToken.mockRejectedValue(expiredError);

      await expect(requireAuth(request, mockReply)).rejects.toThrow(AppError);

      try {
        await requireAuth(request, mockReply);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(401);
        expect((error as AppError).code).toBe(ErrorCodes.INVALID_TOKEN);
      }
    });

    it("should throw 401 when token is revoked", async () => {
      const request = createMockRequest({
        headers: { authorization: "Bearer revoked-token" },
      });

      const revokedError = new Error("Token revoked");
      revokedError.name = "auth/id-token-revoked";
      firebaseAuthMock.verifyIdToken.mockRejectedValue(revokedError);

      await expect(requireAuth(request, mockReply)).rejects.toThrow(AppError);
    });
  });

  describe("User Lookup", () => {
    it("should throw 401 when user is not found in database", async () => {
      const request = createMockRequest({
        headers: { authorization: "Bearer valid-token" },
      });
      const decodedToken = createMockDecodedToken({ uid: "non-existent-user" });

      firebaseAuthMock.verifyIdToken.mockResolvedValue(decodedToken);
      prismaMock.user.findUnique.mockResolvedValue(null);

      await expect(requireAuth(request, mockReply)).rejects.toThrow(AppError);

      try {
        await requireAuth(request, mockReply);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(401);
        expect((error as AppError).code).toBe(ErrorCodes.UNAUTHORIZED);
        expect((error as AppError).message).toBe("User not found in database");
      }
    });

    it("should throw 401 when user account is disabled", async () => {
      const request = createMockRequest({
        headers: { authorization: "Bearer valid-token" },
      });
      const decodedToken = createMockDecodedToken({ uid: "user-123" });
      const inactiveUser = createMockUser({ id: "user-123", active: false });

      firebaseAuthMock.verifyIdToken.mockResolvedValue(decodedToken);
      prismaMock.user.findUnique.mockResolvedValue(inactiveUser);

      await expect(requireAuth(request, mockReply)).rejects.toThrow(AppError);

      try {
        await requireAuth(request, mockReply);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(401);
        expect((error as AppError).code).toBe(ErrorCodes.UNAUTHORIZED);
        expect((error as AppError).message).toBe("User account is disabled");
      }
    });
  });

  describe("Successful Authentication", () => {
    it("should attach user to request when authentication succeeds", async () => {
      const request = createMockRequest({
        headers: { authorization: "Bearer valid-token" },
      });
      const decodedToken = createMockDecodedToken({ uid: "user-123" });
      const mockUser = createMockUser({ id: "user-123", active: true });

      firebaseAuthMock.verifyIdToken.mockResolvedValue(decodedToken);
      prismaMock.user.findUnique.mockResolvedValue(mockUser);

      await requireAuth(request, mockReply);

      expect(request.user).toEqual(mockUser);
      expect(firebaseAuthMock.verifyIdToken).toHaveBeenCalledWith(
        "valid-token",
      );
      expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
        where: { id: "user-123" },
      });
    });

    it("should work with super admin users", async () => {
      const request = createMockRequest({
        headers: { authorization: "Bearer super-admin-token" },
      });
      const decodedToken = createMockDecodedToken({ uid: "super-admin-123" });
      const superAdmin = createMockSuperAdmin({ id: "super-admin-123" });

      firebaseAuthMock.verifyIdToken.mockResolvedValue(decodedToken);
      prismaMock.user.findUnique.mockResolvedValue(superAdmin);

      await requireAuth(request, mockReply);

      expect(request.user).toEqual(superAdmin);
      expect(request.user?.role).toBe(UserRole.SUPER_ADMIN);
    });

    it("should work with client admin users", async () => {
      const clientId = "client-456";
      const request = createMockRequest({
        headers: { authorization: "Bearer client-admin-token" },
      });
      const decodedToken = createMockDecodedToken({ uid: "client-admin-123" });
      const clientAdmin = createMockClientAdmin(clientId, {
        id: "client-admin-123",
      });

      firebaseAuthMock.verifyIdToken.mockResolvedValue(decodedToken);
      prismaMock.user.findUnique.mockResolvedValue(clientAdmin);

      await requireAuth(request, mockReply);

      expect(request.user).toEqual(clientAdmin);
      expect(request.user?.role).toBe(UserRole.CLIENT_ADMIN);
      expect(request.user?.clientId).toBe(clientId);
    });
  });

  describe("Error Propagation", () => {
    it("should re-throw AppError when caught during authentication", async () => {
      const request = createMockRequest({
        headers: { authorization: "Bearer valid-token" },
      });
      const decodedToken = createMockDecodedToken({ uid: "user-123" });

      firebaseAuthMock.verifyIdToken.mockResolvedValue(decodedToken);
      prismaMock.user.findUnique.mockResolvedValue(null);

      try {
        await requireAuth(request, mockReply);
      } catch (error) {
        // The "User not found in database" AppError should be re-thrown as-is
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).message).toBe("User not found in database");
      }
    });
  });
});

// ============================================================================
// requireRole Tests
// ============================================================================

describe("requireRole", () => {
  const mockReply = createMockReply();

  describe("Authentication Check", () => {
    it("should throw 401 when user is not attached to request", async () => {
      const request = createMockRequest({ user: undefined });
      const middleware = requireRole(UserRole.SUPER_ADMIN);

      await expect(middleware(request, mockReply)).rejects.toThrow(AppError);

      try {
        await middleware(request, mockReply);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(401);
        expect((error as AppError).code).toBe(ErrorCodes.UNAUTHORIZED);
        expect((error as AppError).message).toBe("Authentication required");
      }
    });
  });

  describe("Role Validation", () => {
    it("should throw 403 when user role is not in allowed roles", async () => {
      const clientAdmin = createMockClientAdmin("client-123");
      const request = createMockRequest({
        user: clientAdmin,
      } as Partial<FastifyRequest>);
      const middleware = requireRole(UserRole.SUPER_ADMIN);

      await expect(middleware(request, mockReply)).rejects.toThrow(AppError);

      try {
        await middleware(request, mockReply);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).statusCode).toBe(403);
        expect((error as AppError).code).toBe(ErrorCodes.FORBIDDEN);
        expect((error as AppError).message).toBe("Insufficient permissions");
      }
    });

    it("should pass when user role matches single allowed role", async () => {
      const superAdmin = createMockSuperAdmin();
      const request = createMockRequest({
        user: superAdmin,
      } as Partial<FastifyRequest>);
      const middleware = requireRole(UserRole.SUPER_ADMIN);

      await expect(middleware(request, mockReply)).resolves.toBeUndefined();
    });

    it("should pass when user role matches one of multiple allowed roles", async () => {
      const clientAdmin = createMockClientAdmin("client-123");
      const request = createMockRequest({
        user: clientAdmin,
      } as Partial<FastifyRequest>);
      const middleware = requireRole(
        UserRole.SUPER_ADMIN,
        UserRole.CLIENT_ADMIN,
      );

      await expect(middleware(request, mockReply)).resolves.toBeUndefined();
    });

    it("should pass super admin for both roles when both are allowed", async () => {
      const superAdmin = createMockSuperAdmin();
      const request = createMockRequest({
        user: superAdmin,
      } as Partial<FastifyRequest>);
      const middleware = requireRole(
        UserRole.SUPER_ADMIN,
        UserRole.CLIENT_ADMIN,
      );

      await expect(middleware(request, mockReply)).resolves.toBeUndefined();
    });
  });
});

// ============================================================================
// requireSuperAdmin Tests
// ============================================================================

describe("requireSuperAdmin", () => {
  const mockReply = createMockReply();

  it("should throw 401 when user is not authenticated", async () => {
    const request = createMockRequest({ user: undefined });

    await expect(requireSuperAdmin(request, mockReply)).rejects.toThrow(
      AppError,
    );

    try {
      await requireSuperAdmin(request, mockReply);
    } catch (error) {
      expect((error as AppError).statusCode).toBe(401);
    }
  });

  it("should throw 403 when user is client admin", async () => {
    const clientAdmin = createMockClientAdmin("client-123");
    const request = createMockRequest({
      user: clientAdmin,
    } as Partial<FastifyRequest>);

    await expect(requireSuperAdmin(request, mockReply)).rejects.toThrow(
      AppError,
    );

    try {
      await requireSuperAdmin(request, mockReply);
    } catch (error) {
      expect((error as AppError).statusCode).toBe(403);
      expect((error as AppError).message).toBe("Insufficient permissions");
    }
  });

  it("should pass when user is super admin", async () => {
    const superAdmin = createMockSuperAdmin();
    const request = createMockRequest({
      user: superAdmin,
    } as Partial<FastifyRequest>);

    await expect(
      requireSuperAdmin(request, mockReply),
    ).resolves.toBeUndefined();
  });
});

// ============================================================================
// requireAdmin Tests
// ============================================================================

describe("requireAdmin", () => {
  const mockReply = createMockReply();

  it("should throw 401 when user is not authenticated", async () => {
    const request = createMockRequest({ user: undefined });

    await expect(requireAdmin(request, mockReply)).rejects.toThrow(AppError);

    try {
      await requireAdmin(request, mockReply);
    } catch (error) {
      expect((error as AppError).statusCode).toBe(401);
    }
  });

  it("should pass when user is super admin", async () => {
    const superAdmin = createMockSuperAdmin();
    const request = createMockRequest({
      user: superAdmin,
    } as Partial<FastifyRequest>);

    await expect(requireAdmin(request, mockReply)).resolves.toBeUndefined();
  });

  it("should pass when user is client admin", async () => {
    const clientAdmin = createMockClientAdmin("client-123");
    const request = createMockRequest({
      user: clientAdmin,
    } as Partial<FastifyRequest>);

    await expect(requireAdmin(request, mockReply)).resolves.toBeUndefined();
  });

  it("should throw 403 for unknown role values", async () => {
    const unknownRoleUser = createMockUser({ role: 99 });
    const request = createMockRequest({
      user: unknownRoleUser,
    } as Partial<FastifyRequest>);

    await expect(requireAdmin(request, mockReply)).rejects.toThrow(AppError);

    try {
      await requireAdmin(request, mockReply);
    } catch (error) {
      expect((error as AppError).statusCode).toBe(403);
    }
  });
});

// ============================================================================
// canAccessClient Tests
// ============================================================================

describe("canAccessClient", () => {
  describe("Super Admin Access", () => {
    it("should allow super admin to access any client", () => {
      const superAdmin = { role: UserRole.SUPER_ADMIN, clientId: null };

      expect(canAccessClient(superAdmin, "client-123")).toBe(true);
      expect(canAccessClient(superAdmin, "client-456")).toBe(true);
      expect(canAccessClient(superAdmin, "any-client-id")).toBe(true);
    });

    it("should allow super admin even with empty client ID", () => {
      const superAdmin = { role: UserRole.SUPER_ADMIN, clientId: null };

      expect(canAccessClient(superAdmin, "")).toBe(true);
    });
  });

  describe("Client Admin Access", () => {
    it("should allow client admin to access their own client", () => {
      const clientAdmin = {
        role: UserRole.CLIENT_ADMIN,
        clientId: "client-123",
      };

      expect(canAccessClient(clientAdmin, "client-123")).toBe(true);
    });

    it("should deny client admin access to other clients", () => {
      const clientAdmin = {
        role: UserRole.CLIENT_ADMIN,
        clientId: "client-123",
      };

      expect(canAccessClient(clientAdmin, "client-456")).toBe(false);
      expect(canAccessClient(clientAdmin, "other-client")).toBe(false);
    });

    it("should deny client admin with null clientId access to any client", () => {
      const clientAdmin = { role: UserRole.CLIENT_ADMIN, clientId: null };

      expect(canAccessClient(clientAdmin, "client-123")).toBe(false);
    });

    it("should handle case-sensitive client ID comparison", () => {
      const clientAdmin = {
        role: UserRole.CLIENT_ADMIN,
        clientId: "Client-123",
      };

      // Case-sensitive comparison
      expect(canAccessClient(clientAdmin, "Client-123")).toBe(true);
      expect(canAccessClient(clientAdmin, "client-123")).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    it("should deny access for unknown role values", () => {
      const unknownRole = { role: 99, clientId: "client-123" };

      // Fails closed: unknown roles are always denied regardless of clientId match
      expect(canAccessClient(unknownRole, "client-123")).toBe(false);
      expect(canAccessClient(unknownRole, "client-456")).toBe(false);
    });

    it("should handle UUID format client IDs correctly", () => {
      const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
      const clientAdmin = { role: UserRole.CLIENT_ADMIN, clientId: uuid };

      expect(canAccessClient(clientAdmin, uuid)).toBe(true);
      expect(
        canAccessClient(clientAdmin, "a1b2c3d4-e5f6-7890-abcd-ef1234567891"),
      ).toBe(false);
    });
  });
});

// ============================================================================
// Integration-like Tests
// ============================================================================

describe("Auth Middleware Integration", () => {
  const mockReply = createMockReply();

  beforeEach(() => {
    clearUserCache();
  });

  it("should work with requireAuth followed by requireSuperAdmin", async () => {
    const request = createMockRequest({
      headers: { authorization: "Bearer valid-token" },
    });
    const decodedToken = createMockDecodedToken({ uid: "super-admin-123" });
    const superAdmin = createMockSuperAdmin({ id: "super-admin-123" });

    firebaseAuthMock.verifyIdToken.mockResolvedValue(decodedToken);
    prismaMock.user.findUnique.mockResolvedValue(superAdmin);

    // First middleware: authenticate
    await requireAuth(request, mockReply);
    expect(request.user).toBeDefined();

    // Second middleware: check super admin role
    await expect(
      requireSuperAdmin(request, mockReply),
    ).resolves.toBeUndefined();
  });

  it("should work with requireAuth followed by requireAdmin for client admin", async () => {
    const clientId = "client-456";
    const request = createMockRequest({
      headers: { authorization: "Bearer valid-token" },
    });
    const decodedToken = createMockDecodedToken({ uid: "client-admin-123" });
    const clientAdmin = createMockClientAdmin(clientId, {
      id: "client-admin-123",
    });

    firebaseAuthMock.verifyIdToken.mockResolvedValue(decodedToken);
    prismaMock.user.findUnique.mockResolvedValue(clientAdmin);

    // First middleware: authenticate
    await requireAuth(request, mockReply);
    expect(request.user).toBeDefined();

    // Second middleware: check admin role (super or client)
    await expect(requireAdmin(request, mockReply)).resolves.toBeUndefined();

    // Verify multi-tenant access control
    expect(canAccessClient(request.user!, clientId)).toBe(true);
    expect(canAccessClient(request.user!, "other-client")).toBe(false);
  });

  it("should fail requireSuperAdmin after successful auth for client admin", async () => {
    const request = createMockRequest({
      headers: { authorization: "Bearer valid-token" },
    });
    const decodedToken = createMockDecodedToken({ uid: "client-admin-123" });
    const clientAdmin = createMockClientAdmin("client-456", {
      id: "client-admin-123",
    });

    firebaseAuthMock.verifyIdToken.mockResolvedValue(decodedToken);
    prismaMock.user.findUnique.mockResolvedValue(clientAdmin);

    // First middleware: authenticate
    await requireAuth(request, mockReply);
    expect(request.user).toBeDefined();

    // Second middleware: check super admin role - should fail
    await expect(requireSuperAdmin(request, mockReply)).rejects.toThrow(
      AppError,
    );

    try {
      await requireSuperAdmin(request, mockReply);
    } catch (error) {
      expect((error as AppError).statusCode).toBe(403);
    }
  });
});
