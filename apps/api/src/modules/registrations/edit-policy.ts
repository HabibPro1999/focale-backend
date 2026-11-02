import { ErrorCodes } from "@app/contracts";
import { AppException } from "../../core/app-exception";
import {
  assertModuleEnabledForClient,
  isModuleEnabledForClient,
  type ClientModuleState,
} from "../clients/module-gates";
import { eventAcceptsPublicActions } from "../events";

/** Why a registrant cannot edit anything, in the order the edit checks them. */
export type EditBlock =
  | "REFUNDED"
  | "EVENT_CLOSED"
  | "REGISTRATIONS_DISABLED"
  | "PRICING_DISABLED";

/** Why a registrant cannot change access selections, in check order. */
export type AccessEditBlock = "VERIFYING" | "WAIVED" | "FULLY_SPONSORED";

export interface EditPolicyInput {
  registration: {
    paymentStatus: string;
    paidAmount: number;
    totalAmount: number;
    sponsorshipAmount: number;
  };
  event: {
    status: string;
    endDate: Date;
    client: ClientModuleState | null | undefined;
  };
  now: Date;
}

export interface EditPolicy {
  canEdit: boolean;
  canEditPersonalInfo: boolean;
  canEditAccess: boolean;
  canAddAccess: boolean;
  canRemoveAccess: boolean;
  isFullySponsored: boolean;
  /** Payment was received: access items can be added, not removed. */
  paymentReceived: boolean;
  editBlocks: EditBlock[];
  accessBlocks: AccessEditBlock[];
  /** The reasons shown to the registrant, in order. */
  restrictions: string[];
}

const EDIT_BLOCK_REASONS: Record<EditBlock, string> = {
  REFUNDED: "Registration has been refunded",
  EVENT_CLOSED: "Event is not accepting changes",
  REGISTRATIONS_DISABLED: "Registrations are disabled for this event",
  PRICING_DISABLED: "Pricing is disabled for this event",
};

const ACCESS_BLOCK_REASONS: Record<AccessEditBlock, string> = {
  VERIFYING: "Payment proof is under review",
  WAIVED: "Waived registrations cannot modify access selections",
  FULLY_SPONSORED: "Fully sponsored registration cannot modify access selections",
};

const REMOVAL_BLOCK_REASON = "Cannot remove access items (payment received)";

/**
 * What a registrant may change in a self-edit. Pure: GET-for-edit shows it
 * and the edit enforces it, so both agree, including on the event's last day
 * (eventAcceptsPublicActions).
 */
export function evaluateEditPolicy(input: EditPolicyInput): EditPolicy {
  const { registration, event, now } = input;

  const editBlocks: EditBlock[] = [];
  if (registration.paymentStatus === "REFUNDED") editBlocks.push("REFUNDED");
  if (!eventAcceptsPublicActions(event, now)) editBlocks.push("EVENT_CLOSED");
  if (!isModuleEnabledForClient(event.client, "registrations")) {
    editBlocks.push("REGISTRATIONS_DISABLED");
  }
  if (!isModuleEnabledForClient(event.client, "pricing")) {
    editBlocks.push("PRICING_DISABLED");
  }

  const isFullySponsored =
    registration.totalAmount > 0 &&
    registration.sponsorshipAmount >= registration.totalAmount;
  const accessBlocks: AccessEditBlock[] = [];
  if (registration.paymentStatus === "VERIFYING") accessBlocks.push("VERIFYING");
  if (registration.paymentStatus === "WAIVED") accessBlocks.push("WAIVED");
  if (isFullySponsored) accessBlocks.push("FULLY_SPONSORED");

  const paymentReceived =
    registration.paymentStatus === "PAID" ||
    registration.paymentStatus === "SPONSORED" ||
    registration.paidAmount > 0;

  const canEdit = editBlocks.length === 0;
  const canEditAccess = canEdit && accessBlocks.length === 0;
  const restrictions = editBlocks.map((block) => EDIT_BLOCK_REASONS[block]);
  // Same order as before the policy existed: the proof review, then removal,
  // then waived and fully sponsored.
  if (accessBlocks.includes("VERIFYING")) restrictions.push(ACCESS_BLOCK_REASONS.VERIFYING);
  if (paymentReceived) restrictions.push(REMOVAL_BLOCK_REASON);
  for (const block of accessBlocks) {
    if (block !== "VERIFYING") restrictions.push(ACCESS_BLOCK_REASONS[block]);
  }

  return {
    canEdit,
    canEditPersonalInfo: canEdit,
    canEditAccess,
    canAddAccess: canEditAccess,
    canRemoveAccess: canEditAccess && !paymentReceived,
    isFullySponsored,
    paymentReceived,
    editBlocks,
    accessBlocks,
    restrictions,
  };
}

/**
 * Enforce the policy for a self-edit: the first blocking reason throws the
 * error the edit has always returned for it.
 */
export function assertSelfEditAllowed(
  policy: EditPolicy,
  client: ClientModuleState,
  attempt: { changesAccess: boolean; removedAccessIds: string[] },
): void {
  for (const block of policy.editBlocks) {
    switch (block) {
      case "REFUNDED":
        throw new AppException(
          ErrorCodes.REGISTRATION_REFUNDED,
          "Refunded registrations cannot be edited",
          400,
        );
      case "EVENT_CLOSED":
        throw new AppException(
          ErrorCodes.REGISTRATION_EDIT_FORBIDDEN,
          "Event is not accepting changes",
          400,
        );
      case "REGISTRATIONS_DISABLED":
        assertModuleEnabledForClient(client, "registrations");
        break;
      case "PRICING_DISABLED":
        assertModuleEnabledForClient(client, "pricing");
        break;
    }
  }
  if (attempt.changesAccess) {
    for (const block of policy.accessBlocks) {
      switch (block) {
        case "VERIFYING":
          throw new AppException(
            ErrorCodes.REGISTRATION_VERIFYING_BLOCKED,
            "Cannot modify access while payment is under review",
            400,
          );
        case "WAIVED":
          throw new AppException(
            ErrorCodes.REGISTRATION_WAIVED_ACCESS_BLOCKED,
            "Waived registrations cannot modify access selections",
            400,
          );
        case "FULLY_SPONSORED":
          throw new AppException(
            ErrorCodes.REGISTRATION_FULLY_SPONSORED_BLOCKED,
            "Fully sponsored registrations cannot modify access selections",
            400,
          );
      }
    }
  }
  if (policy.paymentReceived && attempt.removedAccessIds.length > 0) {
    throw new AppException(
      ErrorCodes.REGISTRATION_ACCESS_REMOVAL_BLOCKED,
      "Cannot remove access items from a paid registration",
      400,
      {
        message: "Paid registrations can only add new access items",
        attemptedRemovals: attempt.removedAccessIds,
      },
    );
  }
}
