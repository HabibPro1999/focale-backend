import { describe, it, expect, beforeEach, vi } from "vitest";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import {
  createMockEvent,
  createMockEventPricing,
  createManyMockEvents,
} from "../../../tests/helpers/factories.js";
import {
  createEvent,
  getEventById,
  getEventBySlug,
  updateEvent,
  listEvents,
  deleteEvent,
  eventExists,
  incrementRegisteredCount,
  decrementRegisteredCount,
} from "./events.service.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

// Mock the clients module for clientExists
vi.mock("@clients", () => ({
  clientExists: vi.fn(),
}));

import { clientExists as clientExistsMock } from "@clients";

describe("Events Service", () => {
  const clientId = "client-123";
  const eventId = "event-123";

  describe("createEvent", () => {
    const validInput = {
      clientId,
      name: "Medical Conference 2025",
      slug: "medical-conference-2025",
      description: "Annual medical conference",
      maxCapacity: 200,
      startDate: new Date("2025-06-01"),
      endDate: new Date("2025-06-03"),
      location: "Tunis, Tunisia",
      status: "CLOSED" as const,
      basePrice: 500,
      currency: "TND",
    };

    beforeEach(() => {
      vi.mocked(clientExistsMock).mockResolvedValue(true);
    });

    it("should create an event with pricing successfully", async () => {
      const mockEvent = createMockEvent({
        id: eventId,
        clientId,
        name: validInput.name,
        slug: validInput.slug,
        description: validInput.description,
        maxCapacity: validInput.maxCapacity,
        startDate: validInput.startDate,
        endDate: validInput.endDate,
        location: validInput.location,
        status: "CLOSED",
      });
      const mockPricing = createMockEventPricing({
        eventId,
        basePrice: validInput.basePrice,
        currency: validInput.currency,
      });

      prismaMock.$transaction.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (callback: (tx: any) => Promise<any>) => {
          const txMock = {
            event: {
              findUnique: vi.fn().mockResolvedValue(null), // No existing slug
              create: vi.fn().mockResolvedValue(mockEvent),
            },
            eventPricing: {
              create: vi.fn().mockResolvedValue(mockPricing),
            },
          };
          return callback(txMock);
        },
      );

      const result = await createEvent(validInput);

      expect(result).toMatchObject({
        id: eventId,
        name: validInput.name,
        slug: validInput.slug,
        pricing: expect.objectContaining({
          basePrice: validInput.basePrice,
          currency: validInput.currency,
        }),
      });
      expect(clientExistsMock).toHaveBeenCalledWith(clientId);
    });

    it("should throw when client does not exist", async () => {
      vi.mocked(clientExistsMock).mockResolvedValue(false);

      await expect(createEvent(validInput)).rejects.toThrow(AppError);
      await expect(createEvent(validInput)).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it("should throw when slug already exists", async () => {
      const existingEvent = createMockEvent({ slug: validInput.slug });

      prismaMock.$transaction.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (callback: (tx: any) => Promise<any>) => {
          const txMock = {
            event: {
              findUnique: vi.fn().mockResolvedValue(existingEvent),
              create: vi.fn(),
            },
            eventPricing: {
              create: vi.fn(),
            },
          };
          return callback(txMock);
        },
      );

      await expect(createEvent(validInput)).rejects.toThrow(AppError);
      await expect(createEvent(validInput)).rejects.toMatchObject({
        statusCode: 409,
        code: ErrorCodes.CONFLICT,
        message: "Event with this slug already exists",
      });
    });

    it("should use default status CLOSED when not provided", async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { status: _omit, ...inputWithoutStatus } = validInput;

      const mockEvent = createMockEvent({
        id: eventId,
        clientId,
        status: "CLOSED",
      });
      const mockPricing = createMockEventPricing({ eventId });

      prismaMock.$transaction.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (callback: (tx: any) => Promise<any>) => {
          const txMock = {
            event: {
              findUnique: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockResolvedValue(mockEvent),
            },
            eventPricing: {
              create: vi.fn().mockResolvedValue(mockPricing),
            },
          };
          return callback(txMock);
        },
      );

      const result = await createEvent({
        ...inputWithoutStatus,
        status: "CLOSED",
        basePrice: 0,
        currency: "TND",
      });

      expect(result.status).toBe("CLOSED");
    });

    it("should use default basePrice 0 and currency TND when not provided", async () => {
      const {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        basePrice: _basePrice,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        currency: _currency,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        status: _status,
        ...inputWithoutPricing
      } = validInput;

      const mockEvent = createMockEvent({ id: eventId, clientId });
      const mockPricing = createMockEventPricing({
        eventId,
        basePrice: 0,
        currency: "TND",
      });

      prismaMock.$transaction.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (callback: (tx: any) => Promise<any>) => {
          const txMock = {
            event: {
              findUnique: vi.fn().mockResolvedValue(null),
              create: vi.fn().mockResolvedValue(mockEvent),
            },
            eventPricing: {
              create: vi.fn().mockResolvedValue(mockPricing),
            },
          };
          return callback(txMock);
        },
      );

      const result = await createEvent({
        ...inputWithoutPricing,
        status: "CLOSED",
        basePrice: 0,
        currency: "TND",
      });

      expect(result.pricing?.basePrice).toBe(0);
      expect(result.pricing?.currency).toBe("TND");
    });
  });

  describe("getEventById", () => {
    it("should return event with pricing when found", async () => {
      const mockEvent = createMockEvent({ id: eventId });
      const mockPricing = createMockEventPricing({ eventId });
      const eventWithPricing = { ...mockEvent, pricing: mockPricing };

      prismaMock.event.findUnique.mockResolvedValue(eventWithPricing);

      const result = await getEventById(eventId);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(eventId);
      expect(result?.pricing).toBeDefined();
      expect(prismaMock.event.findUnique).toHaveBeenCalledWith({
        where: { id: eventId },
        include: { pricing: true },
      });
    });

    it("should return null when event not found", async () => {
      prismaMock.event.findUnique.mockResolvedValue(null);

      const result = await getEventById("non-existent");

      expect(result).toBeNull();
    });
  });

  describe("getEventBySlug", () => {
    it("should return event with pricing when found", async () => {
      const slug = "my-event-slug";
      const mockEvent = createMockEvent({ slug });
      const mockPricing = createMockEventPricing({ eventId: mockEvent.id });
      const eventWithPricing = { ...mockEvent, pricing: mockPricing };

      prismaMock.event.findUnique.mockResolvedValue(eventWithPricing);

      const result = await getEventBySlug(slug);

      expect(result).not.toBeNull();
      expect(result?.slug).toBe(slug);
      expect(result?.pricing).toBeDefined();
      expect(prismaMock.event.findUnique).toHaveBeenCalledWith({
        where: { slug },
        include: { pricing: true },
      });
    });

    it("should return null when slug not found", async () => {
      prismaMock.event.findUnique.mockResolvedValue(null);

      const result = await getEventBySlug("non-existent-slug");

      expect(result).toBeNull();
    });
  });

  describe("updateEvent", () => {
    it("should update event fields successfully", async () => {
      const mockEvent = createMockEvent({
        id: eventId,
        name: "Old Name",
        status: "CLOSED",
      });
      const updatedEvent = createMockEvent({
        id: eventId,
        name: "New Name",
        status: "CLOSED",
      });

      prismaMock.event.findUnique.mockResolvedValue(mockEvent);

      prismaMock.$transaction.mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (callback: (tx: any) => Promise<any>) => {
          const txMock = {
            event: {
              update: vi.fn().mockResolvedValue(updatedEvent),
            },
          };
          return callback(txMock);
        },
      );

      const result = await updateEvent(eventId, { name: "New Name" });

      expect(result.name).toBe("New Name");
    });

    it("should throw when event not found", async () => {
      prismaMock.event.findUnique.mockResolvedValue(null);

      await expect(updateEvent(eventId, { name: "New Name" })).rejects.toThrow(
        AppError,
      );
      await expect(
        updateEvent(eventId, { name: "New Name" }),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
        message: "Event not found",
      });
    });

    describe("status transitions", () => {
      it("should allow CLOSED -> OPEN transition", async () => {
        const mockEvent = createMockEvent({ id: eventId, status: "CLOSED" });
        const updatedEvent = createMockEvent({ id: eventId, status: "OPEN" });

        prismaMock.event.findUnique.mockResolvedValue(mockEvent);

        prismaMock.$transaction.mockImplementation(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async (callback: (tx: any) => Promise<any>) => {
            const txMock = {
              event: {
                update: vi.fn().mockResolvedValue(updatedEvent),
              },
            };
            return callback(txMock);
          },
        );

        const result = await updateEvent(eventId, { status: "OPEN" });

        expect(result.status).toBe("OPEN");
      });

      it("should allow OPEN -> CLOSED transition", async () => {
        const mockEvent = createMockEvent({ id: eventId, status: "OPEN" });
        const updatedEvent = createMockEvent({ id: eventId, status: "CLOSED" });

        prismaMock.event.findUnique.mockResolvedValue(mockEvent);

        prismaMock.$transaction.mockImplementation(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async (callback: (tx: any) => Promise<any>) => {
            const txMock = {
              event: {
                update: vi.fn().mockResolvedValue(updatedEvent),
              },
            };
            return callback(txMock);
          },
        );

        const result = await updateEvent(eventId, { status: "CLOSED" });

        expect(result.status).toBe("CLOSED");
      });

      it("should allow OPEN -> ARCHIVED transition", async () => {
        const mockEvent = createMockEvent({ id: eventId, status: "OPEN" });
        const updatedEvent = createMockEvent({
          id: eventId,
          status: "ARCHIVED",
        });

        prismaMock.event.findUnique.mockResolvedValue(mockEvent);

        prismaMock.$transaction.mockImplementation(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async (callback: (tx: any) => Promise<any>) => {
            const txMock = {
              event: {
                update: vi.fn().mockResolvedValue(updatedEvent),
              },
            };
            return callback(txMock);
          },
        );

        const result = await updateEvent(eventId, { status: "ARCHIVED" });

        expect(result.status).toBe("ARCHIVED");
      });

      it("should reject CLOSED -> ARCHIVED transition", async () => {
        const mockEvent = createMockEvent({ id: eventId, status: "CLOSED" });
        prismaMock.event.findUnique.mockResolvedValue(mockEvent);

        await expect(
          updateEvent(eventId, { status: "ARCHIVED" }),
        ).rejects.toThrow(AppError);
        await expect(
          updateEvent(eventId, { status: "ARCHIVED" }),
        ).rejects.toMatchObject({
          statusCode: 400,
          code: ErrorCodes.INVALID_STATUS_TRANSITION,
          message: "Cannot transition event from CLOSED to ARCHIVED",
        });
      });

      it("should reject ARCHIVED -> OPEN transition (terminal state)", async () => {
        const mockEvent = createMockEvent({ id: eventId, status: "ARCHIVED" });
        prismaMock.event.findUnique.mockResolvedValue(mockEvent);

        await expect(updateEvent(eventId, { status: "OPEN" })).rejects.toThrow(
          AppError,
        );
        await expect(
          updateEvent(eventId, { status: "OPEN" }),
        ).rejects.toMatchObject({
          statusCode: 400,
          code: ErrorCodes.INVALID_STATUS_TRANSITION,
          message: "Cannot transition event from ARCHIVED to OPEN",
        });
      });

      it("should reject ARCHIVED -> CLOSED transition (terminal state)", async () => {
        const mockEvent = createMockEvent({ id: eventId, status: "ARCHIVED" });
        prismaMock.event.findUnique.mockResolvedValue(mockEvent);

        await expect(
          updateEvent(eventId, { status: "CLOSED" }),
        ).rejects.toThrow(AppError);
        await expect(
          updateEvent(eventId, { status: "CLOSED" }),
        ).rejects.toMatchObject({
          statusCode: 400,
          code: ErrorCodes.INVALID_STATUS_TRANSITION,
          message: "Cannot transition event from ARCHIVED to CLOSED",
        });
      });

      it("should allow updating same status (no-op)", async () => {
        const mockEvent = createMockEvent({ id: eventId, status: "OPEN" });

        prismaMock.event.findUnique.mockResolvedValue(mockEvent);

        prismaMock.$transaction.mockImplementation(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async (callback: (tx: any) => Promise<any>) => {
            const txMock = {
              event: {
                update: vi.fn().mockResolvedValue(mockEvent),
              },
            };
            return callback(txMock);
          },
        );

        const result = await updateEvent(eventId, { status: "OPEN" });

        expect(result.status).toBe("OPEN");
      });
    });

    describe("slug uniqueness", () => {
      it("should allow updating slug to a unique value", async () => {
        const mockEvent = createMockEvent({ id: eventId, slug: "old-slug" });
        const updatedEvent = createMockEvent({
          id: eventId,
          slug: "new-unique-slug",
        });

        prismaMock.event.findUnique.mockResolvedValueOnce(mockEvent); // Find event by id (outside tx)

        prismaMock.$transaction.mockImplementation(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async (callback: (tx: any) => Promise<any>) => {
            const txMock = {
              event: {
                findUnique: vi.fn().mockResolvedValue(null), // Slug check returns null (unique)
                update: vi.fn().mockResolvedValue(updatedEvent),
              },
            };
            return callback(txMock);
          },
        );

        const result = await updateEvent(eventId, { slug: "new-unique-slug" });

        expect(result.slug).toBe("new-unique-slug");
      });

      it("should throw when updating slug to existing value", async () => {
        const mockEvent = createMockEvent({ id: eventId, slug: "old-slug" });
        const conflictingEvent = createMockEvent({
          id: "other-event",
          slug: "taken-slug",
        });

        prismaMock.event.findUnique.mockResolvedValueOnce(mockEvent); // Find event by id (outside tx)

        prismaMock.$transaction.mockImplementation(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async (callback: (tx: any) => Promise<any>) => {
            const txMock = {
              event: {
                findUnique: vi.fn().mockResolvedValue(conflictingEvent), // Slug check returns conflicting event
                update: vi.fn(),
              },
            };
            return callback(txMock);
          },
        );

        await expect(
          updateEvent(eventId, { slug: "taken-slug" }),
        ).rejects.toMatchObject({
          statusCode: 409,
          code: ErrorCodes.CONFLICT,
          message: "Event with this slug already exists",
        });
      });

      it("should skip slug check when updating to same slug", async () => {
        const mockEvent = createMockEvent({ id: eventId, slug: "same-slug" });

        prismaMock.event.findUnique.mockResolvedValueOnce(mockEvent);

        prismaMock.$transaction.mockImplementation(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async (callback: (tx: any) => Promise<any>) => {
            const txMock = {
              event: {
                // No findUnique here - slug check is skipped when slug === event.slug
                update: vi.fn().mockResolvedValue(mockEvent),
              },
            };
            return callback(txMock);
          },
        );

        const result = await updateEvent(eventId, { slug: "same-slug" });

        expect(result.slug).toBe("same-slug");
        // Only one findUnique call (for finding the event outside transaction)
        expect(prismaMock.event.findUnique).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("listEvents", () => {
    it("should return paginated events", async () => {
      const mockEvents = createManyMockEvents(5);

      prismaMock.event.findMany.mockResolvedValue(mockEvents);
      prismaMock.event.count.mockResolvedValue(15);

      const result = await listEvents({ page: 1, limit: 5 });

      expect(result.data).toHaveLength(5);
      expect(result.meta.total).toBe(15);
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(5);
      expect(result.meta.totalPages).toBe(3);
      expect(result.meta.hasNext).toBe(true);
      expect(result.meta.hasPrev).toBe(false);
    });

    it("should filter by clientId", async () => {
      const mockEvents = createManyMockEvents(2).map((e) => ({
        ...e,
        clientId,
      }));

      prismaMock.event.findMany.mockResolvedValue(mockEvents);
      prismaMock.event.count.mockResolvedValue(2);

      await listEvents({ page: 1, limit: 10, clientId });

      expect(prismaMock.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ clientId }),
        }),
      );
    });

    it("should filter by status", async () => {
      const mockEvents = createManyMockEvents(2).map((e) => ({
        ...e,
        status: "OPEN" as const,
      }));

      prismaMock.event.findMany.mockResolvedValue(mockEvents);
      prismaMock.event.count.mockResolvedValue(2);

      await listEvents({ page: 1, limit: 10, status: "OPEN" });

      expect(prismaMock.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "OPEN" }),
        }),
      );
    });

    it("should filter by search term across multiple fields", async () => {
      const mockEvents = createManyMockEvents(1);

      prismaMock.event.findMany.mockResolvedValue(mockEvents);
      prismaMock.event.count.mockResolvedValue(1);

      await listEvents({ page: 1, limit: 10, search: "conference" });

      expect(prismaMock.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { name: { contains: "conference", mode: "insensitive" } },
              { slug: { contains: "conference", mode: "insensitive" } },
              { description: { contains: "conference", mode: "insensitive" } },
              { location: { contains: "conference", mode: "insensitive" } },
            ],
          }),
        }),
      );
    });

    it("should return empty list when no events match", async () => {
      prismaMock.event.findMany.mockResolvedValue([]);
      prismaMock.event.count.mockResolvedValue(0);

      const result = await listEvents({ page: 1, limit: 10 });

      expect(result.data).toHaveLength(0);
      expect(result.meta.total).toBe(0);
      expect(result.meta.hasNext).toBe(false);
    });

    it("should apply correct pagination skip", async () => {
      prismaMock.event.findMany.mockResolvedValue([]);
      prismaMock.event.count.mockResolvedValue(0);

      await listEvents({ page: 3, limit: 10 });

      expect(prismaMock.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20, // (page - 1) * limit = (3 - 1) * 10
          take: 10,
        }),
      );
    });
  });

  describe("deleteEvent", () => {
    it("should delete event without registrations", async () => {
      const mockEvent = {
        ...createMockEvent({ id: eventId }),
        _count: { registrations: 0 },
      };

      prismaMock.event.findUnique.mockResolvedValue(mockEvent);
      prismaMock.event.delete.mockResolvedValue(mockEvent);

      await deleteEvent(eventId);

      expect(prismaMock.event.delete).toHaveBeenCalledWith({
        where: { id: eventId },
      });
    });

    it("should throw when event not found", async () => {
      prismaMock.event.findUnique.mockResolvedValue(null);

      await expect(deleteEvent(eventId)).rejects.toThrow(AppError);
      await expect(deleteEvent(eventId)).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
        message: "Event not found",
      });
    });

    it("should throw when event has registrations", async () => {
      const mockEvent = {
        ...createMockEvent({ id: eventId }),
        _count: { registrations: 5 },
      };

      prismaMock.event.findUnique.mockResolvedValue(mockEvent);

      await expect(deleteEvent(eventId)).rejects.toThrow(AppError);
      await expect(deleteEvent(eventId)).rejects.toMatchObject({
        statusCode: 409,
        code: ErrorCodes.EVENT_HAS_REGISTRATIONS,
        message:
          "Cannot delete event with 5 registration(s). Archive the event instead.",
      });
    });

    it("should throw with correct count in message", async () => {
      const mockEvent = {
        ...createMockEvent({ id: eventId }),
        _count: { registrations: 1 },
      };

      prismaMock.event.findUnique.mockResolvedValue(mockEvent);

      await expect(deleteEvent(eventId)).rejects.toMatchObject({
        message:
          "Cannot delete event with 1 registration(s). Archive the event instead.",
      });
    });
  });

  describe("eventExists", () => {
    it("should return true when event exists", async () => {
      prismaMock.event.count.mockResolvedValue(1);

      const result = await eventExists(eventId);

      expect(result).toBe(true);
      expect(prismaMock.event.count).toHaveBeenCalledWith({
        where: { id: eventId },
      });
    });

    it("should return false when event does not exist", async () => {
      prismaMock.event.count.mockResolvedValue(0);

      const result = await eventExists("non-existent");

      expect(result).toBe(false);
    });
  });

  describe("incrementRegisteredCount", () => {
    it("should increment registered count by 1", async () => {
      const updatedEvent = createMockEvent({
        id: eventId,
        registeredCount: 11,
      });

      prismaMock.event.update.mockResolvedValue(updatedEvent);

      const result = await incrementRegisteredCount(eventId);

      expect(result.registeredCount).toBe(11);
      expect(prismaMock.event.update).toHaveBeenCalledWith({
        where: { id: eventId },
        data: { registeredCount: { increment: 1 } },
      });
    });

    it("should work from zero", async () => {
      const updatedEvent = createMockEvent({ id: eventId, registeredCount: 1 });

      prismaMock.event.update.mockResolvedValue(updatedEvent);

      const result = await incrementRegisteredCount(eventId);

      expect(result.registeredCount).toBe(1);
    });
  });

  describe("decrementRegisteredCount", () => {
    it("should decrement registered count by 1", async () => {
      const updatedEvent = createMockEvent({ id: eventId, registeredCount: 9 });

      prismaMock.event.update.mockResolvedValue(updatedEvent);

      const result = await decrementRegisteredCount(eventId);

      expect(result.registeredCount).toBe(9);
      expect(prismaMock.event.update).toHaveBeenCalledWith({
        where: { id: eventId },
        data: { registeredCount: { decrement: 1 } },
      });
    });

    it("should work from one", async () => {
      const updatedEvent = createMockEvent({ id: eventId, registeredCount: 0 });

      prismaMock.event.update.mockResolvedValue(updatedEvent);

      const result = await decrementRegisteredCount(eventId);

      expect(result.registeredCount).toBe(0);
    });
  });
});
