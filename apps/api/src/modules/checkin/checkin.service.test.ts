import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "@app/contracts";

// Mock the db query layer (the seam the service talks to). Each write fn owns
// its own transaction internally, so there is no withTxn to stub here.
vi.mock("@app/db", () => ({
  CHECKIN_ELIGIBLE_STATUSES: ["PAID", "SPONSORED", "WAIVED"],
  getRegistrationForCheckIn: vi.fn(),
  getAccessCheckIn: vi.fn(),
  getActiveEventAccessId: vi.fn(),
  getEligibleRegistrationIds: vi.fn(),
  countEventRegistrations: vi.fn(),
  countCheckedInRegistrations: vi.fn(),
  getAccessCheckInCounts: vi.fn(),
  getActiveAccessItems: vi.fn(),
  getEligibleRegistrationAccessTypeIds: vi.fn(),
  checkInRegistration: vi.fn(),
  createAccessCheckIn: vi.fn(),
  pgUniqueViolation: (err: unknown) => {
    const e = err as { code?: unknown; constraint?: unknown } | null;
    return e?.code === "23505"
      ? { constraint: typeof e.constraint === "string" ? e.constraint : "" }
      : null;
  },
}));

import * as db from "@app/db";
import { CheckinService } from "./checkin.service";

const m = db as unknown as Record<string, ReturnType<typeof vi.fn>>;
const service = new CheckinService();

const eventId = "event-001";
const registrationId = "reg-001";
const accessId = "access-001";
const userId = "user-001";
const blockedPaymentStatuses = ["PENDING", "VERIFYING", "PARTIAL", "REFUNDED"];
const nonPaidAllowedPaymentStatuses = ["SPONSORED", "WAIVED"];

// Simulates a pg unique-constraint violation (23505) on the composite key.
function uniqueViolation() {
  return {
    code: "23505",
    constraint: "access_check_ins_registration_id_access_id_key",
  };
}

const baseRegistration = {
  id: registrationId,
  eventId,
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.com",
  referenceNumber: "REF-001",
  paymentStatus: "PAID",
  checkedInAt: null as Date | null,
  checkedInBy: null as string | null,
  accessTypeIds: [accessId],
  clientId: "client-001",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CheckinService", () => {
  describe("checkIn", () => {
    it("should perform event-level check-in", async () => {
      m.getRegistrationForCheckIn.mockResolvedValue(baseRegistration);
      m.checkInRegistration.mockResolvedValue(undefined);

      const result = await service.checkIn(
        eventId,
        registrationId,
        undefined,
        userId,
      );

      expect(result.success).toBe(true);
      expect(result.alreadyCheckedIn).toBe(false);
      expect(result.checkedInAt).toBeInstanceOf(Date);
      expect(result.registration.id).toBe(registrationId);
      expect(m.checkInRegistration).toHaveBeenCalledWith(
        expect.objectContaining({
          registrationId,
          eventId,
          clientId: "client-001",
          checkedInBy: userId,
          checkedInAt: expect.any(Date),
        }),
      );
    });

    it("should return alreadyCheckedIn for event-level re-check-in", async () => {
      const checkedInAt = new Date("2026-04-03T10:00:00Z");
      m.getRegistrationForCheckIn.mockResolvedValue({
        ...baseRegistration,
        checkedInAt,
        checkedInBy: userId,
      });

      const result = await service.checkIn(
        eventId,
        registrationId,
        undefined,
        userId,
      );

      expect(result.success).toBe(true);
      expect(result.alreadyCheckedIn).toBe(true);
      expect(result.checkedInAt).toEqual(checkedInAt);
      expect(m.checkInRegistration).not.toHaveBeenCalled();
    });

    it("should perform access-level check-in", async () => {
      m.getRegistrationForCheckIn.mockResolvedValue(baseRegistration);
      m.getAccessCheckIn.mockResolvedValue(null);
      const createdAt = new Date("2026-04-03T11:00:00Z");
      m.createAccessCheckIn.mockResolvedValue({
        id: "aci-001",
        registrationId,
        accessId,
        checkedInBy: userId,
        checkedInAt: createdAt,
      });

      const result = await service.checkIn(
        eventId,
        registrationId,
        accessId,
        userId,
      );

      expect(result.success).toBe(true);
      expect(result.alreadyCheckedIn).toBe(false);
      expect(result.checkedInAt).toEqual(createdAt);
      expect(m.createAccessCheckIn).toHaveBeenCalledWith(
        expect.objectContaining({
          registrationId,
          eventId,
          accessId,
          clientId: "client-001",
          checkedInBy: userId,
          checkedInAt: expect.any(Date),
        }),
      );
    });

    it("returns alreadyCheckedIn when a concurrent access check-in wins the insert race", async () => {
      m.getRegistrationForCheckIn.mockResolvedValue(baseRegistration);
      m.getAccessCheckIn
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "aci-001",
          registrationId,
          accessId,
          checkedInAt: new Date("2026-04-03T09:00:00Z"),
          checkedInBy: "other-user",
        });
      m.createAccessCheckIn.mockRejectedValue(uniqueViolation());

      const result = await service.checkIn(
        eventId,
        registrationId,
        accessId,
        userId,
      );

      expect(result.success).toBe(true);
      expect(result.alreadyCheckedIn).toBe(true);
      expect(result.checkedInAt).toEqual(new Date("2026-04-03T09:00:00Z"));
    });

    it("rethrows when the insert fails with a non-unique-violation error", async () => {
      m.getRegistrationForCheckIn.mockResolvedValue(baseRegistration);
      m.getAccessCheckIn.mockResolvedValue(null);
      m.createAccessCheckIn.mockRejectedValue(new Error("boom"));

      await expect(
        service.checkIn(eventId, registrationId, accessId, userId),
      ).rejects.toThrow("boom");
    });

    it("rethrows the unique violation when the re-query finds nothing", async () => {
      m.getRegistrationForCheckIn.mockResolvedValue(baseRegistration);
      m.getAccessCheckIn.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      m.createAccessCheckIn.mockRejectedValue(uniqueViolation());

      await expect(
        service.checkIn(eventId, registrationId, accessId, userId),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("should return alreadyCheckedIn for access-level re-check-in", async () => {
      m.getRegistrationForCheckIn.mockResolvedValue(baseRegistration);
      const existingAt = new Date("2026-04-03T09:00:00Z");
      m.getAccessCheckIn.mockResolvedValue({
        id: "aci-001",
        registrationId,
        accessId,
        checkedInAt: existingAt,
        checkedInBy: userId,
      });

      const result = await service.checkIn(
        eventId,
        registrationId,
        accessId,
        userId,
      );

      expect(result.success).toBe(true);
      expect(result.alreadyCheckedIn).toBe(true);
      expect(result.checkedInAt).toEqual(existingAt);
      expect(m.createAccessCheckIn).not.toHaveBeenCalled();
    });

    it.each(nonPaidAllowedPaymentStatuses)(
      "should allow event-level check-in for %s registrations",
      async (paymentStatus) => {
        m.getRegistrationForCheckIn.mockResolvedValue({
          ...baseRegistration,
          paymentStatus,
        });
        m.checkInRegistration.mockResolvedValue(undefined);

        const result = await service.checkIn(
          eventId,
          registrationId,
          undefined,
          userId,
        );

        expect(result.success).toBe(true);
        expect(result.alreadyCheckedIn).toBe(false);
        expect(m.checkInRegistration).toHaveBeenCalledWith(
          expect.objectContaining({ checkedInBy: userId }),
        );
      },
    );

    it.each(nonPaidAllowedPaymentStatuses)(
      "should allow access-level check-in for %s registrations",
      async (paymentStatus) => {
        m.getRegistrationForCheckIn.mockResolvedValue({
          ...baseRegistration,
          paymentStatus,
        });
        m.getAccessCheckIn.mockResolvedValue(null);
        m.createAccessCheckIn.mockResolvedValue({
          id: "aci-001",
          registrationId,
          accessId,
          checkedInBy: userId,
          checkedInAt: new Date("2026-04-03T11:00:00Z"),
        });

        const result = await service.checkIn(
          eventId,
          registrationId,
          accessId,
          userId,
        );

        expect(result.success).toBe(true);
        expect(result.alreadyCheckedIn).toBe(false);
        expect(m.createAccessCheckIn).toHaveBeenCalledWith(
          expect.objectContaining({
            registrationId,
            accessId,
            checkedInBy: userId,
            checkedInAt: expect.any(Date),
          }),
        );
      },
    );

    it.each(blockedPaymentStatuses)(
      "should reject event-level check-in for %s registrations before writing",
      async (paymentStatus) => {
        m.getRegistrationForCheckIn.mockResolvedValue({
          ...baseRegistration,
          paymentStatus,
        });

        await expect(
          service.checkIn(eventId, registrationId, undefined, userId),
        ).rejects.toMatchObject({
          statusCode: 400,
          code: ErrorCodes.CHECKIN_PAYMENT_REQUIRED,
        });

        expect(m.checkInRegistration).not.toHaveBeenCalled();
        expect(m.createAccessCheckIn).not.toHaveBeenCalled();
      },
    );

    it.each(blockedPaymentStatuses)(
      "should reject access-level check-in for %s registrations before writing",
      async (paymentStatus) => {
        m.getRegistrationForCheckIn.mockResolvedValue({
          ...baseRegistration,
          paymentStatus,
        });

        await expect(
          service.checkIn(eventId, registrationId, accessId, userId),
        ).rejects.toMatchObject({
          statusCode: 400,
          code: ErrorCodes.CHECKIN_PAYMENT_REQUIRED,
        });

        expect(m.getAccessCheckIn).not.toHaveBeenCalled();
        expect(m.createAccessCheckIn).not.toHaveBeenCalled();
        expect(m.checkInRegistration).not.toHaveBeenCalled();
      },
    );

    it("should throw when registration not found", async () => {
      m.getRegistrationForCheckIn.mockResolvedValue(null);

      await expect(
        service.checkIn(eventId, registrationId, undefined, userId),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.CHECKIN_REGISTRATION_NOT_FOUND,
      });
    });

    it("should throw when registration belongs to a different event", async () => {
      m.getRegistrationForCheckIn.mockResolvedValue({
        ...baseRegistration,
        eventId: "other-event",
      });

      await expect(
        service.checkIn(eventId, registrationId, undefined, userId),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.CHECKIN_EVENT_MISMATCH,
      });
    });

    it("should throw when access item not on registration", async () => {
      m.getRegistrationForCheckIn.mockResolvedValue({
        ...baseRegistration,
        accessTypeIds: [],
      });

      await expect(
        service.checkIn(eventId, registrationId, accessId, userId),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.CHECKIN_ACCESS_NOT_ON_REGISTRATION,
      });
    });
  });

  describe("getCheckInRegistrations", () => {
    it("should return only IDs for eligible registrations", async () => {
      m.getEligibleRegistrationIds.mockResolvedValue(["reg-1", "reg-2"]);

      const result = await service.getCheckInRegistrations(eventId);

      expect(result).toEqual(["reg-1", "reg-2"]);
      expect(m.getEligibleRegistrationIds).toHaveBeenCalledWith(
        eventId,
        undefined,
      );
      expect(m.getActiveEventAccessId).not.toHaveBeenCalled();
    });

    it("should filter by accessId when provided", async () => {
      m.getActiveEventAccessId.mockResolvedValue(accessId);
      m.getEligibleRegistrationIds.mockResolvedValue(["reg-1"]);

      const result = await service.getCheckInRegistrations(eventId, accessId);

      expect(result).toEqual(["reg-1"]);
      expect(m.getActiveEventAccessId).toHaveBeenCalledWith(accessId, eventId);
      expect(m.getEligibleRegistrationIds).toHaveBeenCalledWith(
        eventId,
        accessId,
      );
    });

    it("throws when accessId does not belong to the event", async () => {
      m.getActiveEventAccessId.mockResolvedValue(null);

      await expect(
        service.getCheckInRegistrations(eventId, accessId),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });

      expect(m.getEligibleRegistrationIds).not.toHaveBeenCalled();
    });

    it("should return empty array when no matching registrations", async () => {
      m.getEligibleRegistrationIds.mockResolvedValue([]);

      const result = await service.getCheckInRegistrations(eventId);

      expect(result).toEqual([]);
    });
  });

  describe("batchSync", () => {
    it("should count synced, already checked in, and errors", async () => {
      m.getRegistrationForCheckIn
        .mockResolvedValueOnce(baseRegistration)
        .mockResolvedValueOnce({
          ...baseRegistration,
          id: "reg-002",
          checkedInAt: new Date(),
        })
        .mockResolvedValueOnce(null);
      m.checkInRegistration.mockResolvedValue(undefined);

      const result = await service.batchSync(
        eventId,
        [
          { registrationId: "reg-001", scannedAt: "2026-04-03T10:00:00Z" },
          { registrationId: "reg-002", scannedAt: "2026-04-03T10:01:00Z" },
          { registrationId: "reg-003", scannedAt: "2026-04-03T10:02:00Z" },
        ],
        userId,
      );

      expect(result.synced).toBe(1);
      expect(result.alreadyCheckedIn).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].registrationId).toBe("reg-003");
      // scannedAt string is parsed into a Date and passed through as checkedInAt.
      expect(m.checkInRegistration).toHaveBeenCalledWith(
        expect.objectContaining({
          checkedInAt: new Date("2026-04-03T10:00:00Z"),
        }),
      );
    });

    it("uses 'Unknown error' for a non-AppException failure", async () => {
      m.getRegistrationForCheckIn.mockRejectedValue(new Error("db down"));

      const result = await service.batchSync(
        eventId,
        [{ registrationId: "reg-001", scannedAt: "2026-04-03T10:00:00Z" }],
        userId,
      );

      expect(result.errors).toEqual([
        { registrationId: "reg-001", error: "Unknown error" },
      ]);
    });

    it("returns zeroed counts for an empty batch", async () => {
      const result = await service.batchSync(eventId, [], userId);
      expect(result).toEqual({ synced: 0, alreadyCheckedIn: 0, errors: [] });
    });
  });

  describe("getCheckInStats", () => {
    it("should return aggregated check-in statistics", async () => {
      m.countEventRegistrations.mockResolvedValue(100);
      m.countCheckedInRegistrations.mockResolvedValue(42);
      m.getAccessCheckInCounts.mockResolvedValue([
        { accessId: "a1", count: 20 },
        { accessId: "a2", count: 10 },
      ]);
      m.getActiveAccessItems.mockResolvedValue([
        { id: "a1", name: "Workshop", type: "workshop" },
        { id: "a2", name: "Gala", type: "gala" },
      ]);
      m.getEligibleRegistrationAccessTypeIds.mockResolvedValue([
        { accessTypeIds: ["a1"] },
        { accessTypeIds: ["a1", "a2"] },
      ]);

      const result = await service.getCheckInStats(eventId);

      expect(result.total).toBe(100);
      expect(result.checkedIn).toBe(42);
      expect(result.byAccess).toHaveLength(2);
      expect(result.byAccess[0]).toEqual({
        accessId: "a1",
        name: "Workshop",
        type: "workshop",
        total: 2,
        checkedIn: 20,
      });
    });

    it("should default checkedIn to 0 for access with no check-ins", async () => {
      m.countEventRegistrations.mockResolvedValue(10);
      m.countCheckedInRegistrations.mockResolvedValue(0);
      m.getAccessCheckInCounts.mockResolvedValue([]);
      m.getActiveAccessItems.mockResolvedValue([
        { id: "a1", name: "Session", type: "session" },
      ]);
      m.getEligibleRegistrationAccessTypeIds.mockResolvedValue([
        { accessTypeIds: ["inactive-access"] },
      ]);

      const result = await service.getCheckInStats(eventId);

      expect(result.checkedIn).toBe(0);
      expect(result.byAccess[0].checkedIn).toBe(0);
      expect(result.byAccess[0].total).toBe(0);
    });
  });
});
