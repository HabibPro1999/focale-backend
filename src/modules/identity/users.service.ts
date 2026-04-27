import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { logger } from "@shared/utils/logger.js";
import {
  createFirebaseUser,
  setCustomClaims,
  deleteFirebaseUser,
} from "@shared/services/firebase.service.js";
import { clientExists } from "@clients";
import { invalidateUserCache } from "@shared/middleware/auth.middleware.js";
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";
import type {
  CreateUserInput,
  UpdateUserInput,
  ListUsersQuery,
} from "./users.schema.js";
import type { User, Prisma } from "@/generated/prisma/client.js";
import { UserRole } from "@shared/constants/roles.js";

// Define type for user queries with include
type UserWithClient = Prisma.UserGetPayload<{ include: { client: true } }>;

// ============================================================================
// Private Helpers
// ============================================================================

/**
 * Validate that a client ID exists if provided.
 */
async function validateClientId(
  clientId: string | null | undefined,
): Promise<void> {
  if (clientId) {
    const isValid = await clientExists(clientId);
    if (!isValid) {
      throw new AppError("Invalid client ID", 400, ErrorCodes.BAD_REQUEST);
    }
  }
}

/**
 * Enforce role-clientId consistency invariant:
 * - SUPER_ADMIN must not have a clientId
 * - CLIENT_ADMIN must have a clientId
 * - SCIENTIFIC_COMMITTEE must not have a clientId
 */
function validateRoleClientConsistency(
  role: number,
  clientId: string | null | undefined,
): void {
  switch (role) {
    case UserRole.SUPER_ADMIN:
      if (clientId) {
        throw new AppError(
          "SUPER_ADMIN users cannot be assigned to a client",
          400,
          ErrorCodes.VALIDATION_ERROR,
        );
      }
      return;
    case UserRole.CLIENT_ADMIN:
      if (!clientId) {
        throw new AppError(
          "CLIENT_ADMIN users must be assigned to a client",
          400,
          ErrorCodes.VALIDATION_ERROR,
        );
      }
      return;
    case UserRole.SCIENTIFIC_COMMITTEE:
      if (clientId) {
        throw new AppError(
          "SCIENTIFIC_COMMITTEE users cannot be assigned to a client",
          400,
          ErrorCodes.VALIDATION_ERROR,
        );
      }
      return;
    default:
      throw new AppError(
        "Invalid user role",
        400,
        ErrorCodes.VALIDATION_ERROR,
      );
  }
}

/**
 * Assert that a user exists, throwing if not found.
 */
async function assertUserExists(id: string): Promise<User> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    throw new AppError("User not found", 404, ErrorCodes.NOT_FOUND);
  }
  return user;
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Create a new user in Firebase Auth + set custom claims + create in DB.
 */
export async function createUser(input: CreateUserInput): Promise<User> {
  const { email, password, name, role, clientId } = input;

  // Check if user already exists in DB
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError(
      "User with this email already exists",
      409,
      ErrorCodes.CONFLICT,
    );
  }

  // Validate role-clientId consistency
  validateRoleClientConsistency(role, clientId);

  // Validate clientId if provided
  await validateClientId(clientId);

  // Create in Firebase Auth
  const firebaseUser = await createFirebaseUser(email, password);

  try {
    // Set custom claims in Firebase
    await setCustomClaims(firebaseUser.uid, {
      role,
      clientId: clientId ?? null,
    });

    // Create in database
    return await prisma.user.create({
      data: {
        id: firebaseUser.uid,
        email,
        name,
        role,
        clientId: clientId ?? null,
      },
    });
  } catch (error) {
    // Rollback: delete from Firebase if DB insert fails
    await deleteFirebaseUser(firebaseUser.uid).catch((cleanupErr) => {
      // Log cleanup failure for monitoring/alerting - orphaned Firebase user may exist
      logger.error(
        {
          err: cleanupErr,
          uid: firebaseUser.uid,
          email,
          originalError: error,
        },
        "Failed to cleanup Firebase user after DB creation failure - orphaned user may exist",
      );
    });
    throw error;
  }
}

/**
 * Get user by ID from database.
 */
export async function getUserById(id: string): Promise<UserWithClient | null> {
  return prisma.user.findUnique({
    where: { id },
    include: { client: true },
  });
}

/**
 * Update user in database and sync Firebase claims if role/clientId changes.
 */
export async function updateUser(
  id: string,
  input: UpdateUserInput,
): Promise<UserWithClient> {
  const user = await assertUserExists(id);

  // Validate clientId if being changed
  await validateClientId(input.clientId);

  // Sync Firebase custom claims if role or clientId is being changed
  if (input.role !== undefined || input.clientId !== undefined) {
    const newRole = input.role ?? user.role;
    const newClientId =
      input.clientId !== undefined ? input.clientId : user.clientId;

    // Validate the resulting role-clientId combination
    validateRoleClientConsistency(newRole, newClientId);

    // Set Firebase claims (source of truth for auth) before DB update
    await setCustomClaims(id, {
      role: newRole,
      clientId: newClientId,
    });

    try {
      const updated = await prisma.user.update({
        where: { id },
        data: input,
        include: { client: true },
      });
      invalidateUserCache(id);
      return updated;
    } catch (error) {
      // Rollback: restore old Firebase claims if DB update fails
      await setCustomClaims(id, {
        role: user.role,
        clientId: user.clientId,
      }).catch((rollbackErr) => {
        logger.error(
          {
            err: rollbackErr,
            uid: id,
            originalError: error,
          },
          "Failed to rollback Firebase claims after DB update failure - claims may be stale",
        );
      });
      throw error;
    }
  }

  const updated = await prisma.user.update({
    where: { id },
    data: input,
    include: { client: true },
  });

  invalidateUserCache(id);

  return updated;
}

/**
 * List users with pagination and filters (DB only).
 */
export async function listUsers(
  query: ListUsersQuery,
): Promise<PaginatedResult<UserWithClient>> {
  const { page, limit, role, clientId, active, search } = query;
  const skip = getSkip({ page, limit });

  const where: Prisma.UserWhereInput = {};

  if (role !== undefined) where.role = role;
  if (clientId !== undefined) where.clientId = clientId;
  if (active !== undefined) where.active = active;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: { client: true },
    }),
    prisma.user.count({ where }),
  ]);

  return paginate(data, total, { page, limit });
}

/**
 * Delete user from Firebase Auth + database.
 * Enforces domain invariants: cannot delete own account or the last super admin.
 */
export async function deleteUser(
  id: string,
  requestingUserId: string,
): Promise<void> {
  if (id === requestingUserId) {
    throw new AppError(
      "Cannot delete your own account",
      400,
      ErrorCodes.BAD_REQUEST,
    );
  }

  const userToDelete = await assertUserExists(id);

  if (userToDelete.role === UserRole.SUPER_ADMIN) {
    const superAdminCount = await prisma.user.count({
      where: { role: UserRole.SUPER_ADMIN, active: true },
    });
    if (superAdminCount <= 1) {
      throw new AppError(
        "Cannot delete the last super admin",
        400,
        ErrorCodes.BAD_REQUEST,
      );
    }
  }

  await prisma.user.delete({ where: { id } });

  invalidateUserCache(id);

  try {
    await deleteFirebaseUser(id);
  } catch (error) {
    logger.error(
      { err: error, uid: id, email: userToDelete.email },
      "DB user deleted but Firebase delete failed — orphaned Firebase UID requires manual cleanup",
    );
    // Do NOT re-throw: the logical delete succeeded
  }
}
