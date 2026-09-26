import { Injectable } from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";
import {
  batchCheckIn,
  CHECK_IN_BATCH_TX_SIZE,
  checkInRegistration,
  createAccessCheckIn,
  getAccessCheckInCounts,
  getActiveAccessItems,
  getActiveEventAccessId,
  getEligibleRegistrationAccessTypeIds,
  getEligibleRegistrationIds,
  countCheckedInRegistrations,
  countEventRegistrations,
  getNetworkingAdmittedRegistrationIds,
  getRegistrationForCheckIn,
  getRegistrationsForCheckIn,
  isNetworkingAccessAllowed,
  type BatchCheckInItem,
  type CheckInRegistration,
} from "@app/db";
import { createLogger, isFullySettled } from "@app/shared";
import { AppException } from "../../core/app-exception";

const logger = createLogger({ name: "checkin" });

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

const paymentRequired = () =>
  new AppException(
    ErrorCodes.CHECKIN_PAYMENT_REQUIRED,
    "Registration payment is not settled",
    400,
  );

const networkingMeetingRequired = () =>
  new AppException(
    ErrorCodes.CHECKIN_NETWORKING_MEETING_REQUIRED,
    "An eligible networking profile and a confirmed meeting are required for this area",
    403,
  );

/**
 * Throws the first rule a scan breaks, in the load-bearing order
 * registration-exists → event-mismatch → payment-status →
 * access-on-registration. The networking entrance rule comes after, from the
 * database.
 */
function assertCheckInAllowed(
  registration: CheckInRegistration | null | undefined,
  eventId: string,
  accessId: string | undefined,
): asserts registration is CheckInRegistration {
  if (!registration) {
    throw new AppException(
      ErrorCodes.REGISTRATION_NOT_FOUND,
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
  if (!isFullySettled(registration.paymentStatus)) throw paymentRequired();
  if (accessId && !registration.accessTypeIds.includes(accessId)) {
    throw new AppException(
      ErrorCodes.CHECKIN_ACCESS_NOT_ON_REGISTRATION,
      "Registration does not include this access item",
      400,
    );
  }
}

type SyncOutcome = "SYNCED" | "ALREADY_CHECKED_IN" | { error: string };

@Injectable()
export class CheckinService {
  /**
   * Check-in a registration (event- or access-level). Check ORDER is
   * load-bearing: registration-exists → event-mismatch → payment-status →
   * access-on-registration → networking entrance → write. "Already checked
   * in" is a 200 success with alreadyCheckedIn:true (never an error). The
   * write only changes a row that is not checked in yet (and, at event level,
   * is still fully settled), so parallel scans produce one check-in.
   */
  async checkIn(
    eventId: string,
    registrationId: string,
    accessId: string | undefined,
    userId: string,
    checkedInAt = new Date(),
  ) {
    const registration = await getRegistrationForCheckIn(registrationId);
    assertCheckInAllowed(registration, eventId, accessId);

    if (
      accessId &&
      !(await isNetworkingAccessAllowed(eventId, registrationId, accessId))
    ) {
      throw networkingMeetingRequired();
    }

    if (!accessId && registration.checkedInAt) {
      return {
        success: true,
        alreadyCheckedIn: true,
        checkedInAt: registration.checkedInAt,
        registration: registrationSummary(registration),
      };
    }

    const input = {
      registrationId,
      eventId: registration.eventId,
      clientId: registration.clientId,
      checkedInBy: userId,
      checkedInAt,
    };
    const result = accessId
      ? await createAccessCheckIn({ ...input, accessId })
      : await checkInRegistration(input);
    // The registration stopped being fully settled after it was read.
    if (result.outcome === "NOT_ELIGIBLE") throw paymentRequired();

    return {
      success: true,
      alreadyCheckedIn: result.outcome === "ALREADY_CHECKED_IN",
      checkedInAt: result.checkedInAt,
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
        throw new AppException(ErrorCodes.ACCESS_NOT_FOUND, "Access item not found", 404);
      }
    }
    return getEligibleRegistrationIds(eventId, accessId);
  }

  /**
   * Batch sync offline check-ins (at most 500 per request, enforced by the
   * body schema). Items are validated like `checkIn` and written
   * CHECK_IN_BATCH_TX_SIZE per transaction. One bad item never fails the
   * others; a non-AppError becomes "Unknown error". Never throws; the endpoint
   * always answers 200.
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
    const outcomes: SyncOutcome[] = [];
    for (let start = 0; start < checkIns.length; start += CHECK_IN_BATCH_TX_SIZE) {
      const chunk = checkIns.slice(start, start + CHECK_IN_BATCH_TX_SIZE);
      try {
        outcomes.push(...(await this.syncChunk(eventId, chunk, userId)));
      } catch (error) {
        logger.error({ err: error, eventId }, "Check-in sync chunk failed");
        outcomes.push(...chunk.map(() => ({ error: "Unknown error" })));
      }
    }

    let synced = 0;
    let alreadyCheckedIn = 0;
    const errors: Array<{ registrationId: string; error: string }> = [];
    outcomes.forEach((outcome, index) => {
      if (outcome === "SYNCED") synced++;
      else if (outcome === "ALREADY_CHECKED_IN") alreadyCheckedIn++;
      else errors.push({ registrationId: checkIns[index]!.registrationId, error: outcome.error });
    });
    return { synced, alreadyCheckedIn, errors };
  }

  /** One transaction's worth of sync items → one outcome per item, in order. */
  private async syncChunk(
    eventId: string,
    chunk: Array<{ registrationId: string; accessId?: string; scannedAt: string }>,
    userId: string,
  ): Promise<SyncOutcome[]> {
    const registrations = await getRegistrationsForCheckIn(
      chunk.map((item) => item.registrationId),
    );
    const outcomes: SyncOutcome[] = chunk.map((item) => {
      try {
        assertCheckInAllowed(registrations.get(item.registrationId), eventId, item.accessId);
        return "SYNCED";
      } catch (error) {
        return { error: (error as AppException).message };
      }
    });

    // Networking entrance rule: one query per access item in the chunk.
    const byAccess = new Map<string, string[]>();
    chunk.forEach((item, index) => {
      if (!item.accessId || outcomes[index] !== "SYNCED") return;
      byAccess.set(item.accessId, [
        ...(byAccess.get(item.accessId) ?? []),
        item.registrationId,
      ]);
    });
    const admitted = new Map<string, Set<string>>();
    for (const [accessId, ids] of byAccess) {
      admitted.set(
        accessId,
        await getNetworkingAdmittedRegistrationIds(eventId, accessId, ids),
      );
    }

    const writes: Array<{ index: number; item: BatchCheckInItem }> = [];
    chunk.forEach((item, index) => {
      if (outcomes[index] !== "SYNCED") return;
      if (item.accessId && !admitted.get(item.accessId)?.has(item.registrationId)) {
        outcomes[index] = { error: networkingMeetingRequired().message };
        return;
      }
      const registration = registrations.get(item.registrationId)!;
      writes.push({
        index,
        item: {
          registrationId: item.registrationId,
          eventId: registration.eventId,
          clientId: registration.clientId,
          accessId: item.accessId,
          checkedInBy: userId,
          checkedInAt: new Date(item.scannedAt),
        },
      });
    });

    const results = await batchCheckIn(writes.map((write) => write.item));
    results.forEach((result, position) => {
      const { index } = writes[position]!;
      if (result.outcome === "CHECKED_IN") outcomes[index] = "SYNCED";
      else if (result.outcome === "ALREADY_CHECKED_IN") {
        outcomes[index] = "ALREADY_CHECKED_IN";
      } else if (result.outcome === "NOT_ELIGIBLE") {
        outcomes[index] = { error: paymentRequired().message };
      } else {
        logger.error(
          { err: result.error, eventId, registrationId: chunk[index]!.registrationId },
          "Check-in sync item failed",
        );
        outcomes[index] = { error: "Unknown error" };
      }
    });
    return outcomes;
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
