import type { FastifyRequest, FastifyReply } from "fastify";
import { AppError, ErrorCodes } from "@shared/errors.js";
import { UserRole } from "@shared/constants.js";
import { getEventById } from "@events";
import { getClientById } from "@clients";
import type { ModuleId } from "@clients";
import type { User } from "@/generated/prisma/client.js";

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
