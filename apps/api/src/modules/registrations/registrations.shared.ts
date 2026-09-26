import { ErrorCodes } from "@app/contracts";
import { getRegistrationByIdRow, getRegistrationByIdempotencyKeyRow } from "@app/db";
import { AppException } from "../../core/app-exception";
import {
  enrichWithAccessSelections,
  type RegistrationWithRelations,
} from "./registrations.enrichment";
import { toAdminRegistration, type AdminView } from "./registrations.mappers";

// Helpers shared by the registration services (RegistrationsService,
// RegistrationCreateService, RegistrationRepricer, RegistrationPaymentsService):
// the admin view type, the email normalization and the row loaders.

/** Admin-facing registration: no editToken / idempotencyKey (see mappers). */
export type AdminRegistration = AdminView<RegistrationWithRelations>;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function getAdminRegistrationById(id: string): Promise<AdminRegistration | null> {
  const row = await getRegistrationByIdRow(id);
  if (!row) return null;
  return toAdminRegistration(await enrichWithAccessSelections(row));
}

export async function getEnrichedRow(id: string): Promise<RegistrationWithRelations> {
  const row = await getRegistrationByIdRow(id);
  if (!row) {
    throw new AppException(
      ErrorCodes.REGISTRATION_NOT_FOUND,
      "Registration not found",
      404,
    );
  }
  return enrichWithAccessSelections(row);
}

export async function getStrippedById(id: string): Promise<AdminRegistration> {
  const enriched = await getAdminRegistrationById(id);
  if (!enriched) {
    throw new AppException(
      ErrorCodes.REGISTRATION_NOT_FOUND,
      "Registration not found after update",
      404,
    );
  }
  return enriched;
}

/** editToken intentionally NOT stripped (renamed to `token` by the create route). */
export async function getRegistrationByIdempotencyKey(
  idempotencyKey: string,
): Promise<RegistrationWithRelations | null> {
  const row = await getRegistrationByIdempotencyKeyRow(idempotencyKey);
  if (!row) return null;
  return enrichWithAccessSelections(row);
}
