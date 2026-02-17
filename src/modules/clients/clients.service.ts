import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";
import { auditLog, diffChanges } from "@shared/utils/audit.js";
import { invalidateClientCache } from "@shared/middleware/module.middleware.js";
import type {
  CreateClientInput,
  UpdateClientInput,
  ListClientsQuery,
} from "./clients.schema.js";
import { MODULE_IDS } from "./clients.schema.js";
import type { Client, Prisma } from "@/generated/prisma/client.js";

/**
 * Create a new client.
 */
export async function createClient(
  input: CreateClientInput,
  performedBy: string,
): Promise<Client> {
  const { name, logo, primaryColor, email, phone, enabledModules } = input;

  const client = await prisma.client.create({
    data: {
      name,
      logo: logo ?? null,
      primaryColor: primaryColor ?? null,
      email: email ?? null,
      phone: phone ?? null,
      enabledModules: enabledModules ?? [...MODULE_IDS],
    },
  });

  await auditLog(prisma, {
    entityType: "Client",
    entityId: client.id,
    action: "CREATE",
    performedBy,
  });

  return client;
}

/**
 * Get client by ID.
 */
export async function getClientById(id: string): Promise<Client | null> {
  return prisma.client.findUnique({ where: { id } });
}

/**
 * Update client.
 * Note: enabledModules uses one-way enable logic - modules can be added but never removed.
 */
export async function updateClient(
  id: string,
  input: UpdateClientInput,
  performedBy: string,
): Promise<Client> {
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
      "logo",
      "primaryColor",
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

    return updatedClient;
  });

  // Invalidate cache after successful update
  invalidateClientCache(id);

  return updatedClient;
}

/**
 * List clients with pagination and filters.
 */
export async function listClients(
  query: ListClientsQuery,
): Promise<PaginatedResult<Client>> {
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

  const [data, total] = await Promise.all([
    prisma.client.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.client.count({ where }),
  ]);

  return paginate(data, total, { page, limit });
}

/**
 * Delete client.
 * Prevents deletion if client has associated users or events.
 */
export async function deleteClient(
  id: string,
  performedBy: string,
): Promise<void> {
  // Check if client exists and count related data
  const client = await prisma.client.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          users: true,
          events: true,
        },
      },
    },
  });

  if (!client) {
    throw new AppError("Client not found", 404, true, ErrorCodes.NOT_FOUND);
  }

  // Check for associated users or events
  if (client._count.users > 0 || client._count.events > 0) {
    throw new AppError(
      `Cannot delete client with ${client._count.users} user(s) and ${client._count.events} event(s). Remove associated data first.`,
      409,
      true,
      ErrorCodes.CLIENT_HAS_DEPENDENCIES,
    );
  }

  await prisma.client.delete({ where: { id } });

  await auditLog(prisma, {
    entityType: "Client",
    entityId: id,
    action: "DELETE",
    performedBy,
  });

  // Invalidate cache after successful deletion
  invalidateClientCache(id);
}

/**
 * Helper function to check if client exists (for validation in other modules).
 */
export async function clientExists(id: string): Promise<boolean> {
  const count = await prisma.client.count({ where: { id } });
  return count > 0;
}
