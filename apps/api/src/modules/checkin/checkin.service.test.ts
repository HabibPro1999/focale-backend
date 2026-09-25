import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "@app/contracts";

// Mock the db query layer (the seam the service talks to). Each write fn owns
// its own transaction internally, so there is no withTxn to stub here. The
// write fns return an outcome: CHECKED_IN / ALREADY_CHECKED_IN (a concurrent
// scan won) / NOT_ELIGIBLE (event level: no longer fully settled).
vi.mock("@app/db", () => ({
  CHECK_IN_BATCH_TX_SIZE: 100,
  getRegistrationForCheckIn: vi.fn(),
  getRegistrationsForCheckIn: vi.fn(),
  isNetworkingAccessAllowed: vi.fn(),
  getNetworkingAdmittedRegistrationIds: vi.fn(),
  getActiveEventAccessId: vi.fn(),
  getEligibleRegistrationIds: vi.fn(),
  countEventRegistrations: vi.fn(),
  countCheckedInRegistrations: vi.fn(),
  getAccessCheckInCounts: vi.fn(),
  getActiveAccessItems: vi.fn(),
  getEligibleRegistrationAccessTypeIds: vi.fn(),
  checkInRegistration: vi.fn(),
  createAccessCheckIn: vi.fn(),
  batchCheckIn: vi.fn(),
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

const checkedIn = (checkedInAt = new Date("2026-04-03T11:00:00Z")) => ({
  outcome: "CHECKED_IN" as const,
  checkedInAt,
});
const alreadyIn = (checkedInAt: Date) => ({
  outcome: "ALREADY_CHECKED_IN" as const,
  checkedInAt,
});

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
  m.isNetworkingAccessAllowed.mockResolvedValue(true);
});

describe("CheckinService", () => {
  describe("checkIn", () => {
    it("rejects networking entrance scans without a confirmed meeting before any check-in write", async () => {
      m.getRegistrationForCheckIn.mockResolvedValue(baseRegistration);
      m.isNetworkingAccessAllowed.mockResolvedValue(false);
      await expect(service.checkIn(eventId, registrationId, accessId, userId)).rejects.toMatchObject({
        code: ErrorCodes.CHECKIN_NETWORKING_MEETING_REQUIRED,
      });
      expect(m.createAccessCheckIn).not.toHaveBeenCalled();
    });
    it("should perform event-level check-in", async () => {
      m.getRegistrationForCheckIn.mockResolvedValue(baseRegistration);
      m.checkInRegistration.mockImplementation(async (input: { checkedInAt: Date }) =>
        checkedIn(input.checkedInAt),
      );

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

    it("returns alreadyCheckedIn with the winner's time when a concurrent event-level scan wins the CAS", async () => {
      const winnerAt = new Date("2026-04-03T09:59:59Z");
      m.getRegistrationForCheckIn.mockResolvedValue(baseRegistration);
      m.checkInRegistration.mockResolvedValue(alreadyIn(winnerAt));

      const result = await service.checkIn(eventId, registrationId, undefined, userId);

      expect(result).toMatchObject({ success: true, alreadyCheckedIn: true, checkedInAt: winnerAt });
    });

    it("rejects with PAYMENT_REQUIRED when the registration stops being settled before the CAS", async () => {
      m.getRegistrationForCheckIn.mockResolvedValue(baseRegistration);
      m.checkInRegistration.mockResolvedValue({ outcome: "NOT_ELIGIBLE" });

      await expect(
        service.checkIn(eventId, registrationId, undefined, userId),
      ).rejects.toMatchObject({ statusCode: 400, code: ErrorCodes.CHECKIN_PAYMENT_REQUIRED });
    });

    it("should perform access-level check-in", async () => {
      m.getRegistrationForCheckIn.mockResolvedValue(baseRegistration);
      const createdAt = new Date("2026-04-03T11:00:00Z");
      m.createAccessCheckIn.mockResolvedValue(checkedIn(createdAt));

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
      m.createAccessCheckIn.mockResolvedValue(alreadyIn(new Date("2026-04-03T09:00:00Z")));

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

    it("rethrows when the access check-in write fails", async () => {
      m.getRegistrationForCheckIn.mockResolvedValue(baseRegistration);
      m.createAccessCheckIn.mockRejectedValue(new Error("boom"));

      await expect(
        service.checkIn(eventId, registrationId, accessId, userId),
      ).rejects.toThrow("boom");
    });

    it.each(nonPaidAllowedPaymentStatuses)(
      "should allow event-level check-in for %s registrations",
      async (paymentStatus) => {
        m.getRegistrationForCheckIn.mockResolvedValue({
          ...baseRegistration,
          paymentStatus,
        });
        m.checkInRegistration.mockResolvedValue(checkedIn());

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
        m.createAccessCheckIn.mockResolvedValue(checkedIn());

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

        expect(m.isNetworkingAccessAllowed).not.toHaveBeenCalled();
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
    const regs = (...rows: Array<typeof baseRegistration>) =>
      new Map(rows.map((row) => [row.id, row]));
    const item = (id: string, extra: { accessId?: string; scannedAt?: string } = {}) => ({
      registrationId: id,
      scannedAt: extra.scannedAt ?? "2026-04-03T10:00:00Z",
      ...(extra.accessId ? { accessId: extra.accessId } : {}),
    });
    // batchCheckIn stub: per-item outcome from `pick`, in input order.
    const writeWith = (pick: (input: { registrationId: string; checkedInAt: Date }) => unknown) =>
      m.batchCheckIn.mockImplementation(async (items: Array<{ registrationId: string; checkedInAt: Date }>) =>
        items.map(pick),
      );

    it("should count synced, already checked in, and errors", async () => {
      m.getRegistrationsForCheckIn.mockResolvedValue(
        regs(baseRegistration, { ...baseRegistration, id: "reg-002" }),
      );
      writeWith((input) =>
        input.registrationId === "reg-002"
          ? alreadyIn(new Date("2026-04-03T09:00:00Z"))
          : checkedIn(input.checkedInAt),
      );

      const result = await service.batchSync(
        eventId,
        [
          item("reg-001", { scannedAt: "2026-04-03T10:00:00Z" }),
          item("reg-002", { scannedAt: "2026-04-03T10:01:00Z" }),
          item("reg-003", { scannedAt: "2026-04-03T10:02:00Z" }),
        ],
        userId,
      );

      expect(result).toEqual({
        synced: 1,
        alreadyCheckedIn: 1,
        errors: [{ registrationId: "reg-003", error: "Registration not found" }],
      });
      // scannedAt string is parsed into a Date and passed through as checkedInAt;
      // the unknown registration never reaches the write.
      expect(m.batchCheckIn).toHaveBeenCalledTimes(1);
      expect(m.batchCheckIn.mock.calls[0]![0]).toEqual([
        expect.objectContaining({
          registrationId: "reg-001",
          eventId,
          clientId: "client-001",
          checkedInBy: userId,
          checkedInAt: new Date("2026-04-03T10:00:00Z"),
        }),
        expect.objectContaining({ registrationId: "reg-002" }),
      ]);
    });

    it("applies the single check-in rules and keeps errors in input order", async () => {
      m.getRegistrationsForCheckIn.mockResolvedValue(
        regs(
          { ...baseRegistration, id: "unpaid", paymentStatus: "PENDING" },
          { ...baseRegistration, id: "elsewhere", eventId: "other-event" },
          { ...baseRegistration, id: "no-access", accessTypeIds: [] },
          { ...baseRegistration, id: "no-meeting" },
          { ...baseRegistration, id: "ok" },
          { ...baseRegistration, id: "refunded-meanwhile" },
        ),
      );
      m.getNetworkingAdmittedRegistrationIds.mockResolvedValue(new Set(["ok"]));
      writeWith((input) =>
        input.registrationId === "refunded-meanwhile"
          ? { outcome: "NOT_ELIGIBLE" }
          : checkedIn(input.checkedInAt),
      );

      const result = await service.batchSync(
        eventId,
        [
          item("unpaid"),
          item("elsewhere"),
          item("no-access", { accessId }),
          item("no-meeting", { accessId }),
          item("ok", { accessId }),
          item("refunded-meanwhile"),
        ],
        userId,
      );

      expect(result.synced).toBe(1);
      expect(result.errors).toEqual([
        { registrationId: "unpaid", error: "Registration payment is not settled" },
        { registrationId: "elsewhere", error: "Registration does not belong to this event" },
        { registrationId: "no-access", error: "Registration does not include this access item" },
        {
          registrationId: "no-meeting",
          error: "An eligible networking profile and a confirmed meeting are required for this area",
        },
        { registrationId: "refunded-meanwhile", error: "Registration payment is not settled" },
      ]);
      // One networking query for the access item, over the items still eligible.
      expect(m.getNetworkingAdmittedRegistrationIds).toHaveBeenCalledTimes(1);
      expect(m.getNetworkingAdmittedRegistrationIds).toHaveBeenCalledWith(eventId, accessId, [
        "no-meeting",
        "ok",
      ]);
      expect(m.batchCheckIn.mock.calls[0]![0].map((w: { registrationId: string }) => w.registrationId)).toEqual([
        "ok",
        "refunded-meanwhile",
      ]);
    });

    it("writes at most 100 items per transaction", async () => {
      const ids = Array.from({ length: 250 }, (_, i) => `reg-${String(i).padStart(3, "0")}`);
      m.getRegistrationsForCheckIn.mockImplementation(async (requested: string[]) =>
        regs(...requested.map((id) => ({ ...baseRegistration, id }))),
      );
      writeWith((input) => checkedIn(input.checkedInAt));

      const result = await service.batchSync(eventId, ids.map((id) => item(id)), userId);

      expect(result).toEqual({ synced: 250, alreadyCheckedIn: 0, errors: [] });
      expect(m.batchCheckIn.mock.calls.map((call) => call[0].length)).toEqual([100, 100, 50]);
      expect(m.getRegistrationsForCheckIn.mock.calls.map((call) => call[0].length)).toEqual([
        100, 100, 50,
      ]);
    });

    it("reports a failed item as 'Unknown error' without failing the others", async () => {
      m.getRegistrationsForCheckIn.mockResolvedValue(
        regs(baseRegistration, { ...baseRegistration, id: "reg-002" }),
      );
      writeWith((input) =>
        input.registrationId === "reg-002"
          ? { outcome: "FAILED", error: new Error("fk violation") }
          : checkedIn(input.checkedInAt),
      );

      const result = await service.batchSync(
        eventId,
        [item("reg-001"), item("reg-002")],
        userId,
      );

      expect(result).toEqual({
        synced: 1,
        alreadyCheckedIn: 0,
        errors: [{ registrationId: "reg-002", error: "Unknown error" }],
      });
    });

    it("uses 'Unknown error' for every item of a chunk whose reads fail", async () => {
      m.getRegistrationsForCheckIn.mockRejectedValue(new Error("db down"));

      const result = await service.batchSync(
        eventId,
        [item("reg-001"), item("reg-002")],
        userId,
      );

      expect(result.errors).toEqual([
        { registrationId: "reg-001", error: "Unknown error" },
        { registrationId: "reg-002", error: "Unknown error" },
      ]);
      expect(m.batchCheckIn).not.toHaveBeenCalled();
    });

    it("returns zeroed counts for an empty batch", async () => {
      const result = await service.batchSync(eventId, [], userId);
      expect(result).toEqual({ synced: 0, alreadyCheckedIn: 0, errors: [] });
      expect(m.batchCheckIn).not.toHaveBeenCalled();
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
