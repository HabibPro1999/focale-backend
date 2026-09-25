import { and, count, eq, or, sql } from "drizzle-orm";
import type { PriceBreakdown } from "@app/contracts";
import { calculateApplicableAmount } from "@app/shared";
import type { DbExecutor } from "../client";
import { lockSponsorshipByCodeForUpdate } from "../locks";
import { casSetSponsorshipUsed, insertUsage, type SponsorshipUsageRow } from "../queries/sponsorships";
import { registrations } from "../schema/registrations";
import { sponsorships, sponsorshipUsages } from "../schema/sponsorships";
import { isTransactionExecutor } from "../txn";

// Sponsorship codes are single use (plan 2.7). A code is consumed by linking
// its sponsorship to one registration: a usage row, the sponsorship set USED,
// then settleRegistrationTxn. Every path that consumes a code locks the
// sponsorship first (lock order sponsorship → registration → counters), so
// two claims on one code queue on that row and the second sees the first.

/** The sponsorship fields a link needs. */
export interface LinkableSponsorship {
  id: string;
  eventId: string;
  code: string;
  status: "PENDING" | "USED" | "CANCELLED";
  targetRegistrationId: string | null;
  totalAmount: number;
  coversBasePrice: boolean;
  coveredAccessIds: string[];
}

/** Why a code cannot be used at signup. */
export type SponsorshipCodeUnavailableReason =
  /** Already linked (status USED). */
  | "USED"
  /** Reserved for one registration by a linked-mode batch. */
  | "TARGETED"
  /** Has a usage although still PENDING. */
  | "LINKED"
  /** Stored as the signup code of an existing registration (a claim made before codes were consumed). */
  | "CLAIMED";

export type SponsorshipCodeClaim =
  /** No such code for the event, or it was cancelled. */
  | { outcome: "invalid" }
  | { outcome: "used"; reason: SponsorshipCodeUnavailableReason; sponsorshipId: string }
  | { outcome: "available"; sponsorship: LinkableSponsorship };

function assertInTransaction(tx: DbExecutor, name: string): void {
  if (!isTransactionExecutor(tx)) {
    throw new Error(`${name} must run inside a transaction`);
  }
}

/** Read a sponsorship's link fields (no lock; callers lock first). */
export async function readLinkableSponsorship(
  tx: DbExecutor,
  sponsorshipId: string,
): Promise<LinkableSponsorship | null> {
  const [row] = await tx
    .select({
      id: sponsorships.id,
      eventId: sponsorships.eventId,
      code: sponsorships.code,
      status: sponsorships.status,
      targetRegistrationId: sponsorships.targetRegistrationId,
      totalAmount: sponsorships.totalAmount,
      coversBasePrice: sponsorships.coversBasePrice,
      coveredAccessIds: sponsorships.coveredAccessIds,
    })
    .from(sponsorships)
    .where(eq(sponsorships.id, sponsorshipId))
    .limit(1);
  return row ? { ...row, coveredAccessIds: row.coveredAccessIds ?? [] } : null;
}

/** How many usages link this sponsorship. */
export async function countSponsorshipUsages(tx: DbExecutor, sponsorshipId: string): Promise<number> {
  const [row] = await tx
    .select({ value: count() })
    .from(sponsorshipUsages)
    .where(eq(sponsorshipUsages.sponsorshipId, sponsorshipId));
  return Number(row?.value ?? 0);
}

/**
 * The event's registrations whose stored signup code is `code` once trimmed
 * and upper-cased (legacy rows kept the raw input), oldest first.
 */
export async function findSponsorshipCodeClaimants(
  tx: DbExecutor,
  eventId: string,
  code: string,
  limit?: number,
): Promise<Array<{ id: string; createdAt: Date }>> {
  const query = tx
    .select({ id: registrations.id, createdAt: registrations.createdAt })
    .from(registrations)
    .where(
      and(
        eq(registrations.eventId, eventId),
        or(
          eq(registrations.sponsorshipCode, code),
          sql`upper(trim(${registrations.sponsorshipCode})) = ${code}`,
        ),
      ),
    )
    .orderBy(registrations.createdAt, registrations.id);
  return limit === undefined ? query : query.limit(limit);
}

/**
 * Lock the event's sponsorship with this code (already normalized) and decide,
 * from the locked row, whether a new registration may consume it:
 * - no such code, or CANCELLED → invalid;
 * - USED, targeted at a registration, already linked, or stored as another
 *   registration's signup code → used;
 * - otherwise available.
 * Take this lock before anything else in the transaction.
 */
export async function claimSponsorshipCodeTxn(
  tx: DbExecutor,
  eventId: string,
  code: string,
): Promise<SponsorshipCodeClaim> {
  assertInTransaction(tx, "claimSponsorshipCodeTxn");
  const sponsorshipId = await lockSponsorshipByCodeForUpdate(tx, eventId, code);
  if (!sponsorshipId) return { outcome: "invalid" };
  const sponsorship = await readLinkableSponsorship(tx, sponsorshipId);
  if (!sponsorship || sponsorship.status === "CANCELLED") return { outcome: "invalid" };
  if (sponsorship.status === "USED") return { outcome: "used", reason: "USED", sponsorshipId };
  if (sponsorship.targetRegistrationId !== null) return { outcome: "used", reason: "TARGETED", sponsorshipId };
  if ((await countSponsorshipUsages(tx, sponsorshipId)) > 0) return { outcome: "used", reason: "LINKED", sponsorshipId };
  if ((await findSponsorshipCodeClaimants(tx, eventId, code, 1)).length > 0) {
    return { outcome: "used", reason: "CLAIMED", sponsorshipId };
  }
  return { outcome: "available", sponsorship };
}

/** What the sponsorship covers of this breakdown, as settleRegistrationTxn recomputes it. */
export function sponsorshipAmountFor(
  sponsorship: Pick<LinkableSponsorship, "totalAmount" | "coversBasePrice" | "coveredAccessIds">,
  priceBreakdown: Pick<PriceBreakdown, "subtotal" | "calculatedBasePrice" | "accessItems">,
): number {
  return calculateApplicableAmount(sponsorship, {
    totalAmount: priceBreakdown.subtotal,
    baseAmount: priceBreakdown.calculatedBasePrice,
    accessTypeIds: priceBreakdown.accessItems.map((item) => item.accessId),
    priceBreakdown,
  });
}

/**
 * Link a locked sponsorship to a registration: insert the usage (its amount
 * against `priceBreakdown`, the gross breakdown the caller settles with) and
 * set the sponsorship USED, which must change exactly one row. The caller
 * then settles the registration (settleRegistrationTxn) with
 * `coveredAccessIdsBefore` set to what was covered before this usage.
 */
export async function linkSponsorshipUsageTxn(
  tx: DbExecutor,
  args: {
    sponsorship: LinkableSponsorship;
    registrationId: string;
    priceBreakdown: Pick<PriceBreakdown, "subtotal" | "calculatedBasePrice" | "accessItems">;
    appliedBy: string;
  },
): Promise<SponsorshipUsageRow> {
  assertInTransaction(tx, "linkSponsorshipUsageTxn");
  const usage = await insertUsage(tx, {
    sponsorshipId: args.sponsorship.id,
    registrationId: args.registrationId,
    amountApplied: sponsorshipAmountFor(args.sponsorship, args.priceBreakdown),
    appliedBy: args.appliedBy,
  });
  const updated = await casSetSponsorshipUsed(tx, args.sponsorship.id);
  if (updated !== 1) {
    throw new Error(`Sponsorship ${args.sponsorship.id} could not be set USED (cancelled while locked?)`);
  }
  return usage;
}
