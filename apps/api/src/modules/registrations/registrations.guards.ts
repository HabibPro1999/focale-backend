import { ErrorCodes } from "@app/contracts";
import type { DbExecutor } from "@app/db";
import { AppException } from "../../core/app-exception";
import type { AccessService } from "../access/access.service";

type AccessSelection = { accessId: string; quantity: number };

/** What the registrant owes in total: gross minus sponsorship, at least 0. */
export function netOf(amounts: { totalAmount: number; sponsorshipAmount: number }): number {
  return Math.max(0, amounts.totalAmount - amounts.sponsorshipAmount);
}

/** 400 when a paid amount exceeds the net (nothing is ever overpaid). */
export function assertPaidAmountWithinNet(paidAmount: number, net: number): void {
  if (paidAmount > net) {
    throw new AppException(
      ErrorCodes.BAD_REQUEST,
      "Paid amount cannot exceed registration total",
      400,
    );
  }
}

/** PAID means paid in full: 400 PAID_AMOUNT_BELOW_DUE when less than the net was paid. */
export function assertPaidInFull(paidAmount: number, net: number): void {
  if (paidAmount < net) {
    throw new AppException(
      ErrorCodes.PAID_AMOUNT_BELOW_DUE,
      "Paid amount is below the amount due; confirm it as PARTIAL",
      400,
      { amountDue: net, paidAmount },
    );
  }
}

/**
 * 400 BAD_REQUEST listing every problem with a set of access selections
 * (availability, eligibility, prerequisites, conflicts). Items in
 * `existingAccessIds` are the ones the registration already holds.
 */
export async function assertValidSelections(
  access: Pick<AccessService, "validateAccessSelections">,
  eventId: string,
  selections: AccessSelection[],
  formData: Record<string, unknown>,
  options: { existingAccessIds?: Set<string>; exec?: DbExecutor } = {},
): Promise<void> {
  const result = await access.validateAccessSelections(
    eventId,
    selections,
    formData,
    options.existingAccessIds,
    options.exec,
  );
  if (!result.valid) {
    throw new AppException(
      ErrorCodes.BAD_REQUEST,
      `Invalid access selections: ${result.errors.join(", ")}`,
      400,
      { errors: result.errors },
    );
  }
}
