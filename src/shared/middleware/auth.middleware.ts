import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyToken } from "@shared/services/firebase.service.js";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { UserRole } from "@shared/constants/roles.js";
import { SimpleCache } from "@shared/utils/cache.js";
import type { User } from "@/generated/prisma/client.js";

// Cache user lookups for 60 seconds to reduce DB hits
const userCache = new SimpleCache<User>(60);

/**
 * Invalidate user cache entry (call when user is updated/deleted).
 */
export function invalidateUserCache(userId: string): void {
  userCache.invalidate(userId);
}

/**
 * Clear all user cache entries (useful for testing).
 */
export function clearUserCache(): void {
  userCache.clear();
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
    let user = userCache.get(decoded.uid);

    if (!user) {
      // Get user from database
      user =
        (await prisma.user.findUnique({
          where: { id: decoded.uid },
        })) ?? undefined;

      // Cache the user if found
      if (user) {
        userCache.set(decoded.uid, user);
      }
    }

    if (!user) {
      throw new AppError(
        "User not found in database",
        401,
        ErrorCodes.UNAUTHORIZED,
      );
    }

    if (!user.active) {
      throw new AppError(
        "User account is disabled",
        401,
        ErrorCodes.UNAUTHORIZED,
      );
    }

    // Attach user to request
    request.user = user;
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
