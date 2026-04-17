import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { auditLog } from "@shared/utils/audit.js";
import { eventBus } from "@core/events/bus.js";

// ============================================================================
// Check In
// ============================================================================

export async function checkIn(
  eventId: string,
  registrationId: string,
  accessId: string | undefined,
  userId: string,
) {
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    select: {
      id: true,
      eventId: true,
      firstName: true,
      lastName: true,
      email: true,
      referenceNumber: true,
      paymentStatus: true,
      checkedInAt: true,
      checkedInBy: true,
      accessTypeIds: true,
      event: { select: { clientId: true } },
    },
  });

  if (!registration) {
    throw new AppError(
      "Registration not found",
      404,
      ErrorCodes.CHECKIN_REGISTRATION_NOT_FOUND,
    );
  }

  if (registration.eventId !== eventId) {
    throw new AppError(
      "Registration does not belong to this event",
      400,
      ErrorCodes.CHECKIN_EVENT_MISMATCH,
    );
  }

  // Access-level check-in
  if (accessId) {
    if (!registration.accessTypeIds.includes(accessId)) {
      throw new AppError(
        "Registration does not include this access item",
        400,
        ErrorCodes.CHECKIN_ACCESS_NOT_ON_REGISTRATION,
      );
    }

    const existing = await prisma.accessCheckIn.findUnique({
      where: {
        registrationId_accessId: { registrationId, accessId },
      },
    });

    if (existing) {
      return {
        success: true,
        alreadyCheckedIn: true,
        checkedInAt: existing.checkedInAt,
        registration: {
          id: registration.id,
          firstName: registration.firstName,
          lastName: registration.lastName,
          email: registration.email,
          referenceNumber: registration.referenceNumber,
          paymentStatus: registration.paymentStatus,
        },
      };
    }

    const checkInRecord = await prisma.accessCheckIn.create({
      data: {
        registrationId,
        accessId,
        checkedInBy: userId,
      },
    });

    await auditLog(prisma, {
      entityType: "AccessCheckIn",
      entityId: checkInRecord.id,
      action: "CHECK_IN",
      changes: { accessId: { old: null, new: accessId } },
      performedBy: userId,
    });

    if (registration.event?.clientId) {
      eventBus.emit({
        type: "registration.checkedIn",
        clientId: registration.event.clientId,
        eventId: registration.eventId,
        payload: { id: registration.id, accessId },
        ts: Date.now(),
      });
    }

    return {
      success: true,
      alreadyCheckedIn: false,
      checkedInAt: checkInRecord.checkedInAt,
      registration: {
        id: registration.id,
        firstName: registration.firstName,
        lastName: registration.lastName,
        email: registration.email,
        referenceNumber: registration.referenceNumber,
        paymentStatus: registration.paymentStatus,
      },
    };
  }

  // Event-level check-in
  if (registration.checkedInAt) {
    return {
      success: true,
      alreadyCheckedIn: true,
      checkedInAt: registration.checkedInAt,
      registration: {
        id: registration.id,
        firstName: registration.firstName,
        lastName: registration.lastName,
        email: registration.email,
        referenceNumber: registration.referenceNumber,
        paymentStatus: registration.paymentStatus,
      },
    };
  }

  const now = new Date();
  await prisma.registration.update({
    where: { id: registrationId },
    data: { checkedInAt: now, checkedInBy: userId },
  });

  await auditLog(prisma, {
    entityType: "Registration",
    entityId: registrationId,
    action: "CHECK_IN",
    changes: { checkedInAt: { old: null, new: now.toISOString() } },
    performedBy: userId,
  });

  if (registration.event?.clientId) {
    eventBus.emit({
      type: "registration.checkedIn",
      clientId: registration.event.clientId,
      eventId: registration.eventId,
      payload: { id: registration.id },
      ts: Date.now(),
    });
  }

  return {
    success: true,
    alreadyCheckedIn: false,
    checkedInAt: now,
    registration: {
      id: registration.id,
      firstName: registration.firstName,
      lastName: registration.lastName,
      email: registration.email,
      referenceNumber: registration.referenceNumber,
      paymentStatus: registration.paymentStatus,
    },
  };
}

// ============================================================================
// Eligible Registration IDs (for scanner preload)
// ============================================================================

const CHECKIN_ELIGIBLE_STATUSES = ["PAID", "SPONSORED", "WAIVED"];

export async function getCheckInRegistrations(
  eventId: string,
  accessId?: string,
): Promise<string[]> {
  const where: Record<string, unknown> = {
    eventId,
    paymentStatus: { in: CHECKIN_ELIGIBLE_STATUSES },
  };

  if (accessId) {
    where.accessTypeIds = { has: accessId };
  }

  const registrations = await prisma.registration.findMany({
    where,
    select: { id: true },
  });

  return registrations.map((r) => r.id);
}

// ============================================================================
// Batch Sync
// ============================================================================

export async function batchSync(
  eventId: string,
  checkIns: Array<{
    registrationId: string;
    accessId?: string;
    scannedAt: string;
  }>,
  userId: string,
) {
  let synced = 0;
  let alreadyCheckedIn = 0;
  const errors: Array<{ registrationId: string; error: string }> = [];

  for (const item of checkIns) {
    try {
      const result = await checkIn(
        eventId,
        item.registrationId,
        item.accessId,
        userId,
      );
      if (result.alreadyCheckedIn) {
        alreadyCheckedIn++;
      } else {
        synced++;
      }
    } catch (e) {
      errors.push({
        registrationId: item.registrationId,
        error: e instanceof AppError ? e.message : "Unknown error",
      });
    }
  }

  return { synced, alreadyCheckedIn, errors };
}

// ============================================================================
// Stats
// ============================================================================

export async function getCheckInStats(eventId: string) {
  const [total, checkedIn, accessCounts, accessItems] = await Promise.all([
    prisma.registration.count({ where: { eventId } }),
    prisma.registration.count({
      where: { eventId, checkedInAt: { not: null } },
    }),
    prisma.accessCheckIn.groupBy({
      by: ["accessId"],
      where: {
        registration: { eventId },
      },
      _count: { id: true },
    }),
    prisma.eventAccess.findMany({
      where: { eventId, active: true },
      select: {
        id: true,
        name: true,
        type: true,
        registeredCount: true,
      },
    }),
  ]);

  const accessCountMap = new Map(
    accessCounts.map((c) => [c.accessId, c._count.id]),
  );

  const byAccess = accessItems.map((item) => ({
    accessId: item.id,
    name: item.name,
    type: item.type,
    total: item.registeredCount,
    checkedIn: accessCountMap.get(item.id) ?? 0,
  }));

  return { total, checkedIn, byAccess };
}
