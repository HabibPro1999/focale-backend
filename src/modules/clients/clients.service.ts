import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";
import { logger } from "@shared/utils/logger.js";
import {
  createFirebaseUser,
  setCustomClaims,
  deleteFirebaseUser,
} from "@shared/services/firebase.service.js";
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";
import { auditLog, diffChanges } from "@shared/utils/audit.js";
import { UserRole } from "@shared/constants.js";
import { z } from "zod";
import { Client, MODULE_IDS, type User } from "./clients.schema.js";
import type {
  Client as PrismaClient,
  Prisma,
} from "@/generated/prisma/client.js";

type CreateClientInput = z.infer<typeof Client> & {
  adminName: string;
  adminEmail: string;
  adminPassword: string;
};

type UpdateClientInput = Partial<z.infer<typeof Client>> & {
  active?: boolean;
};

type ListClientsQuery = {
  page: number;
  limit: number;
  search?: string;
  active?: boolean;
};

// ============================================================================
// Types
// ============================================================================

export type ClientWithAdmin = PrismaClient & { admin: User | null };

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Create a new client and its admin user atomically.
 * Creates Firebase Auth user first, then DB records in a transaction.
 * On failure, rolls back the Firebase user.
 */
export async function createClient(
  input: CreateClientInput,
  performedBy: string,
): Promise<ClientWithAdmin> {
  const {
    name,
    email,
    phone,
    enabledModules,
    adminName,
    adminEmail,
    adminPassword,
  } = input;

  // Check if user with adminEmail already exists in DB
  const existingUser = await prisma.user.findUnique({
    where: { email: adminEmail },
  });
  if (existingUser) {
    throw new AppError(
      "A user with this email already exists",
      409,
      true,
      ErrorCodes.CONFLICT,
    );
  }

  // Create Firebase Auth user
  const firebaseUser = await createFirebaseUser(adminEmail, adminPassword);

  try {
    // Atomically create Client + User in DB
    const { client, user } = await prisma.$transaction(async (tx) => {
      const client = await tx.client.create({
        data: {
          name,
          email: email ?? null,
          phone: phone ?? null,
          enabledModules: enabledModules ?? [...MODULE_IDS],
        },
      });

      const user = await tx.user.create({
        data: {
          id: firebaseUser.uid,
          email: adminEmail,
          name: adminName,
          role: UserRole.CLIENT_ADMIN,
          clientId: client.id,
        },
      });

      await auditLog(tx, {
        entityType: "Client",
        entityId: client.id,
        action: "CREATE",
        performedBy,
      });

      await auditLog(tx, {
        entityType: "User",
        entityId: user.id,
        action: "CREATE",
        performedBy,
      });

      return { client, user };
    });

    // Set custom claims after successful DB commit
    await setCustomClaims(firebaseUser.uid, {
      role: UserRole.CLIENT_ADMIN,
      clientId: client.id,
    });

    return {
      ...client,
      admin: {
        id: user.id,
        email: user.email,
        name: user.name,
        active: user.active,
      },
    };
  } catch (error) {
    // Rollback: delete from Firebase if anything failed
    await deleteFirebaseUser(firebaseUser.uid).catch((cleanupErr) => {
      logger.error(
        {
          err: cleanupErr,
          uid: firebaseUser.uid,
          email: adminEmail,
          originalError: error,
        },
        "Failed to cleanup Firebase user after client creation failure - orphaned user may exist",
      );
    });
    throw error;
  }
}

/**
 * Get client by ID.
 * Optionally includes the admin user record.
 */
export async function getClientById(
  id: string,
  options?: { includeAdmin?: boolean },
): Promise<ClientWithAdmin | PrismaClient | null> {
  if (!options?.includeAdmin) {
    return prisma.client.findUnique({ where: { id } });
  }

  const data = await prisma.client.findUnique({
    where: { id },
    include: {
      users: {
        where: { role: UserRole.CLIENT_ADMIN },
        take: 1,
        select: { id: true, email: true, name: true, active: true },
      },
    },
  });

  if (!data) return null;

  const { users, ...client } = data;
  return { ...client, admin: users[0] ?? null };
}

/**
 * Update client.
 * Note: enabledModules uses one-way enable logic - modules can be added but never removed.
 * Cascades active toggle to all users of the client.
 */
export async function updateClient(
  id: string,
  input: UpdateClientInput,
  performedBy: string,
): Promise<PrismaClient> {
  const updatedClient = await prisma.$transaction(async (tx) => {
    // Check if client exists
    const oldClient = await tx.client.findUnique({ where: { id } });
    if (!oldClient) {
      throw new AppError("Client not found", 404, true, ErrorCodes.NOT_FOUND);
    }

    // One-way enable logic: merge new modules with existing (union, not replace)
    let mergedModules: string[] | undefined;
    if (input.enabledModules) {
      const existingModules = new Set(oldClient.enabledModules);
      const newModules = input.enabledModules;
      mergedModules = [...new Set([...existingModules, ...newModules])];
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { enabledModules: _removed, ...restInput } = input;

    const updatedClient = await tx.client.update({
      where: { id },
      data: {
        ...restInput,
        ...(mergedModules && { enabledModules: mergedModules }),
      },
    });

    const changes = diffChanges(oldClient, updatedClient, [
      "name",
      "email",
      "phone",
      "active",
      "enabledModules",
    ]);

    await auditLog(tx, {
      entityType: "Client",
      entityId: id,
      action: "UPDATE",
      changes,
      performedBy,
    });

    // Cascade active state to all users of this client
    if (input.active !== undefined) {
      await tx.user.updateMany({
        where: { clientId: id },
        data: { active: input.active },
      });
    }

    return updatedClient;
  });

  return updatedClient;
}

/**
 * List clients with pagination and filters.
 * Always includes admin user info.
 */
export async function listClients(
  query: ListClientsQuery,
): Promise<PaginatedResult<ClientWithAdmin>> {
  const { page, limit, active, search } = query;
  const skip = getSkip({ page, limit });

  const where: Prisma.ClientWhereInput = {};

  if (active !== undefined) where.active = active;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
    ];
  }

  const [rawData, total] = await Promise.all([
    prisma.client.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        users: {
          where: { role: UserRole.CLIENT_ADMIN },
          take: 1,
          select: { id: true, email: true, name: true, active: true },
        },
      },
    }),
    prisma.client.count({ where }),
  ]);

  const data: ClientWithAdmin[] = rawData.map(({ users, ...client }) => ({
    ...client,
    admin: users[0] ?? null,
  }));

  return paginate(data, total, { page, limit });
}

/**
 * Delete client.
 * Cascades to delete associated users (Firebase + DB).
 * Still blocks deletion when events exist.
 */
export async function deleteClient(
  id: string,
  performedBy: string,
): Promise<void> {
  // Fetch client with users and event count
  const client = await prisma.client.findUnique({
    where: { id },
    include: {
      users: { select: { id: true } },
      _count: { select: { events: true } },
    },
  });

  if (!client) {
    throw new AppError("Client not found", 404, true, ErrorCodes.NOT_FOUND);
  }

  // Block deletion if events exist
  if (client._count.events > 0) {
    throw new AppError(
      `Cannot delete client with ${client._count.events} event(s). Remove associated events first.`,
      409,
      true,
      ErrorCodes.CLIENT_HAS_DEPENDENCIES,
    );
  }

  const userIds = client.users.map((u) => u.id);

  // Delete users and client in a transaction
  await prisma.$transaction(async (tx) => {
    // Delete users first (FK constraint)
    if (userIds.length > 0) {
      await tx.user.deleteMany({ where: { clientId: id } });
    }

    await tx.client.delete({ where: { id } });

    await auditLog(tx, {
      entityType: "Client",
      entityId: id,
      action: "DELETE",
      performedBy,
    });
  });

  // Best-effort: delete each user from Firebase Auth
  for (const uid of userIds) {
    await deleteFirebaseUser(uid).catch((err) => {
      logger.error(
        { err, uid },
        "Failed to delete Firebase user during client deletion - orphaned Firebase user may exist",
      );
    });
  }
}

/**
 * Helper function to check if client exists (for validation in other modules).
 */
export async function clientExists(id: string): Promise<boolean> {
  const count = await prisma.client.count({ where: { id } });
  return count > 0;
}
