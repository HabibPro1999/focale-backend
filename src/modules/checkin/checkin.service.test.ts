import { describe, it, expect } from "vitest";
import { prismaMock, mockGroupBy } from "../../../tests/mocks/prisma.js";
import {
  checkIn,
  getCheckInRegistrations,
  batchSync,
  getCheckInStats,
} from "./checkin.service.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { Prisma } from "@/generated/prisma/client.js";

const eventId = "event-001";
const registrationId = "reg-001";
const accessId = "access-001";
const userId = "user-001";

const baseRegistration = {
  id: registrationId,
  eventId,
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.com",
  referenceNumber: "REF-001",
  paymentStatus: "paid",
  checkedInAt: null as Date | null,
  checkedInBy: null as string | null,
  accessTypeIds: [accessId],
};

describe("Checkin Service", () => {
  describe("checkIn", () => {
    it("should perform event-level check-in", async () => {
      prismaMock.registration.findUnique.mockResolvedValue(
        baseRegistration as never,
      );
      prismaMock.registration.updateMany.mockResolvedValue({ count: 1 } as never);
      prismaMock.auditLog.create.mockResolvedValue({} as never);

      const result = await checkIn(eventId, registrationId, undefined, userId);

      expect(result.success).toBe(true);
      expect(result.alreadyCheckedIn).toBe(false);
      expect(result.checkedInAt).toBeInstanceOf(Date);
      expect(result.registration.id).toBe(registrationId);
      expect(prismaMock.registration.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: registrationId, checkedInAt: null },
          data: expect.objectContaining({ checkedInBy: userId }),
        }),
      );
    });

    it("should return alreadyCheckedIn for event-level re-check-in", async () => {
      const checkedInAt = new Date("2026-04-03T10:00:00Z");
      prismaMock.registration.findUnique
        .mockResolvedValueOnce({
          ...baseRegistration,
          checkedInAt,
          checkedInBy: userId,
        } as never)
        .mockResolvedValueOnce({ checkedInAt } as never);
      // updateMany returns count: 0 because checkedInAt is already set
      prismaMock.registration.updateMany.mockResolvedValue({ count: 0 } as never);

      const result = await checkIn(eventId, registrationId, undefined, userId);

      expect(result.success).toBe(true);
      expect(result.alreadyCheckedIn).toBe(true);
      expect(result.checkedInAt).toEqual(checkedInAt);
      expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
    });

    it("should perform access-level check-in", async () => {
      prismaMock.registration.findUnique.mockResolvedValue(
        baseRegistration as never,
      );
      const createdAt = new Date("2026-04-03T11:00:00Z");
      prismaMock.accessCheckIn.create.mockResolvedValue({
        id: "aci-001",
        registrationId,
        accessId,
        checkedInBy: userId,
        checkedInAt: createdAt,
      } as never);
      prismaMock.auditLog.create.mockResolvedValue({} as never);

      const result = await checkIn(eventId, registrationId, accessId, userId);

      expect(result.success).toBe(true);
      expect(result.alreadyCheckedIn).toBe(false);
      expect(result.checkedInAt).toEqual(createdAt);
      expect(prismaMock.accessCheckIn.create).toHaveBeenCalledWith({
        data: { registrationId, accessId, checkedInBy: userId },
      });
    });

    it("should return alreadyCheckedIn for access-level re-check-in", async () => {
      prismaMock.registration.findUnique.mockResolvedValue(
        baseRegistration as never,
      );
      const existingAt = new Date("2026-04-03T09:00:00Z");
      // Simulate concurrent insert: create throws P2002, then findUnique returns the existing row
      prismaMock.accessCheckIn.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("unique constraint", {
          code: "P2002",
          clientVersion: "test",
        }),
      );
      prismaMock.accessCheckIn.findUnique.mockResolvedValue({
        id: "aci-001",
        registrationId,
        accessId,
        checkedInAt: existingAt,
        checkedInBy: userId,
      } as never);

      const result = await checkIn(eventId, registrationId, accessId, userId);

      expect(result.success).toBe(true);
      expect(result.alreadyCheckedIn).toBe(true);
      expect(result.checkedInAt).toEqual(existingAt);
      expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
    });

    it("should throw when registration not found", async () => {
      prismaMock.registration.findUnique.mockResolvedValue(null);

      await expect(
        checkIn(eventId, registrationId, undefined, userId),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.CHECKIN_REGISTRATION_NOT_FOUND,
      });
    });

    it("should throw when registration belongs to a different event", async () => {
      prismaMock.registration.findUnique.mockResolvedValue({
        ...baseRegistration,
        eventId: "other-event",
      } as never);

      await expect(
        checkIn(eventId, registrationId, undefined, userId),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.CHECKIN_EVENT_MISMATCH,
      });
    });

    it("should throw when access item not on registration", async () => {
      prismaMock.registration.findUnique.mockResolvedValue({
        ...baseRegistration,
        accessTypeIds: [],
      } as never);

      await expect(
        checkIn(eventId, registrationId, accessId, userId),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: ErrorCodes.CHECKIN_ACCESS_NOT_ON_REGISTRATION,
      });
    });
  });

  describe("getCheckInRegistrations", () => {
    it("should return only IDs for eligible registrations", async () => {
      prismaMock.registration.findMany.mockResolvedValue([
        { id: "reg-1" },
        { id: "reg-2" },
      ] as never);

      const result = await getCheckInRegistrations(eventId);

      expect(result).toEqual(["reg-1", "reg-2"]);
      expect(prismaMock.registration.findMany).toHaveBeenCalledWith({
        where: {
          eventId,
          paymentStatus: { in: ["PAID", "SPONSORED", "WAIVED"] },
        },
        select: { id: true },
      });
    });

    it("should filter by accessId when provided", async () => {
      prismaMock.registration.findMany.mockResolvedValue([
        { id: "reg-1" },
      ] as never);

      const result = await getCheckInRegistrations(eventId, accessId);

      expect(result).toEqual(["reg-1"]);
      expect(prismaMock.registration.findMany).toHaveBeenCalledWith({
        where: {
          eventId,
          paymentStatus: { in: ["PAID", "SPONSORED", "WAIVED"] },
          accessTypeIds: { has: accessId },
        },
        select: { id: true },
      });
    });

    it("should return empty array when no matching registrations", async () => {
      prismaMock.registration.findMany.mockResolvedValue([] as never);

      const result = await getCheckInRegistrations(eventId);

      expect(result).toEqual([]);
    });
  });

  describe("batchSync", () => {
    it("should count synced, already checked in, and errors", async () => {
      const reg2CheckedInAt = new Date();
      prismaMock.registration.findUnique
        .mockResolvedValueOnce(baseRegistration as never)
        .mockResolvedValueOnce({
          ...baseRegistration,
          id: "reg-002",
          checkedInAt: reg2CheckedInAt,
        } as never)
        .mockResolvedValueOnce({ checkedInAt: reg2CheckedInAt } as never)
        .mockResolvedValueOnce(null);

      // First check-in succeeds (count=1), second already checked in (count=0)
      prismaMock.registration.updateMany
        .mockResolvedValueOnce({ count: 1 } as never)
        .mockResolvedValueOnce({ count: 0 } as never);
      prismaMock.auditLog.create.mockResolvedValue({} as never);

      const result = await batchSync(
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
    });
  });

  describe("getCheckInStats", () => {
    it("should return aggregated check-in statistics", async () => {
      prismaMock.registration.count
        .mockResolvedValueOnce(100 as never)
        .mockResolvedValueOnce(42 as never);
      mockGroupBy(prismaMock.accessCheckIn.groupBy, [
        { accessId: "a1", _count: { id: 20 } },
        { accessId: "a2", _count: { id: 10 } },
      ]);
      prismaMock.eventAccess.findMany.mockResolvedValue([
        { id: "a1", name: "Workshop", type: "workshop", registeredCount: 50 },
        { id: "a2", name: "Gala", type: "gala", registeredCount: 30 },
      ] as never);

      const result = await getCheckInStats(eventId);

      expect(result.total).toBe(100);
      expect(result.checkedIn).toBe(42);
      expect(result.byAccess).toHaveLength(2);
      expect(result.byAccess[0]).toEqual({
        accessId: "a1",
        name: "Workshop",
        type: "workshop",
        total: 50,
        checkedIn: 20,
      });
    });

    it("should default checkedIn to 0 for access with no check-ins", async () => {
      prismaMock.registration.count
        .mockResolvedValueOnce(10 as never)
        .mockResolvedValueOnce(0 as never);
      mockGroupBy(prismaMock.accessCheckIn.groupBy, []);
      prismaMock.eventAccess.findMany.mockResolvedValue([
        { id: "a1", name: "Session", type: "session", registeredCount: 10 },
      ] as never);

      const result = await getCheckInStats(eventId);

      expect(result.checkedIn).toBe(0);
      expect(result.byAccess[0].checkedIn).toBe(0);
    });
  });
});
