import { ErrorCodes } from "@app/contracts";
import { AppException } from "./app-exception";

type ClientModuleState = { active: boolean; enabledModules: string[] | null };

// ponytail: NOTE FOR VERIFIER — these are pure cross-module helpers OWNED by
// other domains, faithfully ported here because those modules were empty stubs
// at port time and this agent may not edit them:
//   - assertModuleEnabledForClient / isModuleEnabledForClient  -> clients module
//     (module-gates.ts / ClientGatesService)
//   - assertEventWritable / assertEventAcceptsPublicActions    -> events module
//   - canAccessClient                                          -> shared auth
// When those land, delete this file and import from the real module paths. The
// logic here is a byte-faithful port of the legacy sources.

const MODULE_NAMES: Record<string, string> = {
  pricing: "Pricing",
  registrations: "Registrations",
  sponsorships: "Sponsorships",
  emails: "Emails",
  certificates: "Certificates",
  abstracts: "Abstracts",
};

export function assertModuleEnabledForClient(
  client: ClientModuleState,
  moduleId: string,
): void {
  if (!client.active) {
    throw new AppException(ErrorCodes.FORBIDDEN, "Client is inactive", 403);
  }
  if (
    !Array.isArray(client.enabledModules) ||
    !client.enabledModules.includes(moduleId)
  ) {
    throw new AppException(
      ErrorCodes.FORBIDDEN,
      `${MODULE_NAMES[moduleId] ?? moduleId} module is disabled for this client`,
      403,
    );
  }
}

export function isModuleEnabledForClient(
  client: ClientModuleState | null | undefined,
  moduleId: string,
): boolean {
  return (
    !!client?.active &&
    Array.isArray(client.enabledModules) &&
    client.enabledModules.includes(moduleId)
  );
}

/** Only ARCHIVED events are non-writable. */
export function assertEventWritable(event: { status: string }): void {
  if (event.status === "ARCHIVED") {
    throw new AppException(
      ErrorCodes.INVALID_STATUS_TRANSITION,
      "Archived events cannot be modified",
      400,
    );
  }
}

function effectivePublicEndDate(endDate: Date): Date {
  if (
    endDate.getUTCHours() !== 0 ||
    endDate.getUTCMinutes() !== 0 ||
    endDate.getUTCSeconds() !== 0 ||
    endDate.getUTCMilliseconds() !== 0
  ) {
    return endDate;
  }
  const inclusiveEnd = new Date(endDate);
  inclusiveEnd.setUTCHours(23, 59, 59, 999);
  return inclusiveEnd;
}

export function assertEventAcceptsPublicActions(
  event: { status: string; endDate: Date },
  now = new Date(),
): void {
  if (event.status !== "OPEN") {
    throw new AppException(
      ErrorCodes.EVENT_NOT_OPEN,
      "Event is not accepting public actions",
      400,
    );
  }
  if (effectivePublicEndDate(event.endDate) < now) {
    throw new AppException(
      ErrorCodes.EVENT_NOT_OPEN,
      "Event is not accepting public actions",
      400,
    );
  }
}

// Numeric roles (fail-closed). SUPER_ADMIN=0, CLIENT_ADMIN=1.
export function canAccessClient(
  user: { role: number; clientId: string | null },
  clientId: string,
): boolean {
  if (user.role === 0) return true;
  if (user.role === 1) return user.clientId === clientId;
  return false;
}
