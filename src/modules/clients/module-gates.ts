import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import type { Prisma } from "@/generated/prisma/client.js";
import type { ModuleId } from "./clients.schema.js";

type ClientModuleState = {
  id?: string;
  active: boolean;
  enabledModules: string[] | null;
};

const MODULE_NAMES: Record<ModuleId, string> = {
  pricing: "Pricing",
  registrations: "Registrations",
  sponsorships: "Sponsorships",
  emails: "Emails",
  certificates: "Certificates",
  abstracts: "Abstracts",
};

export const CLIENT_MODULE_GATE_SELECT = {
  active: true,
  enabledModules: true,
} as const satisfies Prisma.ClientSelect;

export const CLIENT_MODULE_GATE_WITH_NAME_SELECT = {
  name: true,
  ...CLIENT_MODULE_GATE_SELECT,
} as const satisfies Prisma.ClientSelect;

export function assertModuleEnabledForClient(
  client: ClientModuleState,
  moduleId: ModuleId,
): void {
  if (!client.active) {
    throw new AppError("Client is inactive", 403, ErrorCodes.FORBIDDEN);
  }

  if (
    !Array.isArray(client.enabledModules) ||
    !client.enabledModules.includes(moduleId)
  ) {
    throw new AppError(
      `${MODULE_NAMES[moduleId]} module is disabled for this client`,
      403,
      ErrorCodes.FORBIDDEN,
    );
  }
}

export function isModuleEnabledForClient(
  client: ClientModuleState | null | undefined,
  moduleId: ModuleId,
): boolean {
  return (
    !!client?.active &&
    Array.isArray(client.enabledModules) &&
    client.enabledModules.includes(moduleId)
  );
}

export async function assertClientModuleEnabled(
  clientId: string,
  moduleId: ModuleId,
): Promise<void> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, ...CLIENT_MODULE_GATE_SELECT },
  });

  if (!client) {
    throw new AppError("Client not found", 404, ErrorCodes.NOT_FOUND);
  }

  assertModuleEnabledForClient(client, moduleId);
}
