import { ErrorCodes, type AppEvent } from "@app/contracts";
import {
  SponsorshipSettlementError,
  settlementEventPair,
  type SettleRegistrationResult,
} from "@app/db";
import { toAccessAppException } from "../access/access.service";
import { AppException } from "../../core/app-exception";

// Helpers shared by the public batch intake (sponsorships.public.service.ts)
// and the admin operations (sponsorships.admin.service.ts). Nothing here
// changes a sponsorship: it maps the settlement refusals and builds the
// events of a settlement that already happened.

/**
 * The sponsorship settlement refusals (@app/db) and access paid-count errors
 * as the API's AppExceptions. Messages and codes of the refusals that
 * existed before plan 2.8 are unchanged.
 */
export function toSponsorshipAppException(err: unknown): unknown {
  if (!(err instanceof SponsorshipSettlementError)) return toAccessAppException(err);
  const { details } = err;
  switch (err.reason) {
    case "SPONSORSHIP_NOT_FOUND":
      return new AppException(ErrorCodes.NOT_FOUND, "Sponsorship not found", 404);
    case "SPONSORSHIP_CANCELLED":
      return new AppException(ErrorCodes.BAD_REQUEST, "Cannot link a cancelled sponsorship", 400, {
        code: "SPONSORSHIP_CANCELLED",
      });
    case "REGISTRATION_NOT_FOUND":
      return new AppException(ErrorCodes.REGISTRATION_NOT_FOUND, "Registration not found", 404);
    case "EVENT_MISMATCH":
      return new AppException(
        ErrorCodes.BAD_REQUEST,
        "Sponsorship and registration must be for the same event",
        400,
      );
    case "ALREADY_LINKED":
      return new AppException(ErrorCodes.CONFLICT, "Sponsorship is already linked to this registration", 409, {
        code: "SPONSORSHIP_ALREADY_LINKED",
      });
    case "NOT_LINKED":
      return new AppException(ErrorCodes.NOT_FOUND, "Sponsorship is not linked to this registration", 404);
    case "NOT_APPLICABLE":
      return new AppException(
        ErrorCodes.SPONSORSHIP_NOT_APPLICABLE,
        "Sponsorship coverage does not apply to this registration (no overlap between sponsored items and registration selections)",
        400,
      );
    case "TARGET_SETTLED":
      return new AppException(
        ErrorCodes.SPONSORSHIP_TARGET_SETTLED,
        `The registration is ${details.paymentStatus}: its sponsorship cannot change`,
        409,
        { registrationId: details.registrationId, paymentStatus: details.paymentStatus },
      );
    case "EXCEEDS_AMOUNT_DUE":
      return new AppException(
        ErrorCodes.SPONSORSHIP_EXCEEDS_AMOUNT_DUE,
        "The registration has already paid more than it would owe with this sponsorship",
        409,
        { registrationId: details.registrationId, paidAmount: details.paidAmount, amountDue: details.amountDue },
      );
  }
  return err;
}

export function rethrowSponsorshipException(err: unknown): never {
  throw toSponsorshipAppException(err);
}

/** Registration events after a sponsorship change settled it (networking re-sync included). */
export function registrationEvents(
  clientId: string,
  registrationId: string,
  settled: SettleRegistrationResult,
): AppEvent[] {
  const moved = [...settled.paidAccess.incremented, ...settled.paidAccess.decremented];
  return settlementEventPair({
    id: registrationId,
    eventId: settled.eventId,
    clientId,
    oldStatus: settled.before.paymentStatus,
    newStatus: settled.after.paymentStatus,
    emitCountsChanged: false,
    accessIds: moved,
  });
}

export function countsChanged(clientId: string, eventId: string, settled: SettleRegistrationResult[]): AppEvent {
  const accessIds = new Set<string>();
  for (const result of settled) {
    for (const id of [...result.paidAccess.incremented, ...result.paidAccess.decremented]) accessIds.add(id);
  }
  return {
    type: "eventAccess.countsChanged",
    clientId,
    eventId,
    payload: { id: eventId, accessIds: [...accessIds].sort() },
    ts: Date.now(),
  };
}
