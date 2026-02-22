import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyToken } from "@shared/services/firebase.service.js";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";
import { UserRole } from "@shared/constants.js";
import { getEventById } from "@modules/events/events.service.js";
import { getClientById } from "@clients";
import type { ModuleId } from "@clients";
import type { User } from "@/generated/prisma/client.js";

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
// Resource Authorization
// ============================================================================

/**
 * Check if user can access a client's resources.
 * Super admins can access all clients.
 * Client admins can only access their own client.
 */
export function canAccessClient(
  user: { role: number; clientId: string | null },
  clientId: string,
): boolean {
  return user.role === UserRole.SUPER_ADMIN || user.clientId === clientId;
}

/**
 * Factory: middleware that checks if the user's client has a module enabled.
 * Super admins bypass. Must run AFTER requireAuth.
 */
export function requireModule(...modules: ModuleId[]) {
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

    // Super admins bypass module checks
    if (request.user.role === UserRole.SUPER_ADMIN) {
      return;
    }

    if (!request.user.clientId) {
      throw new AppError(
        "Module access denied",
        403,
        true,
        ErrorCodes.MODULE_NOT_ENABLED,
      );
    }

    const client = await getClientById(request.user.clientId);

    if (!client) {
      throw new AppError("Client not found", 403, true, ErrorCodes.FORBIDDEN);
    }

    const hasAccess = modules.some((m) => client.enabledModules.includes(m));
    if (!hasAccess) {
      throw new AppError(
        "This feature is not enabled for your organization",
        403,
        true,
        ErrorCodes.MODULE_NOT_ENABLED,
      );
    }
  };
}

type EventWithPricing = NonNullable<Awaited<ReturnType<typeof getEventById>>>;

/**
 * Verify user has access to an event. Fetches the event, throws 404/403,
 * and returns it so callers avoid a second round-trip.
 */
export async function requireEventAccess(
  user: User,
  eventId: string,
): Promise<EventWithPricing> {
  const event = await getEventById(eventId);
  if (!event) {
    throw new AppError("Event not found", 404, true, ErrorCodes.NOT_FOUND);
  }

  if (!canAccessClient(user, event.clientId)) {
    throw new AppError(
      "Insufficient permissions",
      403,
      true,
      ErrorCodes.FORBIDDEN,
    );
  }

  return event;
}
