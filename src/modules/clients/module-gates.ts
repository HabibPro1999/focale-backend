import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import type { ModuleId } from "./clients.schema.js";

type ClientModuleState = {
  id?: string;
  enabledModules: string[];
};

const MODULE_NAMES: Record<ModuleId, string> = {
  pricing: "Pricing",
  registrations: "Registrations",
  sponsorships: "Sponsorships",
  emails: "Emails",
  certificates: "Certificates",
  abstracts: "Abstracts",
};

export function assertModuleEnabledForClient(
  client: ClientModuleState,
  moduleId: ModuleId,
): void {
  if (!client.enabledModules.includes(moduleId)) {
    throw new AppError(
      `${MODULE_NAMES[moduleId]} module is disabled for this client`,
      403,
      ErrorCodes.FORBIDDEN,
    );
  }
}

export async function assertClientModuleEnabled(
  clientId: string,
  moduleId: ModuleId,
): Promise<void> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, enabledModules: true },
  });

  if (!client) {
    throw new AppError("Client not found", 404, ErrorCodes.NOT_FOUND);
  }

  assertModuleEnabledForClient(client, moduleId);
}
