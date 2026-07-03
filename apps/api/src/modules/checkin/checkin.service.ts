import { Injectable } from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";
import {
  CHECKIN_ELIGIBLE_STATUSES,
  checkInRegistration,
  createAccessCheckIn,
  getAccessCheckIn,
  getAccessCheckInCounts,
  getActiveAccessItems,
  getActiveEventAccessId,
  getEligibleRegistrationAccessTypeIds,
  getEligibleRegistrationIds,
  countCheckedInRegistrations,
  countEventRegistrations,
  getRegistrationForCheckIn,
  pgUniqueViolation,
  type CheckInRegistration,
} from "@app/db";
import { AppException } from "../../core/app-exception";

const ELIGIBLE = new Set<string>(CHECKIN_ELIGIBLE_STATUSES);

/**
 * A concurrent access-level check-in that won the composite-unique-key race
 * surfaces as pg 23505. access_check_ins has exactly one unique index
 * (registration_id_access_id) so any 23505 from the insert is that race.
 */
function isCheckInUniqueViolation(error: unknown): boolean {
  return pgUniqueViolation(error) !== null;
}

function registrationSummary(reg: CheckInRegistration) {
  return {
    id: reg.id,
    firstName: reg.firstName,
    lastName: reg.lastName,
    email: reg.email,
    referenceNumber: reg.referenceNumber,
    paymentStatus: reg.paymentStatus,
  };
}

@Injectable()
export class CheckinService {
  /**
   * Check-in a registration (event- or access-level). Check ORDER is
   * load-bearing: registration-exists → event-mismatch → payment-status →
   * access-on-registration → existing-check-in lookup → write. "Already checked
   * in" is a 200 success with alreadyCheckedIn:true (never an error).
   */
  async checkIn(
    eventId: string,
    registrationId: string,
    accessId: string | undefined,
    userId: string,
    checkedInAt = new Date(),
  ) {
    const registration = await getRegistrationForCheckIn(registrationId);

    if (!registration) {
      throw new AppException(
        ErrorCodes.CHECKIN_REGISTRATION_NOT_FOUND,
        "Registration not found",
        404,
      );
    }

    if (registration.eventId !== eventId) {
      throw new AppException(
        ErrorCodes.CHECKIN_EVENT_MISMATCH,
        "Registration does not belong to this event",
        400,
      );
    }

    if (!ELIGIBLE.has(registration.paymentStatus)) {
      throw new AppException(
        ErrorCodes.CHECKIN_PAYMENT_REQUIRED,
        "Registration payment is not settled",
        400,
      );
    }

    // Access-level check-in
    if (accessId) {
      if (!registration.accessTypeIds.includes(accessId)) {
        throw new AppException(
          ErrorCodes.CHECKIN_ACCESS_NOT_ON_REGISTRATION,
          "Registration does not include this access item",
          400,
        );
      }

      const existing = await getAccessCheckIn(registrationId, accessId);
      if (existing) {
        return {
          success: true,
          alreadyCheckedIn: true,
          checkedInAt: existing.checkedInAt,
          registration: registrationSummary(registration),
        };
      }

      let checkInRecord;
      try {
        checkInRecord = await createAccessCheckIn({
          registrationId,
          eventId: registration.eventId,
          accessId,
          clientId: registration.clientId,
          checkedInBy: userId,
          checkedInAt,
        });
      } catch (error) {
        if (!isCheckInUniqueViolation(error)) throw error;
        const existingAfterRace = await getAccessCheckIn(registrationId, accessId);
        if (!existingAfterRace) throw error;
        return {
          success: true,
          alreadyCheckedIn: true,
          checkedInAt: existingAfterRace.checkedInAt,
          registration: registrationSummary(registration),
        };
      }

      return {
        success: true,
        alreadyCheckedIn: false,
        checkedInAt: checkInRecord.checkedInAt,
        registration: registrationSummary(registration),
      };
    }

    // Event-level check-in
    if (registration.checkedInAt) {
      return {
        success: true,
        alreadyCheckedIn: true,
        checkedInAt: registration.checkedInAt,
        registration: registrationSummary(registration),
      };
    }

    await checkInRegistration({
      registrationId,
      eventId: registration.eventId,
      clientId: registration.clientId,
      checkedInBy: userId,
      checkedInAt,
    });

    return {
      success: true,
      alreadyCheckedIn: false,
      checkedInAt,
      registration: registrationSummary(registration),
    };
  }

  /** Eligible registration ids for scanner preload (unbounded). */
  async getCheckInRegistrations(
    eventId: string,
    accessId?: string,
  ): Promise<string[]> {
    if (accessId) {
      const access = await getActiveEventAccessId(accessId, eventId);
      if (!access) {
        throw new AppException(ErrorCodes.NOT_FOUND, "Access item not found", 404);
      }
    }
    return getEligibleRegistrationIds(eventId, accessId);
  }

  /**
   * Batch sync offline check-ins. Sequential (one bad item never fails the
   * others); non-AppError → "Unknown error". Never throws; endpoint always 200.
   */
  async batchSync(
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
        const result = await this.checkIn(
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
          error: e instanceof AppException ? e.message : "Unknown error",
        });
      }
    }

    return { synced, alreadyCheckedIn, errors };
  }

  /** Check-in statistics: totals + per-active-access breakdown. */
  async getCheckInStats(eventId: string) {
    const [total, checkedIn, accessCounts, accessItems, eligibleRegistrations] =
      await Promise.all([
        countEventRegistrations(eventId),
        countCheckedInRegistrations(eventId),
        getAccessCheckInCounts(eventId),
        getActiveAccessItems(eventId),
        getEligibleRegistrationAccessTypeIds(eventId),
      ]);

    const accessCountMap = new Map(
      accessCounts.map((c) => [c.accessId, c.count]),
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
}
