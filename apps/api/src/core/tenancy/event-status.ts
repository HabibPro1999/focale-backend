import { ErrorCodes } from "@app/contracts";
import { badRequest } from "../app-exception";

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

export function assertEventWritable(event: { status: string }): void {
  if (event.status === "ARCHIVED") {
    throw badRequest("Archived events cannot be modified", { code: ErrorCodes.INVALID_STATUS_TRANSITION });
  }
}

export function assertEventOpen(event: { status: string }): void {
  if (event.status !== "OPEN") {
    throw badRequest("Event is not accepting public actions", { code: ErrorCodes.EVENT_NOT_OPEN });
  }
}

export function assertEventAcceptsPublicActions(
  event: { status: string; endDate: Date },
  now = new Date(),
): void {
  assertEventOpen(event);
  if (effectivePublicEndDate(event.endDate) < now) {
    throw badRequest("Event is not accepting public actions", { code: ErrorCodes.EVENT_NOT_OPEN });
  }
}

// Valid event status transitions: CLOSED -> OPEN -> ARCHIVED (terminal).
export const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  CLOSED: ["OPEN"],
  OPEN: ["CLOSED", "ARCHIVED"],
  ARCHIVED: [],
};
