import { ErrorCodes } from "@app/contracts";
import { findRegistrationForMutation, findRegistrationWithFormEvent, type DbExecutor } from "@app/db";
import { AppException, notFound, conflict } from "../../core/app-exception";
import { assertEventAcceptsPublicActions, assertEventWritable } from "../events";
import { assertModuleEnabledForClient, type ClientModuleState } from "../clients/module-gates";

/** Keep ownership/event-ID checks explicit between loading and writability. */
export async function requireRegistrationForMutation(id: string, exec: DbExecutor) {
  const registration = await findRegistrationForMutation(id, exec);
  if (!registration) {
    throw notFound("Registration not found", { code: ErrorCodes.REGISTRATION_NOT_FOUND });
  }
  return registration;
}

export function assertRegistrationWritable(registration: { event: { status: string; client: ClientModuleState } }): void {
  assertEventWritable(registration.event);
  assertModuleEnabledForClient(registration.event.client, "registrations");
}

export async function requireRegistrationForPublicAction(
  id: string,
  notFoundCode: typeof ErrorCodes.NOT_FOUND | typeof ErrorCodes.REGISTRATION_NOT_FOUND,
  exec?: DbExecutor,
) {
  const registration = await findRegistrationWithFormEvent(id, exec);
  if (!registration) throw notFound("Registration not found", { code: notFoundCode });
  assertEventAcceptsPublicActions(registration.event);
  assertModuleEnabledForClient(registration.event.client, "registrations");
  return registration;
}

export function registrationAlreadyExists(): AppException {
  return conflict("A registration with this email already exists for this form", { code: ErrorCodes.REGISTRATION_ALREADY_EXISTS });
}
