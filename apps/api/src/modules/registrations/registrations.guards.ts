import { ErrorCodes } from "@app/contracts";
import {
  findRegistrationForMutation,
  findRegistrationWithFormEvent,
  pgUniqueViolation,
  type DbExecutor,
} from "@app/db";
import { AppException, badRequest, conflict, notFound } from "../../core/app-exception";
import { assertModuleEnabledForClient, type ClientModuleState } from "../clients/module-gates";
import { assertEventAcceptsPublicActions, assertEventWritable } from "../events";

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

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function pgUnique(err: unknown): { isUnique: boolean; constraint: string } {
  const v = pgUniqueViolation(err);
  return { isUnique: v !== null, constraint: v?.constraint ?? "" };
}

/**
 * Reproduce the legacy global P2002 mapping (the target core filter does not yet
 * carry it): email+form unique violation → REGISTRATION_ALREADY_EXISTS, any other
 * unique violation → RES_3002. Idempotency-key violations are RE-THROWN untouched
 * so the public-create idempotency-race recovery can still catch them.
 */
export function translateCreateUniqueViolation(err: unknown): never {
  const { isUnique, constraint } = pgUnique(err);
  if (!isUnique || /idempotency/i.test(constraint)) throw err;
  if (/email/i.test(constraint) || constraint === "registrations_email_form_id_key") {
    throw registrationAlreadyExists();
  }
  throw conflict("Resource already exists");
}

export function assertLabSponsorshipAllowed(
  client: { enabledModules: string[] | null },
  paymentMethod: string | null | undefined,
): void {
  if (
    paymentMethod === "LAB_SPONSORSHIP" &&
    (client.enabledModules ?? []).includes("sponsorships")
  ) {
    throw badRequest("Lab sponsorship payment method is only available when sponsorships are disabled", { code: ErrorCodes.BAD_REQUEST });
  }
}
