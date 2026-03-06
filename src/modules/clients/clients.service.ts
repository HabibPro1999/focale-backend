import { prisma } from "@/database/client.js";
import { AppError, ErrorCodes } from "@shared/errors.js";
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
import {
  Prisma,
  type Client as PrismaClient,
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
// Private Helpers
// ============================================================================

async function createClientTransaction(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  input: {
    name: string;
    email?: string | null;
    phone?: string | null;
    enabledModules?: string[] | null;
    adminName: string;
    adminEmail: string;
  },
  firebaseUid: string,
  performedBy: string,
): Promise<{ client: PrismaClient; user: { id: string; email: string; name: string; active: boolean } }> {
  const client = await tx.client.create({
    data: {
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      enabledModules: input.enabledModules ?? [...MODULE_IDS],
    },
  });

  const user = await tx.user.create({
    data: {
      id: firebaseUid,
      email: input.adminEmail,
      name: input.adminName,
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
}

async function setFirebaseClaims(
  firebaseUid: string,
  clientId: string,
): Promise<void> {
  try {
    await setCustomClaims(firebaseUid, {
      role: UserRole.CLIENT_ADMIN,
      clientId,
    });
  } catch (claimsErr) {
    logger.error(
      { err: claimsErr, uid: firebaseUid, clientId },
      "Failed to set Firebase custom claims after client creation — claims may be stale",
    );
  }
}

async function cleanupFirebaseUser(
  firebaseUid: string,
  email: string,
  context?: unknown,
): Promise<void> {
  await deleteFirebaseUser(firebaseUid).catch((cleanupErr) => {
    logger.error(
      { err: cleanupErr, uid: firebaseUid, email, originalError: context },
      "Failed to cleanup Firebase user after client creation failure - orphaned user may exist",
    );
  });
}

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
  const { adminEmail, adminPassword } = input;

  const firebaseUser = await createFirebaseUser(adminEmail, adminPassword);

  try {
    const { client, user } = await prisma.$transaction((tx) =>
      createClientTransaction(tx, input, firebaseUser.uid, performedBy),
    );

    await setFirebaseClaims(firebaseUser.uid, client.id);

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
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      await deleteFirebaseUser(firebaseUser.uid).catch((cleanupErr) => {
        logger.error(
          { err: cleanupErr, uid: firebaseUser.uid, email: adminEmail },
          "Failed to cleanup Firebase user after P2002 conflict",
        );
      });
      throw new AppError(
        "A user with this email already exists",
        409,
        true,
        ErrorCodes.CONFLICT,
      );
    }

    await cleanupFirebaseUser(firebaseUser.uid, adminEmail, error);
    throw error;
  }
}

/**
 * Get client by ID.
 */
export async function getClientById(id: string): Promise<PrismaClient | null> {
  return prisma.client.findUnique({ where: { id } });
}

/**
 * Get client by ID with the admin user record included.
 */
export async function getClientByIdWithAdmin(
  id: string,
): Promise<ClientWithAdmin | null> {
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

  // Best-effort: delete all Firebase users in parallel
  const results = await Promise.allSettled(
    userIds.map((uid) => deleteFirebaseUser(uid)),
  );
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      logger.error(
        { err: result.reason, uid: userIds[i] },
        "Failed to delete Firebase user during client deletion - orphaned Firebase user may exist",
      );
    }
  });
}

/**
 * Helper function to check if client exists (for validation in other modules).
 */
export async function clientExists(id: string): Promise<boolean> {
  const result = await prisma.client.findUnique({
    where: { id },
    select: { id: true },
  });
  return !!result;
}
