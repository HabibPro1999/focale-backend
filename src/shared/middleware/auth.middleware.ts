import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyToken } from "@shared/services/firebase.service.js";
import { prisma } from "@/database/client.js";
import { AppError, ErrorCodes } from "@shared/errors.js";
import { UserRole } from "@shared/constants.js";

// ============================================================================
// Authentication
// ============================================================================

/**
 * Verify Firebase ID token and attach user to request.
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
      true,
      ErrorCodes.UNAUTHORIZED,
    );
  }

  const token = authHeader.replace("Bearer ", "");

  try {
    const decoded = await verifyToken(token);

    const user = await prisma.user.findUnique({
      where: { id: decoded.uid },
    });

    if (!user) {
      throw new AppError(
        "User not found in database",
        401,
        true,
        ErrorCodes.UNAUTHORIZED,
      );
    }

    if (!user.active) {
      throw new AppError(
        "User account is disabled",
        401,
        true,
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
      true,
      ErrorCodes.INVALID_TOKEN,
    );
  }
}

// ============================================================================
// Role Authorization
// ============================================================================

/**
 * Factory: middleware that checks for specific roles.
 */
export function requireRole(
  ...roles: Array<(typeof UserRole)[keyof typeof UserRole]>
) {
  return async (
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> => {
    if (!request.user) {
      throw new AppError(
        "Authentication required",
        401,
        true,
        ErrorCodes.UNAUTHORIZED,
      );
    }

    if (
      !roles.includes(
        request.user.role as (typeof UserRole)[keyof typeof UserRole],
      )
    ) {
      throw new AppError(
        "Insufficient permissions",
        403,
        true,
        ErrorCodes.FORBIDDEN,
      );
    }
  };
}

export const requireSuperAdmin = requireRole(UserRole.SUPER_ADMIN);

export const requireAdmin = requireRole(
  UserRole.SUPER_ADMIN,
  UserRole.CLIENT_ADMIN,
);

// ============================================================================
// Resource Authorization (re-exported from authorization.middleware)
// ============================================================================

export {
  canAccessClient,
  requireModule,
  requireEventAccess,
} from "./authorization.middleware.js";
