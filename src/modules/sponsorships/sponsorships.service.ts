import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { auditLog } from "@shared/utils/audit.js";
import { validateCoveredAccessTimeOverlap } from "./sponsorships.utils.js";
import type { UpdateSponsorshipInput } from "./sponsorships.schema.js";
import type {
  Prisma,
  Sponsorship,
  SponsorshipBatch,
  SponsorshipUsage,
} from "@/generated/prisma/client.js";
import {
  unlinkSponsorshipFromAllRegistrations,
  recalculateUsageAmounts,
} from "./sponsorship-linking.js";
import { getSponsorshipById } from "./sponsorship-queries.js";

// ============================================================================
// Types (kept for return signatures)
// ============================================================================

type SponsorshipWithUsages = Sponsorship & {
  batch: SponsorshipBatch;
  usages: Array<
    SponsorshipUsage & {
      registration: {
        id: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
      };
    }
  >;
};

// ============================================================================
// Update Sponsorship (Admin)
// ============================================================================

/**
 * Update sponsorship coverage, beneficiary info, or cancel it.
 */
export async function updateSponsorship(
  id: string,
  input: UpdateSponsorshipInput,
  performedBy?: string,
): Promise<SponsorshipWithUsages> {
  if (input.status === "CANCELLED") {
    return cancelSponsorship(id, performedBy);
  }

  await prisma.$transaction(async (tx) => {
    const sponsorship = await tx.sponsorship.findUnique({
      where: { id },
      include: { usages: true },
    });

    if (!sponsorship) {
      throw new AppError("Sponsorship not found", 404, ErrorCodes.NOT_FOUND);
    }

    const coverageChanged =
      input.coversBasePrice !== undefined ||
      input.coveredAccessIds !== undefined;

    const nextCoversBasePrice =
      input.coversBasePrice ?? sponsorship.coversBasePrice;
    const nextCoveredAccessIds =
      input.coveredAccessIds ?? sponsorship.coveredAccessIds;

    if (
      input.coveredAccessIds !== undefined &&
      nextCoveredAccessIds.length >= 2
    ) {
      const accessItems = await tx.eventAccess.findMany({
        where: {
          id: { in: nextCoveredAccessIds },
          eventId: sponsorship.eventId,
          active: true,
        },
        select: {
          id: true,
          name: true,
          type: true,
          groupLabel: true,
          startsAt: true,
          endsAt: true,
        },
      });

      const timeErrors = validateCoveredAccessTimeOverlap(
        nextCoveredAccessIds,
        accessItems.map((item) => ({
          id: item.id,
          name: item.name,
          type: item.type,
          groupLabel: item.groupLabel,
          startsAt: item.startsAt,
          endsAt: item.endsAt,
        })),
      );

      if (timeErrors.length > 0) {
        throw new AppError(
          `Time conflicts in covered access items: ${timeErrors.join("; ")}`,
          400,
          ErrorCodes.BAD_REQUEST,
          { timeConflicts: timeErrors },
        );
      }
    }

    let nextTotalAmount = sponsorship.totalAmount;
    if (coverageChanged) {
      nextTotalAmount = 0;
      if (nextCoversBasePrice) {
        const pricing = await tx.eventPricing.findUnique({
          where: { eventId: sponsorship.eventId },
          select: { basePrice: true },
        });
        nextTotalAmount += pricing?.basePrice ?? 0;
      }

      if (nextCoveredAccessIds.length > 0) {
        const accessItems = await tx.eventAccess.findMany({
          where: {
            id: { in: nextCoveredAccessIds },
            eventId: sponsorship.eventId,
            active: true,
          },
          select: { price: true },
        });
        nextTotalAmount += accessItems.reduce(
          (sum, item) => sum + item.price,
          0,
        );
      }
    }

    const updateData: Prisma.SponsorshipUpdateInput = {};
    if (input.beneficiaryName !== undefined) {
      updateData.beneficiaryName = input.beneficiaryName;
    }
    if (input.beneficiaryEmail !== undefined) {
      updateData.beneficiaryEmail = input.beneficiaryEmail;
    }
    if (input.beneficiaryPhone !== undefined) {
      updateData.beneficiaryPhone = input.beneficiaryPhone;
    }
    if (input.beneficiaryAddress !== undefined) {
      updateData.beneficiaryAddress = input.beneficiaryAddress;
    }
    if (coverageChanged) {
      updateData.coversBasePrice = nextCoversBasePrice;
      updateData.coveredAccessIds = nextCoveredAccessIds;
      updateData.totalAmount = nextTotalAmount;
    }

    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (
      input.beneficiaryName !== undefined &&
      input.beneficiaryName !== sponsorship.beneficiaryName
    ) {
      changes.beneficiaryName = {
        old: sponsorship.beneficiaryName,
        new: input.beneficiaryName,
      };
    }
    if (
      input.beneficiaryEmail !== undefined &&
      input.beneficiaryEmail !== sponsorship.beneficiaryEmail
    ) {
      changes.beneficiaryEmail = {
        old: sponsorship.beneficiaryEmail,
        new: input.beneficiaryEmail,
      };
    }
    if (
      input.beneficiaryPhone !== undefined &&
      input.beneficiaryPhone !== sponsorship.beneficiaryPhone
    ) {
      changes.beneficiaryPhone = {
        old: sponsorship.beneficiaryPhone,
        new: input.beneficiaryPhone,
      };
    }
    if (
      input.beneficiaryAddress !== undefined &&
      input.beneficiaryAddress !== sponsorship.beneficiaryAddress
    ) {
      changes.beneficiaryAddress = {
        old: sponsorship.beneficiaryAddress,
        new: input.beneficiaryAddress,
      };
    }
    if (coverageChanged) {
      if (nextCoversBasePrice !== sponsorship.coversBasePrice) {
        changes.coversBasePrice = {
          old: sponsorship.coversBasePrice,
          new: nextCoversBasePrice,
        };
      }
      if (
        JSON.stringify(nextCoveredAccessIds) !==
        JSON.stringify(sponsorship.coveredAccessIds)
      ) {
        changes.coveredAccessIds = {
          old: sponsorship.coveredAccessIds,
          new: nextCoveredAccessIds,
        };
      }
      if (nextTotalAmount !== sponsorship.totalAmount) {
        changes.totalAmount = {
          old: sponsorship.totalAmount,
          new: nextTotalAmount,
        };
      }
    }

    if (Object.keys(updateData).length > 0) {
      await tx.sponsorship.update({
        where: { id },
        data: updateData,
      });
    }

    if (coverageChanged && sponsorship.usages.length > 0) {
      await recalculateUsageAmounts(id, tx);
    }

    if (Object.keys(changes).length > 0) {
      await auditLog(tx, {
        entityType: "Sponsorship",
        entityId: id,
        action: "UPDATE",
        changes,
        performedBy,
      });
    }
  });

  return getSponsorshipById(id) as Promise<SponsorshipWithUsages>;
}

// ============================================================================
// Cancel Sponsorship (Admin)
// ============================================================================

/**
 * Cancel a sponsorship and unlink from all registrations.
 */
export async function cancelSponsorship(
  id: string,
  performedBy?: string,
): Promise<SponsorshipWithUsages> {
  await prisma.$transaction(async (tx) => {
    const sponsorship = await tx.sponsorship.findUnique({
      where: { id },
      include: { usages: { select: { registrationId: true } } },
    });

    if (!sponsorship) {
      throw new AppError("Sponsorship not found", 404, ErrorCodes.NOT_FOUND);
    }

    await unlinkSponsorshipFromAllRegistrations(
      tx,
      id,
      sponsorship.usages,
      performedBy,
    );

    if (sponsorship.status !== "CANCELLED") {
      await tx.sponsorship.update({
        where: { id },
        data: { status: "CANCELLED" },
      });

      await auditLog(tx, {
        entityType: "Sponsorship",
        entityId: id,
        action: "CANCEL",
        changes: {
          status: { old: sponsorship.status, new: "CANCELLED" },
        },
        performedBy,
      });
    }
  });

  return getSponsorshipById(id) as Promise<SponsorshipWithUsages>;
}

// ============================================================================
// Delete Sponsorship (Admin)
// ============================================================================

/**
 * Delete a sponsorship permanently.
 * Unlinks from registrations first if needed.
 */
export async function deleteSponsorship(
  id: string,
  performedBy?: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const sponsorship = await tx.sponsorship.findUnique({
      where: { id },
      include: { usages: { select: { registrationId: true } } },
    });

    if (!sponsorship) {
      throw new AppError("Sponsorship not found", 404, ErrorCodes.NOT_FOUND);
    }

    await unlinkSponsorshipFromAllRegistrations(
      tx,
      id,
      sponsorship.usages,
      performedBy,
    );

    await auditLog(tx, {
      entityType: "Sponsorship",
      entityId: id,
      action: "DELETE",
      changes: {
        code: { old: sponsorship.code, new: null },
        status: { old: sponsorship.status, new: null },
        beneficiaryName: { old: sponsorship.beneficiaryName, new: null },
        beneficiaryEmail: { old: sponsorship.beneficiaryEmail, new: null },
        totalAmount: { old: sponsorship.totalAmount, new: null },
      },
      performedBy,
    });

    await tx.sponsorship.delete({ where: { id } });
  });
}

// ============================================================================
// Re-exports from extracted files
// ============================================================================

export type { CreateBatchResult } from "./sponsorship-batch.js";
export { createSponsorshipBatch } from "./sponsorship-batch.js";

export type { AvailableSponsorship } from "./sponsorship-queries.js";
export {
  listSponsorships,
  getSponsorshipById,
  getSponsorshipByCode,
  getAvailableSponsorships,
  getLinkedSponsorships,
  getSponsorshipClientId,
} from "./sponsorship-queries.js";

export type { LinkSponsorshipResult } from "./sponsorship-linking.js";
export {
  linkSponsorshipToRegistration,
  linkSponsorshipByCode,
  unlinkSponsorshipFromRegistration,
  unlinkSponsorshipFromAllRegistrations,
} from "./sponsorship-linking.js";
