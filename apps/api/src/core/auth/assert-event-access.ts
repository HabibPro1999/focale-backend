import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { getEventWithPricing, type EventWithPricing } from "@app/db";
import { canAccessClient } from "./user-cache";

/**
 * Shared event-ownership gate: fetch the event (404 "Event not found"), then
 * canAccessClient (403 "Insufficient permissions"). Route-level 404/403 are
 * plain (code derived by the global filter). Returns the event so callers can
 * chain writability / module-gate checks.
 */
export async function assertEventAccess(
  user: { role: number; clientId: string | null },
  eventId: string,
): Promise<EventWithPricing> {
  const event = await getEventWithPricing(eventId);
  if (!event) throw new NotFoundException("Event not found");
  if (!canAccessClient(user, event.clientId)) {
    throw new ForbiddenException("Insufficient permissions");
  }
  return event;
}
