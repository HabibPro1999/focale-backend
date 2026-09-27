import { ErrorCodes } from "@app/contracts";
import {
  findRegistrationForMutation,
  findRegistrationWithFormEvent,
  lockRegistrationForUpdate,
  type DbExecutor,
} from "@app/db";
import { AppException } from "../../core/app-exception";

function requireRegistration<T>(registration: T | null): T {
  if (!registration) {
    throw new AppException(ErrorCodes.REGISTRATION_NOT_FOUND, "Registration not found", 404);
  }
  return registration;
}

/** The caller owns preceding sponsorship locks and all gates after this read. */
export async function lockRegistrationForMutation(id: string, tx: DbExecutor) {
  const locked = await lockRegistrationForUpdate(tx, id);
  return requireRegistration(locked ? await findRegistrationForMutation(id, tx) : null);
}

export async function loadRegistrationForPublicAction(id: string, exec?: DbExecutor) {
  return requireRegistration(await findRegistrationWithFormEvent(id, exec));
}

/** Keep the fresh read after the registration lock, including proof-upload rechecks. */
export async function lockRegistrationForPublicAction(id: string, tx: DbExecutor) {
  const locked = await lockRegistrationForUpdate(tx, id);
  return requireRegistration(locked ? await findRegistrationWithFormEvent(id, tx) : null);
}
