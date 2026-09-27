import { ErrorCodes } from "@app/contracts";
import { findEventClientId } from "@app/db";
import { AppException } from "../../core/app-exception";
import { assertClientModuleEnabled } from "../clients/module-gates";

export async function assertAbstractModuleEnabled(eventId: string): Promise<void> {
  const event = await findEventClientId(eventId);
  if (!event) {
    throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
  }
  await assertClientModuleEnabled(event.clientId, "abstracts");
}
