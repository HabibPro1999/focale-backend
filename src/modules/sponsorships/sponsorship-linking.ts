import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { auditLog } from "@shared/utils/audit.js";
import { calculateSettlement } from "@shared/utils/settlement.js";
import {
  CLIENT_MODULE_GATE_SELECT,
  CLIENT_MODULE_GATE_WITH_NAME_SELECT,
  assertModuleEnabledForClient,
} from "@clients";
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
import { getAlreadyCoveredAccessIds, syncPaidCountDelta } from "@access";
import { buildLinkedSponsorshipContext } from "@email";
import {
  enqueueRealtimeOutboxEvent,
  enqueueSponsorshipEmailOutboxEvent,
} from "@core/outbox";
import type { TxClient } from "@shared/types/prisma.js";
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
      eventId: true,
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
          client: { select: CLIENT_MODULE_GATE_SELECT },
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

  const oldCoveredAccessIds = registrationBefore
    ? await getAlreadyCoveredAccessIds(registrationId, tx)
    : new Set<string>();

  // Delete the usage
  await tx.sponsorshipUsage.delete({
    where: { id: usage.id },
  });

  // Recalculate registration's sponsorship amount
  const remainingUsages = await tx.sponsorshipUsage.findMany({
    where: { registrationId },
    select: { amountApplied: true },
  });

  const rawNewSponsorshipAmount =
    calculateTotalSponsorshipAmount(remainingUsages);
  const newSponsorshipAmount = registrationBefore
    ? Math.min(rawNewSponsorshipAmount, registrationBefore.totalAmount)
    : rawNewSponsorshipAmount;

  // Determine new payment status after unlink
  const paidAmount = registrationBefore?.paidAmount ?? 0;
  const totalAmount = registrationBefore?.totalAmount ?? 0;
  const currentStatus = registrationBefore?.paymentStatus ?? "PENDING";

  let nextStatus: string | undefined;
  if (currentStatus === "SPONSORED" && newSponsorshipAmount < totalAmount) {
    if (paidAmount > 0 || newSponsorshipAmount > 0) {
      nextStatus = "PARTIAL";
    } else {
      nextStatus = "PENDING";
    }
  } else if (currentStatus === "PARTIAL" && newSponsorshipAmount === 0) {
    nextStatus = paidAmount > 0 ? "PARTIAL" : "PENDING";
  }
  if (registrationBefore) {
    const newCoveredAccessIds = await getAlreadyCoveredAccessIds(
      registrationId,
      tx,
    );
    const priceBreakdown = registrationBefore.priceBreakdown as {
      accessItems?: Array<{ accessId: string; quantity: number }>;
    } | null;
    await syncPaidCountDelta(
      registrationBefore.eventId,
      {
        status: currentStatus,
        priceBreakdown,
        coveredAccessIds: oldCoveredAccessIds,
      },
      {
        status: nextStatus ?? currentStatus,
        priceBreakdown,
        coveredAccessIds: newCoveredAccessIds,
      },
      tx,
    );
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
              eventId: true,
              totalAmount: true,
              paidAmount: true,
              baseAmount: true,
              paymentStatus: true,
              paidAt: true,
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

    const totalSponsorshipAmount = Math.min(
      calculateTotalSponsorshipAmount(allUsages),
      usage.registration.totalAmount,
    );
    const oldPaymentStatus = usage.registration.paymentStatus;
    const settlement = calculateSettlement({
      totalAmount: usage.registration.totalAmount,
      paidAmount: usage.registration.paidAmount,
      sponsorshipAmount: totalSponsorshipAmount,
    });
    const nextPaymentStatus =
      oldPaymentStatus === "PAID" ||
      oldPaymentStatus === "WAIVED" ||
      oldPaymentStatus === "REFUNDED"
        ? oldPaymentStatus
        : totalSponsorshipAmount >= usage.registration.totalAmount &&
            usage.registration.totalAmount > 0
          ? "SPONSORED"
          : settlement.isPartiallyPaid
            ? "PARTIAL"
            : "PENDING";
    const nextPaidAt =
      nextPaymentStatus === "SPONSORED"
        ? (usage.registration.paidAt ?? new Date())
        : nextPaymentStatus === "PARTIAL" || nextPaymentStatus === "PENDING"
          ? null
          : usage.registration.paidAt;
    const updatedPriceBreakdown = {
      ...priceBreakdown,
      sponsorshipTotal: totalSponsorshipAmount,
      total: Math.max(
        0,
        ((priceBreakdown as { subtotal?: number }).subtotal ??
          usage.registration.totalAmount) -
          totalSponsorshipAmount,
      ),
    };

    await db.registration.update({
      where: { id: usage.registration.id },
      data: {
        sponsorshipAmount: totalSponsorshipAmount,
        paymentStatus: nextPaymentStatus,
        paidAt: nextPaidAt,
        priceBreakdown: updatedPriceBreakdown,
      },
    });

    if (oldPaymentStatus !== nextPaymentStatus) {
      const oldCoveredAccessIds =
        oldPaymentStatus === "PARTIAL"
          ? await getAlreadyCoveredAccessIds(
              usage.registration.id,
              db,
              sponsorshipId,
            )
          : new Set<string>();
      const newCoveredAccessIds =
        nextPaymentStatus === "PARTIAL"
          ? await getAlreadyCoveredAccessIds(usage.registration.id, db)
          : new Set<string>();
      await syncPaidCountDelta(
        usage.registration.eventId,
        {
          status: oldPaymentStatus,
          priceBreakdown,
          coveredAccessIds: oldCoveredAccessIds,
        },
        {
          status: nextPaymentStatus,
          priceBreakdown: updatedPriceBreakdown,
          coveredAccessIds: newCoveredAccessIds,
        },
        db as unknown as Parameters<typeof syncPaidCountDelta>[3],
      );
    }
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
            name: true,
            slug: true,
            startDate: true,
            location: true,
            status: true,
            client: { select: CLIENT_MODULE_GATE_WITH_NAME_SELECT },
          },
        },
        batch: { select: { labName: true, contactName: true, email: true } },
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
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        eventId: true,
        totalAmount: true,
        paidAmount: true,
        baseAmount: true,
        linkBaseUrl: true,
        editToken: true,
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
    const oldCoveredAccessIds = await getAlreadyCoveredAccessIds(
      registrationId,
      tx,
    );

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
    const nextPaymentStatus = ["PAID", "WAIVED"].includes(
      registration.paymentStatus,
    )
      ? registration.paymentStatus
      : isFullySponsored
        ? "SPONSORED"
        : newSponsorshipAmount > 0
          ? "PARTIAL"
          : registration.paymentStatus;
    await tx.registration.update({
      where: { id: registrationId },
      data: {
        sponsorshipAmount: newSponsorshipAmount,
        paymentMethod: "LAB_SPONSORSHIP",
        // Fully sponsored → SPONSORED; partially → PARTIAL
        paymentStatus: nextPaymentStatus as
          | "PAID"
          | "WAIVED"
          | "SPONSORED"
          | "PARTIAL",
        ...(nextPaymentStatus === "SPONSORED" ? { paidAt: new Date() } : {}),
      },
    });

    const newCoveredAccessIds = await getAlreadyCoveredAccessIds(
      registrationId,
      tx,
    );
    await syncPaidCountDelta(
      registration.eventId,
      {
        status: registration.paymentStatus,
        priceBreakdown: registration.priceBreakdown,
        coveredAccessIds: oldCoveredAccessIds,
      },
      {
        status: nextPaymentStatus,
        priceBreakdown: registration.priceBreakdown,
        coveredAccessIds: newCoveredAccessIds,
      },
      tx,
    );

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
      pending.push({
        type: "eventAccess.countsChanged",
        clientId,
        eventId: sponsorship.eventId,
        payload: { id: sponsorship.eventId, accessIds: [] },
        ts: Date.now(),
      });
    }
    await Promise.all(pending.map((ev) => enqueueRealtimeOutboxEvent(tx, ev)));

    const [pricing, accessItems] = await Promise.all([
      tx.eventPricing.findUnique({
        where: { eventId: sponsorship.eventId },
        select: { basePrice: true, currency: true },
      }),
      sponsorship.coveredAccessIds.length > 0
        ? tx.eventAccess.findMany({
            where: { id: { in: sponsorship.coveredAccessIds } },
            select: { id: true, name: true, price: true },
          })
        : Promise.resolve([]),
    ]);

    const currency = pricing?.currency ?? "TND";
    const context = buildLinkedSponsorshipContext({
      amountApplied: usage.amountApplied,
      sponsorship: {
        code: sponsorship.code,
        beneficiaryName: sponsorship.beneficiaryName,
        coversBasePrice: sponsorship.coversBasePrice,
        coveredAccessIds: sponsorship.coveredAccessIds,
        totalAmount: sponsorship.totalAmount,
        batch: {
          labName: sponsorship.batch.labName,
          contactName: sponsorship.batch.contactName,
          email: sponsorship.batch.email,
        },
      },
      registration: {
        id: registration.id,
        email: registration.email,
        firstName: registration.firstName,
        lastName: registration.lastName,
        phone: registration.phone,
        totalAmount: registration.totalAmount,
        baseAmount: registration.baseAmount,
        sponsorshipAmount: newSponsorshipAmount,
        linkBaseUrl: registration.linkBaseUrl,
        editToken: registration.editToken,
      },
      event: {
        name: sponsorship.event.name,
        slug: sponsorship.event.slug,
        startDate: sponsorship.event.startDate,
        location: sponsorship.event.location,
        client: { name: sponsorship.event.client.name },
      },
      pricing: pricing ? { basePrice: pricing.basePrice } : null,
      accessItems,
      currency,
    });

    await enqueueSponsorshipEmailOutboxEvent(
      tx,
      {
        trigger: "SPONSORSHIP_APPLIED",
        eventId: sponsorship.eventId,
        input: {
          recipientEmail: registration.email,
          recipientName: registration.firstName || sponsorship.beneficiaryName,
          context,
          registrationId: registration.id,
        },
      },
      `email:sponsorship:SPONSORSHIP_APPLIED:${registration.id}:${sponsorshipId}`,
    );

    return {
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
  await prisma.$transaction(async (tx) => {
    const sponsorship = await tx.sponsorship.findUnique({
      where: { id: sponsorshipId },
      select: {
        eventId: true,
        event: { select: { clientId: true } },
      },
    });

    await unlinkSponsorshipFromRegistrationInternal(
      tx,
      sponsorshipId,
      registrationId,
      performedBy,
    );

    const sponsorshipEventId = sponsorship?.eventId ?? null;
    const clientId = sponsorship?.event?.clientId ?? null;
    if (clientId && sponsorshipEventId) {
      await Promise.all([
        enqueueRealtimeOutboxEvent(tx, {
          type: "sponsorship.unlinked",
          clientId,
          eventId: sponsorshipEventId,
          payload: { id: sponsorshipId, registrationId },
          ts: Date.now(),
        }),
        enqueueRealtimeOutboxEvent(tx, {
          type: "registration.updated",
          clientId,
          eventId: sponsorshipEventId,
          payload: { id: registrationId },
          ts: Date.now(),
        }),
        enqueueRealtimeOutboxEvent(tx, {
          type: "eventAccess.countsChanged",
          clientId,
          eventId: sponsorshipEventId,
          payload: { id: sponsorshipEventId, accessIds: [] },
          ts: Date.now(),
        }),
      ]);
    }
  });
}
