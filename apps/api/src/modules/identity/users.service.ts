import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ErrorCodes,
  UserRole,
  type CreateUserInput,
  type ListUsersQuery,
  type UpdateUserInput,
} from "@app/contracts";
import {
  clientExists,
  createUser as dbCreateUser,
  deleteUser as dbDeleteUser,
  getUserByEmail,
  getUserById,
  getUserWithClientById,
  listUsers as dbListUsers,
  updateUser as dbUpdateUser,
  type UserRow,
  type UserWithClient,
} from "@app/db";
import {
  createFirebaseUser,
  deleteFirebaseUser,
  revokeFirebaseRefreshTokens,
  setCustomClaims,
} from "@app/integrations";
import { paginate, getSkip, type PaginatedResult } from "@app/shared";
import { invalidateUserCache } from "../../core/auth/user-cache";
import { logger } from "../../core/logger.service";

@Injectable()
export class UsersService {
  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /** Validate a client id exists if provided. */
  private async validateClientId(
    clientId: string | null | undefined,
  ): Promise<void> {
    if (clientId) {
      if (!(await clientExists(clientId))) {
        throw new BadRequestException({
          code: ErrorCodes.BAD_REQUEST,
          message: "Invalid client ID",
        });
      }
    }
  }

  /** Enforce role<->clientId consistency. */
  private validateRoleClientConsistency(
    role: number,
    clientId: string | null | undefined,
  ): void {
    switch (role) {
      case UserRole.SUPER_ADMIN:
        if (clientId) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            message: "SUPER_ADMIN users cannot be assigned to a client",
          });
        }
        return;
      case UserRole.CLIENT_ADMIN:
        if (!clientId) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            message: "CLIENT_ADMIN users must be assigned to a client",
          });
        }
        return;
      case UserRole.SCIENTIFIC_COMMITTEE:
        if (clientId) {
          throw new BadRequestException({
            code: ErrorCodes.VALIDATION_ERROR,
            message: "SCIENTIFIC_COMMITTEE users cannot be assigned to a client",
          });
        }
        return;
      default:
        throw new BadRequestException({
          code: ErrorCodes.VALIDATION_ERROR,
          message: "Invalid user role",
        });
    }
  }

  private async assertUserExists(id: string): Promise<UserRow> {
    const user = await getUserById(id);
    if (!user) {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: "User not found",
      });
    }
    return user;
  }

  private async updateUserRow(
    id: string,
    input: UpdateUserInput,
  ): Promise<UserWithClient> {
    const result = await dbUpdateUser(id, input);
    if (result.ok) return result.user;
    if (result.reason === "not_found") {
      throw new NotFoundException({
        code: ErrorCodes.NOT_FOUND,
        message: "User not found",
      });
    }
    throw new BadRequestException({
      code: ErrorCodes.BAD_REQUEST,
      message: "Cannot remove or deactivate the last super admin",
    });
  }

  // --------------------------------------------------------------------------
  // Service functions
  // --------------------------------------------------------------------------

  /** Create a user: Firebase Auth + custom claims + DB row (Firebase-first). */
  async createUser(input: CreateUserInput): Promise<UserRow> {
    const { email, password, name, role, clientId } = input;
    const normalizedEmail = email.trim().toLowerCase();

    const existing = await getUserByEmail(normalizedEmail);
    if (existing) {
      throw new ConflictException({
        code: ErrorCodes.CONFLICT,
        message: "User with this email already exists",
      });
    }

    this.validateRoleClientConsistency(role, clientId);
    await this.validateClientId(clientId);

    const firebaseUser = await createFirebaseUser(normalizedEmail, password);

    try {
      await setCustomClaims(firebaseUser.uid, {
        role,
        clientId: clientId ?? null,
      });

      return await dbCreateUser({
        id: firebaseUser.uid,
        email: normalizedEmail,
        name,
        role,
        clientId: clientId ?? null,
      });
    } catch (error) {
      // Rollback: best-effort delete of the just-created Firebase user. Never
      // throws the cleanup error — always rethrows the original.
      await deleteFirebaseUser(firebaseUser.uid).catch((cleanupErr) => {
        logger.error(
          {
            err: cleanupErr,
            uid: firebaseUser.uid,
            email: normalizedEmail,
            originalError: error,
          },
          "Failed to cleanup Firebase user after DB creation failure - orphaned user may exist",
        );
      });
      throw error;
    }
  }

  /** Get a user by id including its client relation (null if not found). */
  async getUserById(id: string): Promise<UserWithClient | null> {
    return (await getUserWithClientById(id)) ?? null;
  }

  /** Update a user; sync Firebase claims when role/clientId change. */
  async updateUser(
    id: string,
    input: UpdateUserInput,
    requestingUserId?: string,
  ): Promise<UserWithClient> {
    const user = await this.assertUserExists(id);

    if (
      requestingUserId === id &&
      (input.role !== undefined ||
        input.clientId !== undefined ||
        input.active !== undefined)
    ) {
      throw new BadRequestException({
        code: ErrorCodes.BAD_REQUEST,
        message:
          "Cannot change your own role, client assignment, or active status",
      });
    }

    await this.validateClientId(input.clientId);

    if (input.role !== undefined || input.clientId !== undefined) {
      const newRole = input.role ?? user.role;
      const newClientId =
        input.clientId !== undefined ? input.clientId : user.clientId;

      this.validateRoleClientConsistency(newRole, newClientId);

      // Firebase claims are the source of truth for auth — set before DB write.
      await setCustomClaims(id, { role: newRole, clientId: newClientId });

      try {
        const updated = await this.updateUserRow(id, input);
        await revokeFirebaseRefreshTokens(id);
        invalidateUserCache(id);
        return updated;
      } catch (error) {
        // Rollback claims to the pre-update values; swallow rollback failure.
        await setCustomClaims(id, {
          role: user.role,
          clientId: user.clientId,
        }).catch((rollbackErr) => {
          logger.error(
            { err: rollbackErr, uid: id, originalError: error },
            "Failed to rollback Firebase claims after DB update failure - claims may be stale",
          );
        });
        throw error;
      }
    }

    const updated = await this.updateUserRow(id, input);

    if (input.active === false) {
      await revokeFirebaseRefreshTokens(id);
    }

    invalidateUserCache(id);
    return updated;
  }

  /** List users with pagination and filters. */
  async listUsers(
    query: ListUsersQuery,
  ): Promise<PaginatedResult<UserWithClient>> {
    const { page, limit, role, clientId, active, search } = query;
    const skip = getSkip({ page, limit });

    const { data, total } = await dbListUsers(
      { role, clientId, active, search },
      skip,
      limit,
    );

    return paginate(data, total, { page, limit });
  }

  /** Delete a user: transactional DB delete + best-effort Firebase cleanup. */
  async deleteUser(id: string, requestingUserId: string): Promise<void> {
    if (id === requestingUserId) {
      throw new BadRequestException({
        code: ErrorCodes.BAD_REQUEST,
        message: "Cannot delete your own account",
      });
    }

    const result = await dbDeleteUser(id);
    if (!result.ok) {
      if (result.reason === "not_found") {
        throw new NotFoundException({
          code: ErrorCodes.NOT_FOUND,
          message: "User not found",
        });
      }
      throw new BadRequestException({
        code: ErrorCodes.BAD_REQUEST,
        message: "Cannot remove or deactivate the last super admin",
      });
    }

    invalidateUserCache(id);

    try {
      await revokeFirebaseRefreshTokens(id);
    } catch (error) {
      logger.error(
        { err: error, uid: id, email: result.user.email },
        "DB user deleted but Firebase refresh-token revocation failed",
      );
    }

    try {
      await deleteFirebaseUser(id);
    } catch (error) {
      logger.error(
        { err: error, uid: id, email: result.user.email },
        "DB user deleted but Firebase delete failed — orphaned Firebase UID requires manual cleanup",
      );
      // Do NOT re-throw: the logical delete succeeded.
    }
  }
}
