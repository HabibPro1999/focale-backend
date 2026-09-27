import { type PriceBreakdown } from "@app/contracts";
import { findRegistrationUsagesForRecalc, updateUsageAmount, type DbExecutor } from "@app/db";
import {
  calculateApplicableAmount,
  withSponsorshipTotal,
} from "@app/shared";
import type { AccessService } from "../access/access.service";
import { statusAfterRegistrationRecalc } from "../sponsorships/sponsorship-settlement";

interface RecalcInput {
  id: string;
  paymentStatus: string;
  paidAt: Date | null;
  paidAmount: number;
}

interface SettlementResult {
  priceBreakdown: PriceBreakdown;
  sponsorshipAmount: number;
  paymentStatus?: "PENDING" | "PARTIAL" | "SPONSORED" | "PAID";
  paidAt?: Date | null;
  coveredAccessIds: Set<string>;
}

export async function syncPaidCount(
  access: AccessService,
  exec: DbExecutor,
  registration: { id: string; eventId: string; priceBreakdown: unknown },
  oldStatus: string,
  newStatus: string,
): Promise<void> {
  const coveredAccessIds =
    oldStatus === "PARTIAL" || newStatus === "PARTIAL"
      ? await access.getAlreadyCoveredAccessIds(registration.id, exec)
      : new Set<string>();
  await access.syncPaidCountDelta(
    registration.eventId,
    { status: oldStatus, priceBreakdown: registration.priceBreakdown, coveredAccessIds },
    { status: newStatus, priceBreakdown: registration.priceBreakdown, coveredAccessIds },
    exec,
  );
}

export async function recalculateLinkedSponsorshipSettlement(
  exec: DbExecutor,
  registration: RecalcInput,
  priceBreakdown: PriceBreakdown,
  totalAmount = priceBreakdown.subtotal,
): Promise<SettlementResult> {
  const usages = await findRegistrationUsagesForRecalc(registration.id, exec);
  const accessTypeIds = priceBreakdown.accessItems.map((i) => i.accessId);
  const coveredAccessIds = new Set<string>();
  let sponsorshipAmount = 0;

  if (usages.length === 0) sponsorshipAmount = priceBreakdown.sponsorshipTotal;

  for (const usage of usages) {
    for (const accessId of usage.sponsorship.coveredAccessIds) {
      coveredAccessIds.add(accessId);
    }
    const amountApplied = calculateApplicableAmount(usage.sponsorship, {
      totalAmount: priceBreakdown.subtotal,
      baseAmount: priceBreakdown.calculatedBasePrice,
      accessTypeIds,
      priceBreakdown,
    });
    sponsorshipAmount += amountApplied;
    if (amountApplied !== usage.amountApplied) {
      await updateUsageAmount(exec, usage.id, amountApplied);
    }
  }

  sponsorshipAmount = Math.min(sponsorshipAmount, priceBreakdown.subtotal);
  const updatedBreakdown = withSponsorshipTotal(priceBreakdown, priceBreakdown.subtotal, sponsorshipAmount);

  const result: SettlementResult = {
    priceBreakdown: updatedBreakdown,
    sponsorshipAmount,
    coveredAccessIds,
  };

  return Object.assign(result, statusAfterRegistrationRecalc(registration, sponsorshipAmount, totalAmount));
}
