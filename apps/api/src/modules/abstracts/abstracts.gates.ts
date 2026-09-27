import { ErrorCodes } from "@app/contracts";
import { findEventClientId } from "@app/db";
import { notFound } from "../../core/app-exception";
import { assertClientModuleEnabled } from "../clients/module-gates";

/** Recheck the module for both members and existing magic-link holders. */
export async function assertAbstractModuleEnabled(eventId: string): Promise<void> {
  const event = await findEventClientId(eventId);
  if (!event) {
    throw notFound("Event not found");
  }
  await assertClientModuleEnabled(event.clientId, "abstracts");
}
