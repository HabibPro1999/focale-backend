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
import { UserRole } from "./permissions.js";
import { invalidateUserCache } from "@shared/middleware/auth.middleware.js";

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
      throw new AppError(
        "Invalid client ID",
        400,
        true,
        ErrorCodes.BAD_REQUEST,
      );
    }
  }
}

/**
 * Assert that a user exists, throwing if not found.
 */
async function assertUserExists(id: string): Promise<User> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    throw new AppError("User not found", 404, true, ErrorCodes.NOT_FOUND);
  }
  return user;
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Create a new user in Firebase Auth + set custom claims + create in DB.
 */
export async function createUser(
  input: CreateUserInput & { password: string },
): Promise<User> {
  const { email, password, name, role, clientId } = input;

  // Check if user already exists in DB
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError(
      "User with this email already exists",
      409,
      true,
      ErrorCodes.CONFLICT,
    );
  }

  // Validate role-clientId consistency
  if (role === UserRole.CLIENT_ADMIN && !clientId) {
    throw new AppError(
      "CLIENT_ADMIN users must be assigned to a client",
      400,
      true,
      ErrorCodes.VALIDATION_ERROR,
    );
  }
  if (role === UserRole.SUPER_ADMIN && clientId) {
    throw new AppError(
      "SUPER_ADMIN users cannot be assigned to a client",
      400,
      true,
      ErrorCodes.VALIDATION_ERROR,
    );
  }

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
    return prisma.user.create({
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

  // Compute effective values after update
  const effectiveRole = input.role ?? user.role;
  const effectiveClientId =
    input.clientId !== undefined ? input.clientId : user.clientId;

  // Validate role-clientId consistency (mirrors createUser logic)
  if (effectiveRole === UserRole.CLIENT_ADMIN && !effectiveClientId) {
    throw new AppError(
      "CLIENT_ADMIN users must be assigned to a client",
      400,
      true,
      ErrorCodes.VALIDATION_ERROR,
    );
  }
  if (effectiveRole === UserRole.SUPER_ADMIN && effectiveClientId) {
    throw new AppError(
      "SUPER_ADMIN users cannot be assigned to a client",
      400,
      true,
      ErrorCodes.VALIDATION_ERROR,
    );
  }

  // Validate clientId if being changed
  await validateClientId(input.clientId);

  // Sync Firebase custom claims if role or clientId is being changed
  if (input.role !== undefined || input.clientId !== undefined) {
    const newRole = input.role ?? user.role;
    const newClientId =
      input.clientId !== undefined ? input.clientId : user.clientId;

    await setCustomClaims(id, {
      role: newRole,
      clientId: newClientId,
    });
  }

  const updatedUser = await prisma.user.update({
    where: { id },
    data: input,
    include: { client: true },
  });

  // Invalidate cache after successful update
  invalidateUserCache(id);

  return updatedUser;
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
 */
export async function deleteUser(id: string): Promise<void> {
  await assertUserExists(id);
  await deleteFirebaseUser(id);
  await prisma.user.delete({ where: { id } });
  invalidateUserCache(id);
}
