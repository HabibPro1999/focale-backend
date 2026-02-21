import { getEventById } from "@modules/events/events.service.js";
import { canAccessClient } from "./auth.middleware.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import type { User } from "@/generated/prisma/client.js";

type EventWithPricing = NonNullable<Awaited<ReturnType<typeof getEventById>>>;

/**
 * Verify that the given user has access to the event identified by eventId.
 * Fetches the event, throws 404 if not found, throws 403 if the user cannot
 * access the event's client. Returns the fetched event so callers avoid a
 * second round-trip.
 */
export async function requireEventAccess(
  user: User,
  eventId: string,
): Promise<EventWithPricing> {
  const event = await getEventById(eventId);
  if (!event) {
    throw new AppError("Event not found", 404, true, ErrorCodes.NOT_FOUND);
  }

  if (!canAccessClient(user, event.clientId)) {
    throw new AppError(
      "Insufficient permissions",
      403,
      true,
      ErrorCodes.FORBIDDEN,
    );
  }

  return event;
}
