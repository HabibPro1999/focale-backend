import type { FastifyRequest, FastifyReply } from "fastify";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { UserRole } from "@modules/identity/permissions.js";
import { getClientById } from "@clients";
import type { ModuleId } from "@clients";

/**
 * Factory function to create middleware that checks if the user's client
 * has a specific module enabled.
 * Super admins bypass this check.
 * Must run AFTER requireAuth (depends on request.user).
 */
export function requireModule(...modules: ModuleId[]) {
  return async (
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> => {
    // Must have authenticated user
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

    // Client admin must have a clientId
    if (!request.user.clientId) {
      throw new AppError(
        "Module access denied",
        403,
        true,
        ErrorCodes.MODULE_NOT_ENABLED,
      );
    }

    // Fetch client to check enabledModules
    const client = await getClientById(request.user.clientId);
    if (!client) {
      throw new AppError("Client not found", 403, true, ErrorCodes.FORBIDDEN);
    }

    // Check if ANY of the required modules is enabled
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
