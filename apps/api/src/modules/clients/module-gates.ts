import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ErrorCodes, type ModuleId } from "@app/contracts";
import { findClientModuleState, type DbExecutor } from "@app/db";

// Re-exported so the ~10 consumer modules (forms, access, certificates,
// abstracts, sponsorships, email, registrations, pricing, events, identity)
// have a single clients-domain import point, matching the legacy `@clients`.
export { clientExists } from "@app/db";

/** The client fields a module-gate check needs (legacy CLIENT_MODULE_GATE_SELECT). */
export type ClientModuleState = {
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
  networking: "Networking",
};

/** Sync gate for callers that already loaded the client (e.g. via event.client join). */
export function assertModuleEnabledForClient(
  client: ClientModuleState,
  moduleId: ModuleId,
): void {
  if (!client.active) {
    throw new ForbiddenException({
      code: ErrorCodes.CLIENT_INACTIVE,
      message: "Client is inactive",
    });
  }

  if (
    !Array.isArray(client.enabledModules) ||
    !client.enabledModules.includes(moduleId)
  ) {
    throw new ForbiddenException({
      code: ErrorCodes.MODULE_DISABLED,
      message: `${MODULE_NAMES[moduleId]} module is disabled for this client`,
    });
  }
}

/** Non-throwing variant. Returns false for null/undefined client or null modules. */
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

/**
 * DB-backed gate: loads the client's active/modules state then asserts. Inside
 * a transaction pass its executor, so the check rides that connection.
 */
export async function assertClientModuleEnabled(
  clientId: string,
  moduleId: ModuleId,
  executor?: DbExecutor,
): Promise<void> {
  const client = await findClientModuleState(clientId, executor);
  if (!client) {
    throw new NotFoundException({
      code: ErrorCodes.NOT_FOUND,
      message: "Client not found",
    });
  }
  assertModuleEnabledForClient(client, moduleId);
}
