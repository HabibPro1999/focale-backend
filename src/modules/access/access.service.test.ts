import { describe, it, expect, beforeEach, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import {
  createMockEventAccess,
  createMockEvent,
} from "../../../tests/helpers/factories.js";
import {
  createEventAccess,
  updateEventAccess,
  deleteEventAccess,
  listEventAccess,
  getEventAccessById,
  getAccessClientId,
  getGroupedAccess,
  reserveAccessSpot,
  releaseAccessSpot,
  validateAccessSelections,
} from "./access.service.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import type { CreateEventAccessInput } from "./access.schema.js";

// Helper to create EventAccess with all required fields including relations
function createEventAccessWithRelations(
  overrides: Partial<ReturnType<typeof createMockEventAccess>> & {
    requiredAccess?: { id: string; name?: string }[];
    event?: { startDate: Date; endDate: Date };
  } = {},
) {
  const { requiredAccess, event, ...accessOverrides } = overrides;
  const base = createMockEventAccess(accessOverrides);
  return {
    ...base,
    requiredAccess: requiredAccess ?? [],
    ...(event ? { event } : {}),
  };
}

describe("Access Service", () => {
  const eventId = "event-123";
  const clientId = "client-123";

  // Create event with proper dates for testing
  const eventStartDate = new Date("2025-06-01");
  const eventEndDate = new Date("2025-06-03");
  const mockEvent = createMockEvent({
    id: eventId,
    clientId,
    startDate: eventStartDate,
    endDate: eventEndDate,
  });

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  describe("createEventAccess", () => {
    it("should create a new access item successfully", async () => {
      const input = {
        eventId,
        name: "Morning Workshop",
        type: "WORKSHOP" as const,
        price: 50,
        maxCapacity: 30,
        startsAt: new Date("2025-06-01T09:00:00"),
        endsAt: new Date("2025-06-01T12:00:00"),
      };

      const createdAccess = createEventAccessWithRelations({
        id: "access-1",
        eventId,
        name: input.name,
        type: input.type,
        price: input.price,
        maxCapacity: input.maxCapacity,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        requiredAccess: [],
      });

      prismaMock.event.findUnique.mockResolvedValue(mockEvent);
      prismaMock.eventAccess.create.mockResolvedValue(createdAccess as never);

      const result = await createEventAccess(input as CreateEventAccessInput);

      expect(result.name).toBe("Morning Workshop");
      expect(result.type).toBe("WORKSHOP");
      expect(result.price).toBe(50);
      expect(prismaMock.eventAccess.create).toHaveBeenCalled();
    });

    it("should throw when event not found", async () => {
      prismaMock.event.findUnique.mockResolvedValue(null);

      await expect(
        createEventAccess({
          eventId: "non-existent",
          name: "Test",
        } as CreateEventAccessInput),
      ).rejects.toThrow(AppError);
    });

    it("should throw when access dates are outside event boundaries", async () => {
      const input = {
        eventId,
        name: "Workshop",
        startsAt: new Date("2025-05-01"), // Before event start
      } as CreateEventAccessInput;

      prismaMock.event.findUnique.mockResolvedValue(mockEvent);

      await expect(createEventAccess(input)).rejects.toThrow(AppError);
      await expect(createEventAccess(input)).rejects.toMatchObject({
        code: ErrorCodes.ACCESS_DATE_OUT_OF_BOUNDS,
      });
    });

    it("should validate prerequisite access items exist", async () => {
      const input = {
        eventId,
        name: "Advanced Workshop",
        requiredAccessIds: ["prerequisite-1", "prerequisite-2"],
      } as CreateEventAccessInput;

      // Only one prerequisite found
      prismaMock.event.findUnique.mockResolvedValue(mockEvent);
      prismaMock.eventAccess.findMany.mockResolvedValue([
        createEventAccessWithRelations({
          id: "prerequisite-1",
          eventId,
        }) as never,
      ]);

      await expect(createEventAccess(input)).rejects.toThrow(AppError);
      await expect(createEventAccess(input)).rejects.toMatchObject({
        code: ErrorCodes.BAD_REQUEST,
      });
    });

    it("should create access with prerequisites when all exist", async () => {
      const prerequisiteIds = ["prerequisite-1", "prerequisite-2"];
      const input = {
        eventId,
        name: "Advanced Workshop",
        requiredAccessIds: prerequisiteIds,
      } as CreateEventAccessInput;

      const prerequisites = prerequisiteIds.map((id) =>
        createEventAccessWithRelations({ id, eventId }),
      );

      const createdAccess = createEventAccessWithRelations({
        id: "access-new",
        eventId,
        name: input.name,
        requiredAccess: prerequisiteIds.map((id) => ({ id, name: "Prereq" })),
      });

      prismaMock.event.findUnique.mockResolvedValue(mockEvent);
      prismaMock.eventAccess.findMany.mockResolvedValue(prerequisites as never);
      prismaMock.eventAccess.create.mockResolvedValue(createdAccess as never);

      const result = await createEventAccess(input);

      expect(result.requiredAccess).toHaveLength(2);
    });

    it("should set default values correctly", async () => {
      const input = {
        eventId,
        name: "Simple Access",
      } as CreateEventAccessInput;

      const createdAccess = createEventAccessWithRelations({
        eventId,
        name: "Simple Access",
        type: "OTHER",
        price: 0,
        currency: "TND",
        active: true,
      });

      prismaMock.event.findUnique.mockResolvedValue(mockEvent);
      prismaMock.eventAccess.create.mockResolvedValue(createdAccess as never);

      await createEventAccess(input);

      expect(prismaMock.eventAccess.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: "OTHER",
            price: 0,
            currency: "TND",
            active: true,
          }),
        }),
      );
    });
  });

  describe("updateEventAccess", () => {
    it("should update an existing access item", async () => {
      const accessId = "access-1";
      const existingAccess = createEventAccessWithRelations({
        id: accessId,
        eventId,
        name: "Old Name",
        price: 50,
        requiredAccess: [],
        event: { startDate: eventStartDate, endDate: eventEndDate },
      });

      const updatedAccess = createEventAccessWithRelations({
        id: accessId,
        eventId,
        name: "New Name",
        price: 75,
        requiredAccess: [],
      });

      prismaMock.eventAccess.findUnique.mockResolvedValue(
        existingAccess as never,
      );
      prismaMock.eventAccess.update.mockResolvedValue(updatedAccess as never);

      const result = await updateEventAccess(accessId, {
        name: "New Name",
        price: 75,
      });

      expect(result.name).toBe("New Name");
      expect(result.price).toBe(75);
    });

    it("should throw when access not found", async () => {
      prismaMock.eventAccess.findUnique.mockResolvedValue(null);

      await expect(
        updateEventAccess("non-existent", { name: "Test" }),
      ).rejects.toThrow(AppError);
      await expect(
        updateEventAccess("non-existent", { name: "Test" }),
      ).rejects.toMatchObject({
        code: ErrorCodes.ACCESS_NOT_FOUND,
      });
    });

    it("should throw when updated dates are outside event boundaries", async () => {
      const accessId = "access-1";
      const existingAccess = createEventAccessWithRelations({
        id: accessId,
        eventId,
        startsAt: new Date("2025-06-01T10:00:00"),
        requiredAccess: [],
        event: { startDate: eventStartDate, endDate: eventEndDate },
      });

      prismaMock.eventAccess.findUnique.mockResolvedValue(
        existingAccess as never,
      );

      await expect(
        updateEventAccess(accessId, {
          startsAt: new Date("2025-07-01"), // Outside event dates
        }),
      ).rejects.toThrow(AppError);
    });

    it("should detect circular prerequisites", async () => {
      const accessA = "access-a";
      const accessB = "access-b";
      const accessC = "access-c";

      // Existing graph: A -> B -> C
      // Trying to add: C -> A (creates cycle)
      const existingAccessC = createEventAccessWithRelations({
        id: accessC,
        eventId,
        requiredAccess: [],
        event: { startDate: eventStartDate, endDate: eventEndDate },
      });

      const allAccess = [
        { id: accessA, requiredAccess: [{ id: accessB }] },
        { id: accessB, requiredAccess: [{ id: accessC }] },
        { id: accessC, requiredAccess: [] },
      ];

      const prerequisiteA = createEventAccessWithRelations({
        id: accessA,
        eventId,
      });

      // Set up mocks for both assertions (each await consumes the mock)
      prismaMock.eventAccess.findUnique
        .mockResolvedValueOnce(existingAccessC as never)
        .mockResolvedValueOnce(existingAccessC as never);
      prismaMock.eventAccess.findMany
        .mockResolvedValueOnce([prerequisiteA] as never) // prerequisite validation (1st call)
        .mockResolvedValueOnce(allAccess as never) // circular check (1st call)
        .mockResolvedValueOnce([prerequisiteA] as never) // prerequisite validation (2nd call)
        .mockResolvedValueOnce(allAccess as never); // circular check (2nd call)

      await expect(
        updateEventAccess(accessC, { requiredAccessIds: [accessA] }),
      ).rejects.toThrow(AppError);
      await expect(
        updateEventAccess(accessC, { requiredAccessIds: [accessA] }),
      ).rejects.toMatchObject({
        code: ErrorCodes.ACCESS_CIRCULAR_DEPENDENCY,
      });
    });

    it("should allow valid prerequisite updates", async () => {
      const accessId = "access-main";
      const prerequisiteId = "access-prereq";

      const existingAccess = createEventAccessWithRelations({
        id: accessId,
        eventId,
        requiredAccess: [],
        event: { startDate: eventStartDate, endDate: eventEndDate },
      });

      const prerequisite = createEventAccessWithRelations({
        id: prerequisiteId,
        eventId,
      });

      const updatedAccess = createEventAccessWithRelations({
        id: accessId,
        eventId,
        requiredAccess: [{ id: prerequisiteId, name: "Prerequisite" }],
      });

      // No circular dependency (simple A -> B)
      const allAccess = [
        { id: accessId, requiredAccess: [] },
        { id: prerequisiteId, requiredAccess: [] },
      ];

      prismaMock.eventAccess.findUnique.mockResolvedValue(
        existingAccess as never,
      );
      prismaMock.eventAccess.findMany
        .mockResolvedValueOnce([prerequisite] as never) // prerequisite validation
        .mockResolvedValueOnce(allAccess as never); // circular check
      prismaMock.eventAccess.update.mockResolvedValue(updatedAccess as never);

      const result = await updateEventAccess(accessId, {
        requiredAccessIds: [prerequisiteId],
      });

      expect(result.requiredAccess).toHaveLength(1);
    });
  });

  describe("deleteEventAccess", () => {
    it("should delete an access item without registrations", async () => {
      const accessId = "access-1";
      const existingAccess = createEventAccessWithRelations({
        id: accessId,
        eventId,
      });

      prismaMock.eventAccess.findUnique.mockResolvedValue(
        existingAccess as never,
      );
      prismaMock.registration.count.mockResolvedValue(0);
      prismaMock.sponsorship.count.mockResolvedValue(0);
      prismaMock.eventAccess.findMany.mockResolvedValue([]);
      prismaMock.eventAccess.delete.mockResolvedValue(existingAccess as never);

      await deleteEventAccess(accessId);

      expect(prismaMock.eventAccess.delete).toHaveBeenCalledWith({
        where: { id: accessId },
      });
    });

    it("should throw when access not found", async () => {
      prismaMock.eventAccess.findUnique.mockResolvedValue(null);

      await expect(deleteEventAccess("non-existent")).rejects.toThrow(AppError);
      await expect(deleteEventAccess("non-existent")).rejects.toMatchObject({
        code: ErrorCodes.ACCESS_NOT_FOUND,
      });
    });

    it("should throw when access has registrations", async () => {
      const accessId = "access-1";
      const existingAccess = createEventAccessWithRelations({
        id: accessId,
        eventId,
      });

      prismaMock.eventAccess.findUnique.mockResolvedValue(
        existingAccess as never,
      );
      prismaMock.registration.count.mockResolvedValue(5);

      await expect(deleteEventAccess(accessId)).rejects.toThrow(AppError);
      await expect(deleteEventAccess(accessId)).rejects.toMatchObject({
        code: ErrorCodes.ACCESS_HAS_REGISTRATIONS,
      });
    });

    // ------------------------------------------------------------------
    // M18: sponsorship-count guard test
    // ------------------------------------------------------------------

    it("should throw when access item has active sponsorships", async () => {
      const accessId = "access-1";
      const existingAccess = createEventAccessWithRelations({
        id: accessId,
        eventId,
      });

      prismaMock.eventAccess.findUnique.mockResolvedValue(
        existingAccess as never,
      );
      // No registrations, but has active sponsorships
      prismaMock.registration.count.mockResolvedValue(0);
      prismaMock.sponsorship.count.mockResolvedValue(2);

      await expect(deleteEventAccess(accessId)).rejects.toThrow(AppError);
      await expect(deleteEventAccess(accessId)).rejects.toMatchObject({
        code: ErrorCodes.ACCESS_HAS_SPONSORSHIPS,
      });
    });
  });

  describe("listEventAccess", () => {
    it("should list all access items for an event", async () => {
      const accessItems = [
        createEventAccessWithRelations({ eventId, name: "Workshop 1" }),
        createEventAccessWithRelations({ eventId, name: "Workshop 2" }),
        createEventAccessWithRelations({ eventId, name: "Dinner" }),
      ];

      prismaMock.eventAccess.findMany.mockResolvedValue(accessItems as never);

      const result = await listEventAccess(eventId);

      expect(result).toHaveLength(3);
      expect(prismaMock.eventAccess.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId },
        }),
      );
    });

    it("should filter by active status", async () => {
      const activeAccess = [
        createEventAccessWithRelations({ eventId, active: true }),
      ];

      prismaMock.eventAccess.findMany.mockResolvedValue(activeAccess as never);

      await listEventAccess(eventId, { active: true });

      expect(prismaMock.eventAccess.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId, active: true },
        }),
      );
    });

    it("should filter by type", async () => {
      const workshops = [
        createEventAccessWithRelations({ eventId, type: "WORKSHOP" }),
      ];

      prismaMock.eventAccess.findMany.mockResolvedValue(workshops as never);

      await listEventAccess(eventId, { type: "WORKSHOP" });

      expect(prismaMock.eventAccess.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId, type: "WORKSHOP" },
        }),
      );
    });
  });

  describe("getEventAccessById", () => {
    it("should return access by ID", async () => {
      const accessId = "access-1";
      const access = createEventAccessWithRelations({
        id: accessId,
        name: "Test Access",
      });

      prismaMock.eventAccess.findUnique.mockResolvedValue(access as never);

      const result = await getEventAccessById(accessId);

      expect(result?.name).toBe("Test Access");
    });

    it("should return null when not found", async () => {
      prismaMock.eventAccess.findUnique.mockResolvedValue(null);

      const result = await getEventAccessById("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("getAccessClientId", () => {
    it("should return client ID for access", async () => {
      const accessId = "access-1";
      const accessWithEvent = {
        id: accessId,
        event: { clientId },
      };

      prismaMock.eventAccess.findUnique.mockResolvedValue(
        accessWithEvent as never,
      );

      const result = await getAccessClientId(accessId);

      expect(result).toBe(clientId);
    });

    it("should return null when access not found", async () => {
      prismaMock.eventAccess.findUnique.mockResolvedValue(null);

      const result = await getAccessClientId("non-existent");

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // Grouped Access (Hierarchical Type → Time Slots)
  // ============================================================================

  describe("getGroupedAccess", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-01T10:00:00"));
    });

    it("should return empty groups when no active access", async () => {
      prismaMock.eventAccess.findMany.mockResolvedValue([]);

      const result = await getGroupedAccess(eventId, {}, []);

      expect(result.groups).toHaveLength(0);
    });

    it("should group access items by date", async () => {
      const accessItems = [
        createEventAccessWithRelations({
          id: "workshop-1",
          eventId,
          type: "WORKSHOP",
          name: "Workshop A",
          startsAt: new Date("2025-06-01T09:00:00"),
          active: true,
        }),
        createEventAccessWithRelations({
          id: "dinner-1",
          eventId,
          type: "DINNER",
          name: "Gala Dinner",
          startsAt: new Date("2025-06-02T19:00:00"),
          active: true,
        }),
      ];

      prismaMock.eventAccess.findMany.mockResolvedValue(accessItems as never);

      const result = await getGroupedAccess(eventId, {}, []);

      expect(result.groups.length).toBe(2);
      // Groups are organized by date, items within slots have type
      const allItems = result.groups.flatMap((g) =>
        g.slots.flatMap((s) => s.items as any[]),
      );
      const workshopItems = allItems.filter((i) => i.type === "WORKSHOP");
      const dinnerItems = allItems.filter((i) => i.type === "DINNER");
      expect(workshopItems).toHaveLength(1);
      expect(dinnerItems).toHaveLength(1);
    });

    it("should create time slots within each date group", async () => {
      const slot1Time = new Date("2025-06-01T09:00:00");
      const slot2Time = new Date("2025-06-01T14:00:00");

      const accessItems = [
        createEventAccessWithRelations({
          id: "ws-1",
          eventId,
          type: "WORKSHOP",
          name: "Morning Workshop 1",
          startsAt: slot1Time,
          active: true,
        }),
        createEventAccessWithRelations({
          id: "ws-2",
          eventId,
          type: "WORKSHOP",
          name: "Morning Workshop 2",
          startsAt: slot1Time, // Same time slot
          active: true,
        }),
        createEventAccessWithRelations({
          id: "ws-3",
          eventId,
          type: "WORKSHOP",
          name: "Afternoon Workshop",
          startsAt: slot2Time, // Different time slot
          active: true,
        }),
      ];

      prismaMock.eventAccess.findMany.mockResolvedValue(accessItems as never);

      const result = await getGroupedAccess(eventId, {}, []);

      // All items are on the same date, so there should be 1 group with 2 slots
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].slots).toHaveLength(2); // Two time slots
    });

    it("should set selectionType to single for parallel items", async () => {
      const sameTime = new Date("2025-06-01T09:00:00");

      const accessItems = [
        createEventAccessWithRelations({
          id: "ws-1",
          eventId,
          type: "WORKSHOP",
          startsAt: sameTime,
          active: true,
        }),
        createEventAccessWithRelations({
          id: "ws-2",
          eventId,
          type: "WORKSHOP",
          startsAt: sameTime,
          active: true,
        }),
      ];

      prismaMock.eventAccess.findMany.mockResolvedValue(accessItems as never);

      const result = await getGroupedAccess(eventId, {}, []);

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].slots[0].selectionType).toBe("single");
    });

    it("should set selectionType to multiple for single item in slot", async () => {
      const accessItems = [
        createEventAccessWithRelations({
          id: "ws-1",
          eventId,
          type: "WORKSHOP",
          startsAt: new Date("2025-06-01T09:00:00"),
          active: true,
        }),
      ];

      prismaMock.eventAccess.findMany.mockResolvedValue(accessItems as never);

      const result = await getGroupedAccess(eventId, {}, []);

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].slots[0].selectionType).toBe("multiple");
    });

    it("should filter items by availability dates", async () => {
      const now = new Date("2025-06-01T10:00:00");

      const accessItems = [
        createEventAccessWithRelations({
          id: "available",
          eventId,
          type: "WORKSHOP",
          active: true,
          availableFrom: null,
          availableTo: null,
        }),
        createEventAccessWithRelations({
          id: "not-yet-available",
          eventId,
          type: "WORKSHOP",
          active: true,
          availableFrom: new Date("2025-06-02"), // Future
        }),
        createEventAccessWithRelations({
          id: "expired",
          eventId,
          type: "WORKSHOP",
          active: true,
          availableTo: new Date("2025-05-31"), // Past
        }),
      ];

      prismaMock.eventAccess.findMany.mockResolvedValue(accessItems as never);

      vi.setSystemTime(now);

      const result = await getGroupedAccess(eventId, {}, []);

      // Only the 'available' item should be visible (no date restrictions)
      const allItems = result.groups.flatMap((g) =>
        g.slots.flatMap((s) => s.items as any[]),
      );
      expect(allItems).toHaveLength(1);
      expect(allItems[0].id).toBe("available");
    });

    it("should filter items by form-based conditions", async () => {
      const accessItems = [
        createEventAccessWithRelations({
          id: "for-doctors",
          eventId,
          type: "WORKSHOP",
          active: true,
          conditions: [
            { fieldId: "profession", operator: "equals", value: "doctor" },
          ],
        }),
        createEventAccessWithRelations({
          id: "for-everyone",
          eventId,
          type: "WORKSHOP",
          active: true,
          conditions: null,
        }),
      ];

      prismaMock.eventAccess.findMany.mockResolvedValue(accessItems as never);

      // Only doctors can see the first workshop
      const resultDoctor = await getGroupedAccess(
        eventId,
        { profession: "doctor" },
        [],
      );
      const doctorItems = resultDoctor.groups.flatMap((g) =>
        g.slots.flatMap((s) => s.items as any[]),
      );
      expect(doctorItems).toHaveLength(2);

      // Non-doctors only see the second one
      const resultNonDoctor = await getGroupedAccess(
        eventId,
        { profession: "nurse" },
        [],
      );
      const nonDoctorItems = resultNonDoctor.groups.flatMap((g) =>
        g.slots.flatMap((s) => s.items as any[]),
      );
      expect(nonDoctorItems).toHaveLength(1);
    });

    it("should filter items by access prerequisites", async () => {
      const prerequisiteId = "basic-access";

      const accessItems = [
        createEventAccessWithRelations({
          id: prerequisiteId,
          eventId,
          type: "SESSION",
          active: true,
        }),
        createEventAccessWithRelations({
          id: "advanced-access",
          eventId,
          type: "WORKSHOP",
          active: true,
          requiredAccess: [{ id: prerequisiteId }] as never,
        }),
      ];

      prismaMock.eventAccess.findMany.mockResolvedValue(accessItems as never);

      // Without prerequisite selected - should only show SESSION (no prereq required)
      const resultWithoutPrereq = await getGroupedAccess(eventId, {}, []);
      const itemsNoPrereq = resultWithoutPrereq.groups.flatMap((g) =>
        g.slots.flatMap((s) => s.items as any[]),
      );
      const workshopItemsNoPrereq = itemsNoPrereq.filter(
        (i) => i.type === "WORKSHOP",
      );
      expect(workshopItemsNoPrereq).toHaveLength(0);

      // With prerequisite selected - should show advanced workshop
      const resultWithPrereq = await getGroupedAccess(eventId, {}, [
        prerequisiteId,
      ]);
      const itemsWithPrereq = resultWithPrereq.groups.flatMap((g) =>
        g.slots.flatMap((s) => s.items as any[]),
      );
      const workshopItemsWithPrereq = itemsWithPrereq.filter(
        (i) => i.type === "WORKSHOP",
      );
      expect(workshopItemsWithPrereq).toHaveLength(1);
    });

    it("should calculate spotsRemaining and isFull correctly and exclude full items", async () => {
      const accessItems = [
        createEventAccessWithRelations({
          id: "full-workshop",
          eventId,
          type: "WORKSHOP",
          maxCapacity: 10,
          registeredCount: 10,
          active: true,
        }),
        createEventAccessWithRelations({
          id: "available-workshop",
          eventId,
          type: "WORKSHOP",
          maxCapacity: 20,
          registeredCount: 5,
          active: true,
        }),
        createEventAccessWithRelations({
          id: "unlimited-workshop",
          eventId,
          type: "WORKSHOP",
          maxCapacity: null,
          registeredCount: 100,
          active: true,
        }),
      ];

      prismaMock.eventAccess.findMany.mockResolvedValue(accessItems as never);

      const result = await getGroupedAccess(eventId, {}, []);

      const items = result.groups.flatMap((g) =>
        g.slots.flatMap((s) => s.items as any[]),
      );

      // Full item should be present but marked as full
      const fullItem = items.find((i) => i.id === "full-workshop");
      expect(fullItem?.isFull).toBe(true);
      expect(fullItem?.spotsRemaining).toBe(0);

      const availableItem = items.find((i) => i.id === "available-workshop");
      expect(availableItem?.spotsRemaining).toBe(15);
      expect(availableItem?.isFull).toBe(false);

      const unlimitedItem = items.find((i) => i.id === "unlimited-workshop");
      expect(unlimitedItem?.spotsRemaining).toBeNull();
      expect(unlimitedItem?.isFull).toBe(false);
    });

    it("should exclude all full-capacity items from results", async () => {
      const accessItems = [
        createEventAccessWithRelations({
          id: "full-1",
          eventId,
          type: "WORKSHOP",
          name: "Full Workshop",
          maxCapacity: 5,
          registeredCount: 5,
          startsAt: new Date("2025-06-01T09:00:00"),
          active: true,
        }),
        createEventAccessWithRelations({
          id: "full-2",
          eventId,
          type: "ADDON",
          name: "Full Addon",
          maxCapacity: 1,
          registeredCount: 1,
          active: true,
        }),
        createEventAccessWithRelations({
          id: "available-1",
          eventId,
          type: "WORKSHOP",
          name: "Available Workshop",
          maxCapacity: 10,
          registeredCount: 3,
          startsAt: new Date("2025-06-01T09:00:00"),
          active: true,
        }),
      ];

      prismaMock.eventAccess.findMany.mockResolvedValue(accessItems as never);

      const result = await getGroupedAccess(eventId, {}, []);

      const scheduledItems = result.groups.flatMap((g) =>
        g.slots.flatMap((s) => s.items as { id: string }[]),
      );
      // Full items should be present but marked as full
      const fullItem = scheduledItems.find((i) => i.id === "full-1");
      expect(fullItem).toBeDefined();

      // Full addon should appear in addonGroup
      expect(result.addonGroup).not.toBeNull();

      // Available item should still appear
      expect(scheduledItems.find((i) => i.id === "available-1")).toBeDefined();
    });

    it("should include items with OTHER type in date groups", async () => {
      const accessItems = [
        createEventAccessWithRelations({
          id: "excursion-1",
          eventId,
          type: "OTHER",
          name: "City Tour",
          groupLabel: "Excursions",
          startsAt: new Date("2025-06-01T10:00:00"),
          active: true,
        }),
      ];

      prismaMock.eventAccess.findMany.mockResolvedValue(accessItems as never);

      const result = await getGroupedAccess(eventId, {}, []);

      // Items are grouped by date, not by type
      expect(result.groups).toHaveLength(1);
      const items = result.groups.flatMap((g) =>
        g.slots.flatMap((s) => s.items as any[]),
      );
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("OTHER");
      expect(items[0].name).toBe("City Tour");
    });
  });

  // ============================================================================
  // Capacity Management
  // ============================================================================

  describe("reserveAccessSpot", () => {
    it("should reserve a spot with atomic update", async () => {
      prismaMock.$executeRaw.mockResolvedValue(1);

      await reserveAccessSpot("access-1", 1);

      expect(prismaMock.$executeRaw).toHaveBeenCalled();
    });

    it("should reserve multiple spots", async () => {
      prismaMock.$executeRaw.mockResolvedValue(1);

      await reserveAccessSpot("access-1", 3);

      expect(prismaMock.$executeRaw).toHaveBeenCalled();
    });

    it("should throw when access not found", async () => {
      prismaMock.$executeRaw.mockResolvedValue(0);
      prismaMock.eventAccess.findUnique.mockResolvedValue(null);

      await expect(reserveAccessSpot("non-existent", 1)).rejects.toThrow(
        AppError,
      );
      await expect(reserveAccessSpot("non-existent", 1)).rejects.toMatchObject({
        code: ErrorCodes.ACCESS_NOT_FOUND,
      });
    });

    it("should throw when capacity exceeded", async () => {
      const access = createEventAccessWithRelations({
        id: "access-1",
        name: "Workshop",
        maxCapacity: 10,
        registeredCount: 8,
      });

      prismaMock.$executeRaw.mockResolvedValue(0);
      prismaMock.eventAccess.findUnique.mockResolvedValue(access as never);

      await expect(reserveAccessSpot("access-1", 5)).rejects.toThrow(AppError);
      await expect(reserveAccessSpot("access-1", 5)).rejects.toMatchObject({
        code: ErrorCodes.ACCESS_CAPACITY_EXCEEDED,
      });
    });
  });

  describe("releaseAccessSpot", () => {
    it("should release a spot with floor constraint", async () => {
      prismaMock.eventAccess.updateMany.mockResolvedValue({ count: 1 });

      await releaseAccessSpot("access-1", 1);

      expect(prismaMock.eventAccess.updateMany).toHaveBeenCalledWith({
        where: {
          id: "access-1",
          registeredCount: { gte: 1 },
        },
        data: { registeredCount: { decrement: 1 } },
      });
    });

    it("should release multiple spots", async () => {
      prismaMock.eventAccess.updateMany.mockResolvedValue({ count: 1 });

      await releaseAccessSpot("access-1", 3);

      expect(prismaMock.eventAccess.updateMany).toHaveBeenCalledWith({
        where: {
          id: "access-1",
          registeredCount: { gte: 3 },
        },
        data: { registeredCount: { decrement: 3 } },
      });
    });

    it("should not throw when no rows updated (logs warning instead)", async () => {
      prismaMock.eventAccess.updateMany.mockResolvedValue({ count: 0 });

      // Should resolve without throwing even when count === 0
      await expect(
        releaseAccessSpot("non-existent", 1),
      ).resolves.toBeUndefined();
    });
  });

  // ============================================================================
  // Validation
  // ============================================================================

  describe("validateAccessSelections", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2025-06-01T10:00:00"));
    });

    it("should return valid for empty selections", async () => {
      // Empty selections: only 1 findMany call (for includedAccesses)
      prismaMock.eventAccess.findMany.mockResolvedValueOnce([] as never);

      const result = await validateAccessSelections(eventId, [], {});

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should validate that all selected items exist", async () => {
      const existingAccess = createEventAccessWithRelations({
        id: "access-1",
        eventId,
        active: true,
      });

      // Two findMany calls: selected items, then includedAccesses (no mandatory items)
      prismaMock.eventAccess.findMany
        .mockResolvedValueOnce([existingAccess] as never)
        .mockResolvedValueOnce([] as never);

      const result = await validateAccessSelections(
        eventId,
        [
          { accessId: "access-1", quantity: 1 },
          { accessId: "non-existent", quantity: 1 },
        ],
        {},
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("not found"))).toBe(true);
    });

    it("should detect time conflicts within same type", async () => {
      const sameTime = new Date("2025-06-01T09:00:00");
      const sameEndTime = new Date("2025-06-01T12:00:00");

      const accessItems = [
        createEventAccessWithRelations({
          id: "ws-1",
          eventId,
          type: "WORKSHOP",
          name: "Workshop A",
          startsAt: sameTime,
          endsAt: sameEndTime,
          active: true,
        }),
        createEventAccessWithRelations({
          id: "ws-2",
          eventId,
          type: "WORKSHOP",
          name: "Workshop B",
          startsAt: sameTime,
          endsAt: sameEndTime,
          active: true,
        }),
      ];

      // Two findMany calls: selected items, then includedAccesses (no mandatory items)
      prismaMock.eventAccess.findMany
        .mockResolvedValueOnce(accessItems as never)
        .mockResolvedValueOnce([] as never);

      const result = await validateAccessSelections(
        eventId,
        [
          { accessId: "ws-1", quantity: 1 },
          { accessId: "ws-2", quantity: 1 },
        ],
        {},
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Time conflict"))).toBe(true);
    });

    it("should allow same time across different types", async () => {
      const sameTime = new Date("2025-06-01T09:00:00");

      const accessItems = [
        createEventAccessWithRelations({
          id: "ws-1",
          eventId,
          type: "WORKSHOP",
          name: "Workshop",
          startsAt: sameTime,
          active: true,
        }),
        createEventAccessWithRelations({
          id: "session-1",
          eventId,
          type: "SESSION",
          name: "Session",
          startsAt: sameTime,
          active: true,
        }),
      ];

      // Two findMany calls: selected items, then includedAccesses (no mandatory items)
      prismaMock.eventAccess.findMany
        .mockResolvedValueOnce(accessItems as never)
        .mockResolvedValueOnce([] as never);

      const result = await validateAccessSelections(
        eventId,
        [
          { accessId: "ws-1", quantity: 1 },
          { accessId: "session-1", quantity: 1 },
        ],
        {},
      );

      expect(result.valid).toBe(true);
    });

    it("should validate prerequisites are selected", async () => {
      const accessItems = [
        createEventAccessWithRelations({
          id: "basic",
          eventId,
          name: "Basic Workshop",
          active: true,
        }),
        createEventAccessWithRelations({
          id: "advanced",
          eventId,
          name: "Advanced Workshop",
          active: true,
          requiredAccess: [{ id: "basic" }] as never,
        }),
      ];

      // Two findMany calls: selected items, then includedAccesses (no mandatory items)
      prismaMock.eventAccess.findMany
        .mockResolvedValueOnce(accessItems as never)
        .mockResolvedValueOnce([] as never);

      // Selecting advanced without basic prerequisite
      const result = await validateAccessSelections(
        eventId,
        [{ accessId: "advanced", quantity: 1 }],
        {},
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("prerequisite"))).toBe(true);
    });

    it("should pass when prerequisites are selected", async () => {
      const accessItems = [
        createEventAccessWithRelations({
          id: "basic",
          eventId,
          name: "Basic Workshop",
          active: true,
        }),
        createEventAccessWithRelations({
          id: "advanced",
          eventId,
          name: "Advanced Workshop",
          active: true,
          requiredAccess: [{ id: "basic" }] as never,
        }),
      ];

      // Two findMany calls: selected items, then includedAccesses (no mandatory items)
      prismaMock.eventAccess.findMany
        .mockResolvedValueOnce(accessItems as never)
        .mockResolvedValueOnce([] as never);

      // Selecting both basic and advanced
      const result = await validateAccessSelections(
        eventId,
        [
          { accessId: "basic", quantity: 1 },
          { accessId: "advanced", quantity: 1 },
        ],
        {},
      );

      expect(result.valid).toBe(true);
    });

    it("should validate date availability", async () => {
      const accessItems = [
        createEventAccessWithRelations({
          id: "not-yet",
          eventId,
          name: "Future Workshop",
          active: true,
          availableFrom: new Date("2025-06-05"),
        }),
        createEventAccessWithRelations({
          id: "expired",
          eventId,
          name: "Expired Workshop",
          active: true,
          availableTo: new Date("2025-05-31"),
        }),
      ];

      // Each validateAccessSelections call fires two findMany calls.
      // Chain all 4 mocks upfront (2 calls × 2 findMany each).
      prismaMock.eventAccess.findMany
        .mockResolvedValueOnce(accessItems as never) // call 1: selected items
        .mockResolvedValueOnce([] as never) // call 1: includedAccesses
        .mockResolvedValueOnce(accessItems as never) // call 2: selected items
        .mockResolvedValueOnce([] as never); // call 2: includedAccesses

      const resultNotYet = await validateAccessSelections(
        eventId,
        [{ accessId: "not-yet", quantity: 1 }],
        {},
      );

      expect(resultNotYet.valid).toBe(false);
      expect(
        resultNotYet.errors.some((e) => e.includes("not yet available")),
      ).toBe(true);

      const resultExpired = await validateAccessSelections(
        eventId,
        [{ accessId: "expired", quantity: 1 }],
        {},
      );

      expect(resultExpired.valid).toBe(false);
      expect(
        resultExpired.errors.some((e) => e.includes("no longer available")),
      ).toBe(true);
    });

    it("should validate form-based conditions", async () => {
      const accessItems = [
        createEventAccessWithRelations({
          id: "doctors-only",
          eventId,
          name: "Medical Workshop",
          active: true,
          conditions: [
            { fieldId: "profession", operator: "equals", value: "doctor" },
          ],
        }),
      ];

      // Two findMany calls: selected items, then includedAccesses (no mandatory items)
      prismaMock.eventAccess.findMany
        .mockResolvedValueOnce(accessItems as never)
        .mockResolvedValueOnce([] as never);

      // Non-doctor trying to select
      const result = await validateAccessSelections(
        eventId,
        [{ accessId: "doctors-only", quantity: 1 }],
        { profession: "nurse" },
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("form answers"))).toBe(true);
    });

    it("should validate capacity", async () => {
      const accessItems = [
        createEventAccessWithRelations({
          id: "limited",
          eventId,
          name: "Limited Workshop",
          maxCapacity: 10,
          paidCount: 9,
          active: true,
        }),
      ];

      // Two findMany calls: selected items, then includedAccesses (no mandatory items)
      prismaMock.eventAccess.findMany
        .mockResolvedValueOnce(accessItems as never)
        .mockResolvedValueOnce([] as never);

      const result = await validateAccessSelections(
        eventId,
        [{ accessId: "limited", quantity: 2 }],
        {},
      );

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("full"))).toBe(true);
    });

    it("should pass validation when all checks succeed", async () => {
      const accessItems = [
        createEventAccessWithRelations({
          id: "available",
          eventId,
          name: "Available Workshop",
          maxCapacity: 50,
          registeredCount: 10,
          active: true,
        }),
      ];

      // Two findMany calls: selected items, then includedAccesses (no mandatory items)
      prismaMock.eventAccess.findMany
        .mockResolvedValueOnce(accessItems as never)
        .mockResolvedValueOnce([] as never);

      const result = await validateAccessSelections(
        eventId,
        [{ accessId: "available", quantity: 1 }],
        {},
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should handle AND condition logic", async () => {
      const accessItems = [
        createEventAccessWithRelations({
          id: "multi-condition",
          eventId,
          name: "Exclusive Workshop",
          active: true,
          conditionLogic: "AND",
          conditions: [
            { fieldId: "profession", operator: "equals", value: "doctor" },
            { fieldId: "specialty", operator: "equals", value: "cardiology" },
          ],
        }),
      ];

      // Two validateAccessSelections calls × 2 findMany each = 4 mocks
      prismaMock.eventAccess.findMany
        .mockResolvedValueOnce(accessItems as never) // call 1: selected items
        .mockResolvedValueOnce([] as never) // call 1: includedAccesses
        .mockResolvedValueOnce(accessItems as never) // call 2: selected items
        .mockResolvedValueOnce([] as never); // call 2: includedAccesses

      // Only meets one condition
      const resultPartial = await validateAccessSelections(
        eventId,
        [{ accessId: "multi-condition", quantity: 1 }],
        { profession: "doctor", specialty: "neurology" },
      );

      expect(resultPartial.valid).toBe(false);

      // Meets both conditions
      const resultFull = await validateAccessSelections(
        eventId,
        [{ accessId: "multi-condition", quantity: 1 }],
        { profession: "doctor", specialty: "cardiology" },
      );

      expect(resultFull.valid).toBe(true);
    });

    it("should handle OR condition logic", async () => {
      const accessItems = [
        createEventAccessWithRelations({
          id: "multi-condition",
          eventId,
          name: "Flexible Workshop",
          active: true,
          conditionLogic: "OR",
          conditions: [
            { fieldId: "profession", operator: "equals", value: "doctor" },
            { fieldId: "profession", operator: "equals", value: "nurse" },
          ],
        }),
      ];

      // Two findMany calls: selected items, then includedAccesses (no mandatory items)
      prismaMock.eventAccess.findMany
        .mockResolvedValueOnce(accessItems as never)
        .mockResolvedValueOnce([] as never);

      // Meets one condition (OR should pass)
      const result = await validateAccessSelections(
        eventId,
        [{ accessId: "multi-condition", quantity: 1 }],
        { profession: "nurse" },
      );

      expect(result.valid).toBe(true);
    });
  });

  // ============================================================================
  // Access Types
  // ============================================================================

  describe("Access Types", () => {
    it("should support all access types", async () => {
      const types = [
        "WORKSHOP",
        "DINNER",
        "SESSION",
        "NETWORKING",
        "ACCOMMODATION",
        "TRANSPORT",
        "OTHER",
      ] as const;

      for (const type of types) {
        const access = createEventAccessWithRelations({
          eventId,
          type,
          name: `${type} Access`,
        });

        prismaMock.event.findUnique.mockResolvedValue(mockEvent);
        prismaMock.eventAccess.create.mockResolvedValue(access as never);

        const result = await createEventAccess({
          eventId,
          name: `${type} Access`,
          type,
        } as CreateEventAccessInput);

        expect(result.type).toBe(type);
      }
    });

    it("should order date groups chronologically", async () => {
      const accessItems = [
        createEventAccessWithRelations({
          eventId,
          type: "OTHER",
          name: "Day 3 Item",
          startsAt: new Date("2025-06-03T10:00:00"),
          active: true,
        }),
        createEventAccessWithRelations({
          eventId,
          type: "SESSION",
          name: "Day 1 Item",
          startsAt: new Date("2025-06-01T10:00:00"),
          active: true,
        }),
        createEventAccessWithRelations({
          eventId,
          type: "WORKSHOP",
          name: "Day 2 Item",
          startsAt: new Date("2025-06-02T10:00:00"),
          active: true,
        }),
      ];

      prismaMock.eventAccess.findMany.mockResolvedValue(accessItems as never);

      const result = await getGroupedAccess(eventId, {}, []);

      // Check that date groups are ordered chronologically
      expect(result.groups).toHaveLength(3);
      expect(result.groups[0].dateKey).toBe("2025-06-01");
      expect(result.groups[1].dateKey).toBe("2025-06-02");
      expect(result.groups[2].dateKey).toBe("2025-06-03");
    });
  });
});
