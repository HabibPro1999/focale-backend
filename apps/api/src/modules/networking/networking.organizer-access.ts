import { assertEventAccess } from "../../core/auth/assert-event-access";
import { type AuthUser } from "../../core/auth/user-cache";
import { assertClientModuleEnabled } from "../clients/module-gates";
import { assertEventWritable } from "../events/events.service";

export async function networkingOrganizerAccess(user: AuthUser, eventId: string, write = false) {
  const event = await assertEventAccess(user, eventId);
  await assertClientModuleEnabled(event.clientId, "networking");
  if (write) assertEventWritable(event);
  return event;
}
