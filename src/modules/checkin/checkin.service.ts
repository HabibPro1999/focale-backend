import { prisma } from "@/database/client.js";
import { PaymentStatus, Prisma } from "@/generated/prisma/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { auditLog } from "@shared/utils/audit.js";
import { enqueueRealtimeOutboxEvent } from "@core/outbox";

const CHECKIN_ELIGIBLE_STATUSES: PaymentStatus[] = [
  "PAID",
  "SPONSORED",
  "WAIVED",
];

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

// ============================================================================
// Check In
// ============================================================================

export async function checkIn(
  eventId: string,
  registrationId: string,
  accessId: string | undefined,
  userId: string,
  checkedInAt = new Date(),
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

  if (!CHECKIN_ELIGIBLE_STATUSES.includes(registration.paymentStatus)) {
    throw new AppError(
      "Registration payment is not settled",
      400,
      ErrorCodes.CHECKIN_PAYMENT_REQUIRED,
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

    let checkInRecord;
    try {
      checkInRecord = await prisma.$transaction(async (tx) => {
        const created = await tx.accessCheckIn.create({
          data: {
            registrationId,
            accessId,
            checkedInBy: userId,
            checkedInAt,
          },
        });

        await auditLog(tx, {
          entityType: "AccessCheckIn",
          entityId: created.id,
          action: "CHECK_IN",
          changes: {
            accessId: { old: null, new: accessId },
            checkedInAt: { old: null, new: checkedInAt.toISOString() },
          },
          performedBy: userId,
        });

        if (registration.event?.clientId) {
          await enqueueRealtimeOutboxEvent(tx, {
            type: "registration.checkedIn",
            clientId: registration.event.clientId,
            eventId: registration.eventId,
            payload: { id: registration.id, accessId },
            ts: Date.now(),
          });
        }

        return created;
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existingAfterRace = await prisma.accessCheckIn.findUnique({
        where: {
          registrationId_accessId: { registrationId, accessId },
        },
      });
      if (!existingAfterRace) throw error;
      return {
        success: true,
        alreadyCheckedIn: true,
        checkedInAt: existingAfterRace.checkedInAt,
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

  await prisma.$transaction(async (tx) => {
    await tx.registration.update({
      where: { id: registrationId },
      data: { checkedInAt, checkedInBy: userId },
    });

    await auditLog(tx, {
      entityType: "Registration",
      entityId: registrationId,
      action: "CHECK_IN",
      changes: { checkedInAt: { old: null, new: checkedInAt.toISOString() } },
      performedBy: userId,
    });

    if (registration.event?.clientId) {
      await enqueueRealtimeOutboxEvent(tx, {
        type: "registration.checkedIn",
        clientId: registration.event.clientId,
        eventId: registration.eventId,
        payload: { id: registration.id },
        ts: Date.now(),
      });
    }
  });

  return {
    success: true,
    alreadyCheckedIn: false,
    checkedInAt,
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

export async function getCheckInRegistrations(
  eventId: string,
  accessId?: string,
): Promise<string[]> {
  const where: Record<string, unknown> = {
    eventId,
    paymentStatus: { in: CHECKIN_ELIGIBLE_STATUSES },
  };

  if (accessId) {
    const access = await prisma.eventAccess.findFirst({
      where: { id: accessId, eventId, active: true },
      select: { id: true },
    });
    if (!access) {
      throw new AppError("Access item not found", 404, ErrorCodes.NOT_FOUND);
    }
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
        new Date(item.scannedAt),
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
  const [total, checkedIn, accessCounts, accessItems, eligibleRegistrations] =
    await Promise.all([
      prisma.registration.count({ where: { eventId } }),
      prisma.registration.count({
        where: { eventId, checkedInAt: { not: null } },
      }),
      prisma.accessCheckIn.groupBy({
        by: ["accessId"],
        where: {
          registration: { eventId },
          access: { eventId, active: true },
        },
        _count: { id: true },
      }),
      prisma.eventAccess.findMany({
        where: { eventId, active: true },
        select: {
          id: true,
          name: true,
          type: true,
        },
      }),
      prisma.registration.findMany({
        where: {
          eventId,
          paymentStatus: { in: CHECKIN_ELIGIBLE_STATUSES },
        },
        select: { accessTypeIds: true },
      }),
    ]);

  const accessCountMap = new Map(
    accessCounts.map((c) => [c.accessId, c._count.id]),
  );

  const activeAccessIds = new Set(accessItems.map((item) => item.id));
  const totalByAccess = new Map<string, number>();
  for (const registration of eligibleRegistrations) {
    for (const id of registration.accessTypeIds) {
      if (!activeAccessIds.has(id)) continue;
      totalByAccess.set(id, (totalByAccess.get(id) ?? 0) + 1);
    }
  }

  const byAccess = accessItems.map((item) => ({
    accessId: item.id,
    name: item.name,
    type: item.type,
    total: totalByAccess.get(item.id) ?? 0,
    checkedIn: accessCountMap.get(item.id) ?? 0,
  }));

  return { total, checkedIn, byAccess };
}
