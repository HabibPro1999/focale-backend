import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyToken } from "@shared/services/firebase.service.js";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { UserRole } from "@shared/constants/roles.js";
import { SimpleCache } from "@shared/utils/cache.js";
import type { Client, User } from "@/generated/prisma/client.js";

type CachedAuthUser = {
  user: User;
  client: Client | null;
};

// Cache user lookups for 60 seconds to reduce DB hits
const userCache = new SimpleCache<CachedAuthUser>(60);

/**
 * Invalidate user cache entry (call when user is updated/deleted).
 */
export function invalidateUserCache(userId: string): void {
  userCache.invalidate(userId);
}

/**
 * Invalidate all cached users for a client. Call when the client's `active`
 * flag flips so subsequent requests reflect the change without waiting for
 * the per-entry TTL.
 */
export async function invalidateUserCacheForClient(
  clientId: string,
): Promise<void> {
  const users = await prisma.user.findMany({
    where: { clientId },
    select: { id: true },
  });
  for (const { id } of users) {
    userCache.invalidate(id);
  }
}

/**
 * Clear all user cache entries (useful for testing).
 */
export function clearUserCache(): void {
  userCache.clear();
}

function assertTenantClientActive(authUser: CachedAuthUser): void {
  if (authUser.user.role === UserRole.SUPER_ADMIN || !authUser.user.clientId) {
    return;
  }
  if (authUser.client?.active !== true) {
    throw new AppError("Client is inactive", 403, ErrorCodes.FORBIDDEN);
  }
}

/**
 * Middleware to require authentication.
 * Verifies Firebase ID token and attaches user to request.
 */
export async function requireAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    throw new AppError(
      "Missing or invalid authorization header",
      401,
      ErrorCodes.UNAUTHORIZED,
    );
  }

  const token = authHeader.replace("Bearer ", "");

  try {
    const decoded = await verifyToken(token);

    // Check cache first
    let authUser = userCache.get(decoded.uid);

    if (!authUser) {
      const dbUser = await prisma.user.findUnique({
        where: { id: decoded.uid },
        include: { client: true },
      });
      if (dbUser) {
        authUser = {
          user: {
            id: dbUser.id,
            email: dbUser.email,
            name: dbUser.name,
            role: dbUser.role,
            clientId: dbUser.clientId,
            active: dbUser.active,
            createdAt: dbUser.createdAt,
            updatedAt: dbUser.updatedAt,
          },
          client: dbUser.client,
        };
        userCache.set(decoded.uid, authUser);
      }
    }

    if (!authUser) {
      throw new AppError(
        "User not found in database",
        401,
        ErrorCodes.UNAUTHORIZED,
      );
    }

    if (!authUser.user.active) {
      throw new AppError(
        "User account is disabled",
        401,
        ErrorCodes.UNAUTHORIZED,
      );
    }

    assertTenantClientActive(authUser);

    request.user = authUser.user;
    request.client = authUser.client;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(
      "Invalid or expired token",
      401,
      ErrorCodes.INVALID_TOKEN,
    );
  }
}

/**
 * Factory function to create a middleware that checks for specific roles.
 * @param roles - Array of allowed role numbers (0 = super_admin, 1 = client_admin)
 */
export function requireRole(...roles: number[]) {
  return async (
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> => {
    if (!request.user) {
      throw new AppError(
        "Authentication required",
        401,
        ErrorCodes.UNAUTHORIZED,
      );
    }

    if (!roles.includes(request.user.role)) {
      throw new AppError("Insufficient permissions", 403, ErrorCodes.FORBIDDEN);
    }
  };
}

/**
 * Middleware that requires super admin role (role = 0).
 */
export const requireSuperAdmin = requireRole(UserRole.SUPER_ADMIN);

/**
 * Middleware that allows both super admin and client admin.
 */
export const requireAdmin = requireRole(
  UserRole.SUPER_ADMIN,
  UserRole.CLIENT_ADMIN,
);

/**
 * Middleware that requires scientific committee role (role = 2).
 */
export const requireScientificCommittee = requireRole(
  UserRole.SCIENTIFIC_COMMITTEE,
);

/**
 * Check if user can access a client's resources.
 * Super admins can access all clients.
 * Client admins can only access their own client.
 * Any other role is denied — fails closed on unknown roles.
 */
export function canAccessClient(
  user: { role: number; clientId: string | null },
  clientId: string,
): boolean {
  if (user.role === UserRole.SUPER_ADMIN) return true;
  if (user.role === UserRole.CLIENT_ADMIN) return user.clientId === clientId;
  return false;
}
