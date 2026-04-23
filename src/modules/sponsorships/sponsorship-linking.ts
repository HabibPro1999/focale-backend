import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { logger } from "@shared/utils/logger.js";
import { auditLog } from "@shared/utils/audit.js";
import { calculateSettlement } from "@shared/utils/settlement.js";
import { assertModuleEnabledForClient } from "@clients";
import { assertEventWritable } from "@events";
import {
  calculateApplicableAmount,
  detectCoverageOverlap,
  calculateTotalSponsorshipAmount,
  determineSponsorshipStatus,
  type RegistrationForCalculation,
  type ExistingUsage,
} from "./sponsorships.utils.js";
import { getSponsorshipByCode } from "./sponsorship-queries.js";
import {
  incrementPaidCount,
  decrementPaidCount,
  handleCapacityReached,
  getAlreadyCoveredAccessIds,
} from "@access";
import { queueSponsorshipEmail, buildLinkedSponsorshipContext } from "@email";
import type { TxClient } from "@shared/types/prisma.js";
import { eventBus } from "@core/events/bus.js";
import type { AppEvent } from "@core/events/types.js";

// ============================================================================
// Types
// ============================================================================

export interface LinkSponsorshipResult {
  usage: {
    id: string;
    sponsorshipId: string;
    amountApplied: number;
  };
  registration: {
    totalAmount: number;
    sponsorshipAmount: number;
    amountDue: number;
  };
  warnings: string[];
}

type UnlinkUsageRef = {
  registrationId: string | null;
};

type RecalcDbClient = {
  sponsorship: Pick<typeof prisma.sponsorship, "findUnique">;
  sponsorshipUsage: Pick<typeof prisma.sponsorshipUsage, "update" | "findMany">;
  registration: Pick<typeof prisma.registration, "update">;
};

// ============================================================================
// Private Helpers
// ============================================================================

/**
 * Internal unlink function that works with transaction client.
 */
async function unlinkSponsorshipFromRegistrationInternal(
  tx: TxClient,
  sponsorshipId: string,
  registrationId: string,
  performedBy?: string,
): Promise<void> {
  const usage = await tx.sponsorshipUsage.findUnique({
    where: {
      sponsorshipId_registrationId: { sponsorshipId, registrationId },
    },
  });

  if (!usage) {
    throw new AppError(
      "Sponsorship is not linked to this registration",
      404,
      ErrorCodes.NOT_FOUND,
    );
  }

  const registrationBefore = await tx.registration.findUnique({
    where: { id: registrationId },
    select: {
      sponsorshipAmount: true,
      paidAmount: true,
      paymentMethod: true,
      paymentStatus: true,
      totalAmount: true,
      priceBreakdown: true,
    },
  });

  const sponsorshipBefore = await tx.sponsorship.findUnique({
    where: { id: sponsorshipId },
    select: {
      status: true,
      coveredAccessIds: true,
      event: {
        select: {
          status: true,
          client: { select: { enabledModules: true } },
        },
      },
    },
  });
  if (sponsorshipBefore) {
    assertEventWritable(sponsorshipBefore.event);
    assertModuleEnabledForClient(
      sponsorshipBefore.event.client,
      "sponsorships",
    );
  }

  // Delete the usage
  await tx.sponsorshipUsage.delete({
    where: { id: usage.id },
  });

  // Recalculate registration's sponsorship amount
  const remainingUsages = await tx.sponsorshipUsage.findMany({
    where: { registrationId },
    select: { amountApplied: true },
  });

  const newSponsorshipAmount = calculateTotalSponsorshipAmount(remainingUsages);

  // Determine new payment status after unlink
  const paidAmount = registrationBefore?.paidAmount ?? 0;
  const totalAmount = registrationBefore?.totalAmount ?? 0;
  const currentStatus = registrationBefore?.paymentStatus ?? "PENDING";

  // Decrement paidCount for access items that were covered by this sponsorship.
  // Applies when the registration was settled or partial — meaning paidCount was
  // incremented for these items when the sponsorship was originally linked.
  const coveredAccessIds = sponsorshipBefore?.coveredAccessIds ?? [];
  if (
    ["PAID", "SPONSORED", "WAIVED", "PARTIAL"].includes(currentStatus) &&
    coveredAccessIds.length > 0
  ) {
    const breakdown = registrationBefore?.priceBreakdown as {
      accessItems?: Array<{ accessId: string; quantity: number }>;
    } | null;
    const accessItems = breakdown?.accessItems ?? [];
    const itemsToDecrement = accessItems.filter((item) =>
      coveredAccessIds.includes(item.accessId),
    );
    for (const item of itemsToDecrement) {
      await decrementPaidCount(item.accessId, item.quantity, tx);
    }
  }

  let nextStatus: string | undefined;
  // Only auto-transition from SPONSORED (fully covered by sponsorship)
  if (currentStatus === "SPONSORED" && newSponsorshipAmount < totalAmount) {
    if (paidAmount > 0 || newSponsorshipAmount > 0) {
      nextStatus = "PARTIAL";
    } else {
      nextStatus = "PENDING";
    }
  }

  await tx.registration.update({
    where: { id: registrationId },
    data: {
      sponsorshipAmount: newSponsorshipAmount,
      ...(newSponsorshipAmount === 0 && { paymentMethod: null }),
      ...(nextStatus !== undefined && {
        paymentStatus: nextStatus as "PARTIAL" | "PENDING",
        // Only clear paidAt if no payment has been made
        ...(paidAmount === 0 && { paidAt: null }),
      }),
    },
  });

  const sponsorshipUsageCount = await tx.sponsorshipUsage.count({
    where: { sponsorshipId },
  });

  let nextSponsorshipStatus = sponsorshipBefore?.status ?? null;
  if (sponsorshipBefore) {
    const newStatus = determineSponsorshipStatus(
      { status: sponsorshipBefore.status },
      sponsorshipUsageCount,
    );

    if (newStatus !== sponsorshipBefore.status) {
      await tx.sponsorship.update({
        where: { id: sponsorshipId },
        data: { status: newStatus },
      });
      nextSponsorshipStatus = newStatus;
    }
  }

  const changes: Record<string, { old: unknown; new: unknown }> = {
    registrationId: { old: registrationId, new: null },
    amountApplied: { old: usage.amountApplied, new: 0 },
    sponsorshipAmount: {
      old: registrationBefore?.sponsorshipAmount ?? null,
      new: newSponsorshipAmount,
    },
  };

  if (
    (registrationBefore?.paymentMethod ?? null) !==
    (newSponsorshipAmount === 0
      ? null
      : (registrationBefore?.paymentMethod ?? null))
  ) {
    changes.paymentMethod = {
      old: registrationBefore?.paymentMethod ?? null,
      new:
        newSponsorshipAmount === 0
          ? null
          : (registrationBefore?.paymentMethod ?? null),
    };
  }

  if (
    sponsorshipBefore &&
    nextSponsorshipStatus &&
    nextSponsorshipStatus !== sponsorshipBefore.status
  ) {
    changes.status = {
      old: sponsorshipBefore.status,
      new: nextSponsorshipStatus,
    };
  }

  await auditLog(tx, {
    entityType: "Sponsorship",
    entityId: sponsorshipId,
    action: "UNLINK_FROM_REGISTRATION",
    changes,
    performedBy,
  });
}

/**
 * Recalculate usage amounts for all usages of a sponsorship.
 * Called after sponsorship coverage is updated.
 *
 * Pass `db` (a transaction client `tx`) to run all updates atomically.
 * A failure mid-loop will roll back all partial changes.
 */
async function recalculateUsageAmounts(
  sponsorshipId: string,
  db: RecalcDbClient,
): Promise<void> {
  const sponsorship = await db.sponsorship.findUnique({
    where: { id: sponsorshipId },
    include: {
      usages: {
        include: {
          registration: {
            select: {
              id: true,
              totalAmount: true,
              baseAmount: true,
              accessTypeIds: true,
              priceBreakdown: true,
            },
          },
        },
      },
    },
  });

  if (!sponsorship) return;

  for (const usage of sponsorship.usages) {
    // Skip if registration was deleted
    if (!usage.registration) continue;

    const priceBreakdown = usage.registration
      .priceBreakdown as RegistrationForCalculation["priceBreakdown"];

    const newAmount = calculateApplicableAmount(
      {
        coversBasePrice: sponsorship.coversBasePrice,
        coveredAccessIds: sponsorship.coveredAccessIds,
        totalAmount: sponsorship.totalAmount,
      },
      {
        totalAmount: usage.registration.totalAmount,
        baseAmount: usage.registration.baseAmount,
        accessTypeIds: usage.registration.accessTypeIds,
        priceBreakdown,
      },
    );

    await db.sponsorshipUsage.update({
      where: { id: usage.id },
      data: { amountApplied: newAmount },
    });

    // Recalculate registration total sponsorship
    const allUsages = await db.sponsorshipUsage.findMany({
      where: { registrationId: usage.registration.id },
      select: { amountApplied: true },
    });

    const totalSponsorshipAmount = calculateTotalSponsorshipAmount(allUsages);

    await db.registration.update({
      where: { id: usage.registration.id },
      data: { sponsorshipAmount: totalSponsorshipAmount },
    });
  }
}

// ============================================================================
// Exported: Unlink from all (used by lifecycle functions in main service)
// ============================================================================

export async function unlinkSponsorshipFromAllRegistrations(
  tx: TxClient,
  sponsorshipId: string,
  usages: UnlinkUsageRef[],
  performedBy?: string,
): Promise<void> {
  for (const usage of usages) {
    if (!usage.registrationId) {
      continue;
    }

    await unlinkSponsorshipFromRegistrationInternal(
      tx,
      sponsorshipId,
      usage.registrationId,
      performedBy,
    );
  }
}

// Re-export recalculateUsageAmounts for use in the main service's updateSponsorship
export { recalculateUsageAmounts };

// ============================================================================
// Link Sponsorship to Registration (Admin)
// ============================================================================

/**
 * Link a sponsorship to a registration by sponsorship ID.
 */
export async function linkSponsorshipToRegistration(
  sponsorshipId: string,
  registrationId: string,
  adminUserId: string,
): Promise<LinkSponsorshipResult> {
  const pending: AppEvent[] = [];
  // All reads and writes happen inside the transaction to prevent stale-data races
  const result = await prisma.$transaction(async (tx) => {
    const sponsorship = await tx.sponsorship.findUnique({
      where: { id: sponsorshipId },
      include: {
        event: {
          select: {
            clientId: true,
            status: true,
            client: { select: { enabledModules: true } },
          },
        },
        usages: {
          include: {
            sponsorship: {
              select: {
                code: true,
                coversBasePrice: true,
                coveredAccessIds: true,
              },
            },
          },
        },
      },
    });

    if (!sponsorship) {
      throw new AppError("Sponsorship not found", 404, ErrorCodes.NOT_FOUND);
    }
    assertEventWritable(sponsorship.event);
    assertModuleEnabledForClient(sponsorship.event.client, "sponsorships");

    if (sponsorship.status === "CANCELLED") {
      throw new AppError(
        "Cannot link a cancelled sponsorship",
        400,
        ErrorCodes.BAD_REQUEST,
        { code: "SPONSORSHIP_CANCELLED" },
      );
    }

    const registration = await tx.registration.findUnique({
      where: { id: registrationId },
      select: {
        id: true,
        eventId: true,
        totalAmount: true,
        paidAmount: true,
        baseAmount: true,
        accessTypeIds: true,
        priceBreakdown: true,
        paymentStatus: true,
        sponsorshipAmount: true,
        sponsorshipUsages: {
          include: {
            sponsorship: {
              select: {
                code: true,
                coversBasePrice: true,
                coveredAccessIds: true,
              },
            },
          },
        },
      },
    });

    if (!registration) {
      throw new AppError(
        "Registration not found",
        404,
        ErrorCodes.REGISTRATION_NOT_FOUND,
      );
    }

    // Verify same event
    if (sponsorship.eventId !== registration.eventId) {
      throw new AppError(
        "Sponsorship and registration must be for the same event",
        400,
        ErrorCodes.BAD_REQUEST,
      );
    }

    // Check if already linked
    const existingLink = await tx.sponsorshipUsage.findUnique({
      where: {
        sponsorshipId_registrationId: { sponsorshipId, registrationId },
      },
    });

    if (existingLink) {
      throw new AppError(
        "Sponsorship is already linked to this registration",
        409,
        ErrorCodes.CONFLICT,
        { code: "SPONSORSHIP_ALREADY_LINKED" },
      );
    }

    // Detect coverage overlap with existing sponsorships
    const existingUsages: ExistingUsage[] = registration.sponsorshipUsages.map(
      (u) => ({
        sponsorshipId: u.sponsorshipId,
        sponsorship: u.sponsorship,
      }),
    );

    const warnings = detectCoverageOverlap(existingUsages, {
      coversBasePrice: sponsorship.coversBasePrice,
      coveredAccessIds: sponsorship.coveredAccessIds,
      totalAmount: sponsorship.totalAmount,
    });

    // Calculate applicable amount
    const priceBreakdown =
      registration.priceBreakdown as RegistrationForCalculation["priceBreakdown"];
    const applicableAmount = calculateApplicableAmount(
      {
        coversBasePrice: sponsorship.coversBasePrice,
        coveredAccessIds: sponsorship.coveredAccessIds,
        totalAmount: sponsorship.totalAmount,
      },
      {
        totalAmount: registration.totalAmount,
        baseAmount: registration.baseAmount,
        accessTypeIds: registration.accessTypeIds,
        priceBreakdown,
      },
    );

    // Validate coverage applies - reject if $0 would be applied but sponsorship has value
    if (applicableAmount === 0 && sponsorship.totalAmount > 0) {
      throw new AppError(
        "Sponsorship coverage does not apply to this registration (no overlap between sponsored items and registration selections)",
        400,
        ErrorCodes.SPONSORSHIP_NOT_APPLICABLE,
      );
    }

    // Create sponsorship usage
    const usage = await tx.sponsorshipUsage.create({
      data: {
        sponsorshipId,
        registrationId,
        amountApplied: applicableAmount,
        appliedBy: adminUserId,
      },
    });

    // Update sponsorship status to USED (atomic with status check to prevent race)
    const statusUpdate = await tx.sponsorship.updateMany({
      where: {
        id: sponsorshipId,
        status: { not: "CANCELLED" }, // Only update if not cancelled
      },
      data: { status: "USED" },
    });

    if (statusUpdate.count === 0) {
      throw new AppError(
        "Sponsorship cannot be linked (may be cancelled or already processing)",
        409,
        ErrorCodes.SPONSORSHIP_STATUS_CONFLICT,
      );
    }

    // Calculate new total sponsorship amount for registration
    const allUsages = await tx.sponsorshipUsage.findMany({
      where: { registrationId },
      select: { amountApplied: true },
    });

    // Cap sponsorship amount at totalAmount to prevent over-sponsoring
    const rawSponsorshipAmount = calculateTotalSponsorshipAmount(allUsages);
    const newSponsorshipAmount = Math.min(
      rawSponsorshipAmount,
      registration.totalAmount,
    );

    // Update registration sponsorship amount and paymentMethod
    const isFullySponsored = newSponsorshipAmount >= registration.totalAmount;
    const wasAlreadySettled = ["PAID", "SPONSORED", "WAIVED"].includes(
      registration.paymentStatus,
    );
    await tx.registration.update({
      where: { id: registrationId },
      data: {
        sponsorshipAmount: newSponsorshipAmount,
        paymentMethod: "LAB_SPONSORSHIP",
        // Fully sponsored → SPONSORED; partially → PARTIAL
        ...(isFullySponsored
          ? { paymentStatus: "SPONSORED", paidAt: new Date() }
          : newSponsorshipAmount > 0
            ? { paymentStatus: "PARTIAL" }
            : {}),
      },
    });

    // Sync paid count for capacity tracking
    if (!wasAlreadySettled) {
      if (isFullySponsored) {
        // Fully sponsored: increment paidCount for items not already covered by prior sponsorships.
        // Exclude current sponsorship (its usage was just inserted) to get only previously-covered IDs.
        const breakdown = registration.priceBreakdown as Record<
          string,
          unknown
        >;
        const accessItems = (breakdown?.accessItems ?? []) as Array<{
          accessId: string;
          quantity: number;
        }>;
        const alreadyCovered =
          registration.paymentStatus === "PARTIAL"
            ? await getAlreadyCoveredAccessIds(
                registrationId,
                tx,
                sponsorshipId,
              )
            : new Set<string>();
        const itemsToIncrement = accessItems.filter(
          (item) => !alreadyCovered.has(item.accessId),
        );
        for (const item of itemsToIncrement) {
          await incrementPaidCount(item.accessId, item.quantity, tx);
        }
        if (itemsToIncrement.length > 0) {
          await handleCapacityReached(
            registration.eventId,
            itemsToIncrement.map((a) => a.accessId),
            tx,
          );
        }
      } else if (
        newSponsorshipAmount > 0 &&
        sponsorship.coveredAccessIds.length > 0
      ) {
        // Partial sponsorship: increment paidCount only for covered access items
        const breakdown = registration.priceBreakdown as Record<
          string,
          unknown
        >;
        const accessItems = (breakdown?.accessItems ?? []) as Array<{
          accessId: string;
          quantity: number;
        }>;
        const coveredItems = accessItems.filter((a) =>
          sponsorship.coveredAccessIds.includes(a.accessId),
        );
        for (const item of coveredItems) {
          await incrementPaidCount(item.accessId, item.quantity, tx);
        }
        if (coveredItems.length > 0) {
          await handleCapacityReached(
            registration.eventId,
            coveredItems.map((a) => a.accessId),
            tx,
          );
        }
      }
    }

    const changes: Record<string, { old: unknown; new: unknown }> = {
      registrationId: { old: null, new: registrationId },
      amountApplied: { old: 0, new: applicableAmount },
      sponsorshipAmount: {
        old: registration.sponsorshipAmount,
        new: newSponsorshipAmount,
      },
    };
    if (sponsorship.status !== "USED") {
      changes.status = { old: sponsorship.status, new: "USED" };
    }

    await auditLog(tx, {
      entityType: "Sponsorship",
      entityId: sponsorshipId,
      action: "LINK_TO_REGISTRATION",
      changes,
      performedBy: adminUserId,
    });

    const clientId = sponsorship.event?.clientId;
    if (clientId) {
      pending.push({
        type: "sponsorship.linked",
        clientId,
        eventId: sponsorship.eventId,
        payload: { id: sponsorshipId, registrationId },
        ts: Date.now(),
      });
      pending.push({
        type: "registration.updated",
        clientId,
        eventId: sponsorship.eventId,
        payload: { id: registrationId },
        ts: Date.now(),
      });
      if (!wasAlreadySettled) {
        pending.push({
          type: "eventAccess.countsChanged",
          clientId,
          eventId: sponsorship.eventId,
          payload: { id: sponsorship.eventId, accessIds: [] },
          ts: Date.now(),
        });
      }
    }

    return {
      sponsorshipEventId: sponsorship.eventId,
      sponsorshipCoveredAccessIds: sponsorship.coveredAccessIds,
      usage: {
        id: usage.id,
        sponsorshipId: usage.sponsorshipId,
        amountApplied: usage.amountApplied,
      },
      registration: {
        totalAmount: registration.totalAmount,
        sponsorshipAmount: newSponsorshipAmount,
        amountDue: calculateSettlement({
          totalAmount: registration.totalAmount,
          paidAmount: registration.paidAmount,
          sponsorshipAmount: newSponsorshipAmount,
        }).amountDue,
      },
      warnings,
    };
  });

  // Queue SPONSORSHIP_APPLIED email to the doctor
  try {
    // Fetch data needed for email context
    const [
      sponsorshipWithBatch,
      registrationDetails,
      event,
      pricing,
      accessItems,
    ] = await Promise.all([
      prisma.sponsorship.findUnique({
        where: { id: sponsorshipId },
        include: {
          batch: { select: { labName: true, contactName: true, email: true } },
        },
      }),
      prisma.registration.findUnique({
        where: { id: registrationId },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          totalAmount: true,
          baseAmount: true,
          sponsorshipAmount: true,
          linkBaseUrl: true,
          editToken: true,
        },
      }),
      prisma.event.findUnique({
        where: { id: result.sponsorshipEventId },
        select: {
          name: true,
          slug: true,
          startDate: true,
          location: true,
          client: { select: { name: true } },
        },
      }),
      prisma.eventPricing.findUnique({
        where: { eventId: result.sponsorshipEventId },
        select: { basePrice: true, currency: true },
      }),
      result.sponsorshipCoveredAccessIds.length > 0
        ? prisma.eventAccess.findMany({
            where: { id: { in: result.sponsorshipCoveredAccessIds } },
            select: { id: true, name: true, price: true },
          })
        : Promise.resolve([]),
    ]);

    if (sponsorshipWithBatch && registrationDetails && event) {
      const currency = pricing?.currency ?? "TND";
      const context = buildLinkedSponsorshipContext({
        amountApplied: result.usage.amountApplied,
        sponsorship: {
          code: sponsorshipWithBatch.code,
          beneficiaryName: sponsorshipWithBatch.beneficiaryName,
          coversBasePrice: sponsorshipWithBatch.coversBasePrice,
          coveredAccessIds: sponsorshipWithBatch.coveredAccessIds,
          totalAmount: sponsorshipWithBatch.totalAmount,
          batch: {
            labName: sponsorshipWithBatch.batch.labName,
            contactName: sponsorshipWithBatch.batch.contactName,
            email: sponsorshipWithBatch.batch.email,
          },
        },
        registration: registrationDetails,
        event,
        pricing: pricing ? { basePrice: pricing.basePrice } : null,
        accessItems,
        currency,
      });

      const appliedEmailQueued = await queueSponsorshipEmail(
        "SPONSORSHIP_APPLIED",
        result.sponsorshipEventId,
        {
          recipientEmail: registrationDetails.email,
          recipientName:
            registrationDetails.firstName ||
            sponsorshipWithBatch.beneficiaryName,
          context,
          registrationId: registrationDetails.id,
        },
      );
      if (!appliedEmailQueued) {
        logger.warn(
          {
            trigger: "SPONSORSHIP_APPLIED",
            eventId: result.sponsorshipEventId,
            registrationId,
          },
          "No email template configured - doctor will not receive sponsorship notification",
        );
      }
    }
  } catch (emailError) {
    // Log error but don't fail the link operation
    logger.error(
      { error: emailError, sponsorshipId, registrationId },
      "Failed to queue SPONSORSHIP_APPLIED email",
    );
  }

  for (const ev of pending) eventBus.emit(ev);

  return {
    usage: result.usage,
    registration: result.registration,
    warnings: result.warnings,
  };
}

// ============================================================================
// Link Sponsorship by Code (Admin)
// ============================================================================

/**
 * Link a sponsorship to a registration by code.
 */
export async function linkSponsorshipByCode(
  registrationId: string,
  code: string,
  adminUserId: string,
): Promise<LinkSponsorshipResult> {
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    select: { eventId: true },
  });

  if (!registration) {
    throw new AppError(
      "Registration not found",
      404,
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );
  }

  const sponsorship = await getSponsorshipByCode(registration.eventId, code);

  if (!sponsorship) {
    throw new AppError(
      `Code ${code} not found for this event`,
      404,
      ErrorCodes.NOT_FOUND,
      { code: "SPONSORSHIP_NOT_FOUND" },
    );
  }

  return linkSponsorshipToRegistration(
    sponsorship.id,
    registrationId,
    adminUserId,
  );
}

// ============================================================================
// Unlink Sponsorship from Registration (Admin)
// ============================================================================

/**
 * Unlink a sponsorship from a registration.
 */
export async function unlinkSponsorshipFromRegistration(
  sponsorshipId: string,
  registrationId: string,
  performedBy?: string,
): Promise<void> {
  let sponsorshipEventId: string | null = null;
  let clientId: string | null = null;
  await prisma.$transaction(async (tx) => {
    const sponsorship = await tx.sponsorship.findUnique({
      where: { id: sponsorshipId },
      select: {
        eventId: true,
        event: { select: { clientId: true } },
      },
    });
    sponsorshipEventId = sponsorship?.eventId ?? null;
    clientId = sponsorship?.event?.clientId ?? null;

    await unlinkSponsorshipFromRegistrationInternal(
      tx,
      sponsorshipId,
      registrationId,
      performedBy,
    );
  });

  if (clientId && sponsorshipEventId) {
    eventBus.emit({
      type: "sponsorship.unlinked",
      clientId,
      eventId: sponsorshipEventId,
      payload: { id: sponsorshipId, registrationId },
      ts: Date.now(),
    });
    eventBus.emit({
      type: "registration.updated",
      clientId,
      eventId: sponsorshipEventId,
      payload: { id: registrationId },
      ts: Date.now(),
    });
    eventBus.emit({
      type: "eventAccess.countsChanged",
      clientId,
      eventId: sponsorshipEventId,
      payload: { id: sponsorshipEventId, accessIds: [] },
      ts: Date.now(),
    });
  }
}
