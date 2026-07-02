import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpException } from "@nestjs/common";
import { ErrorCodes } from "@app/contracts";

// --- Mock the db query layer (the seam the service talks to) ----------------
vi.mock("@app/db", () => ({
  getDb: vi.fn(),
  casDecrementRegisteredTx: vi.fn(),
  casIncrementRegisteredTx: vi.fn(),
  clientExistsById: vi.fn(),
  countRegistrationsTx: vi.fn(),
  deleteEmailTemplatesByEventTx: vi.fn(),
  deleteEventTx: vi.fn(),
  eventExists: vi.fn(),
  getAbstractBookStorageKeysTx: vi.fn(),
  getAbstractFinalFileKeysTx: vi.fn(),
  getCertificateTemplateUrlsTx: vi.fn(),
  getEventCounterInfoTx: vi.fn(),
  getEventIdBySlugTx: vi.fn(),
  getEventWithPricing: vi.fn(),
  getEventWithPricingBySlug: vi.fn(),
  getEventWithPricingAndClient: vi.fn(),
  getEventWithRegistrationCountTx: vi.fn(),
  insertEventPricingTx: vi.fn(),
  insertEventTx: vi.fn(),
  listEvents: vi.fn(),
  updateEventBannerUrl: vi.fn(),
  updateEventTx: vi.fn(),
  upsertEventPricingTx: vi.fn(),
}));

const storageDeleteMock = vi.hoisted(() => vi.fn());
vi.mock("@app/integrations", () => ({
  getStorageProvider: () => ({ delete: storageDeleteMock, uploadPublic: vi.fn() }),
  compressImage: vi.fn(async () => ({ buffer: Buffer.from("webp"), contentType: "image/webp", ext: "webp" })),
}));

const fileTypeMock = vi.hoisted(() => vi.fn());
vi.mock("file-type", () => ({ fileTypeFromBuffer: fileTypeMock }));

import * as db from "@app/db";
import { fileTypeFromBuffer } from "file-type";
import {
  EventsService,
  assertEventOpen,
  assertEventAcceptsPublicActions,
  assertEventWritable,
} from "./events.service";

const service = new EventsService();
const clientId = "client-123";
const eventId = "event-123";

function createMockEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: eventId,
    clientId,
    name: "Event",
    slug: "event",
    description: null,
    maxCapacity: null,
    registeredCount: 0,
    startDate: new Date("2025-06-01"),
    endDate: new Date("2025-06-03"),
    location: null,
    status: "CLOSED",
    bannerUrl: null,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    ...overrides,
  };
}
function createMockEventPricing(overrides: Record<string, unknown> = {}) {
  return {
    id: "pricing-1",
    eventId,
    basePrice: 0,
    currency: "TND",
    rules: [],
    onlinePaymentEnabled: false,
    onlinePaymentUrl: null,
    cashPaymentEnabled: false,
    bankName: null,
    bankAccountName: null,
    bankAccountNumber: null,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    ...overrides,
  };
}
function createManyMockEvents(n: number) {
  return Array.from({ length: n }, (_, i) => createMockEvent({ id: `event-${i}` }));
}

// getDb().transaction(fn, cfg) runs fn immediately with a dummy tx (passthrough).
const transactionMock = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
function useTransaction() {
  vi.mocked(db.getDb).mockReturnValue({ transaction: transactionMock } as never);
}

/** Assert a rejected promise is an HttpException with the given status/code/message. */
async function expectAppError(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  await promise.then(
    () => expect.fail("expected the call to throw"),
    (err: unknown) => {
      expect(err).toBeInstanceOf(HttpException);
      const ex = err as HttpException;
      expect(ex.getStatus()).toBe(status);
      const body = ex.getResponse() as { code: string; message: string };
      expect(body.code).toBe(code);
      if (message !== undefined) expect(body.message).toBe(message);
    },
  );
}
function expectAppErrorSync(fn: () => unknown, status: number, code: string) {
  try {
    fn();
    expect.fail("expected the call to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const ex = err as HttpException;
    expect(ex.getStatus()).toBe(status);
    expect((ex.getResponse() as { code: string }).code).toBe(code);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  storageDeleteMock.mockReset();
  transactionMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({}));
  useTransaction();
});

describe("EventsService", () => {
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
      vi.mocked(db.clientExistsById).mockResolvedValue(true);
      vi.mocked(db.getEventIdBySlugTx).mockResolvedValue(null);
    });

    it("creates an event with pricing", async () => {
      vi.mocked(db.insertEventTx).mockResolvedValue(
        createMockEvent({ name: validInput.name, slug: validInput.slug }) as never,
      );
      vi.mocked(db.insertEventPricingTx).mockResolvedValue(
        createMockEventPricing({ basePrice: 500, currency: "TND" }) as never,
      );

      const result = await service.createEvent(validInput);

      expect(result).toMatchObject({
        id: eventId,
        name: validInput.name,
        slug: validInput.slug,
        pricing: expect.objectContaining({ basePrice: 500, currency: "TND" }),
      });
      expect(db.clientExistsById).toHaveBeenCalledWith(clientId);
      expect(db.insertEventTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: "CLOSED" }),
      );
    });

    it("normalizes currency before creating pricing", async () => {
      vi.mocked(db.insertEventTx).mockResolvedValue(createMockEvent() as never);
      vi.mocked(db.insertEventPricingTx).mockResolvedValue(createMockEventPricing() as never);

      await service.createEvent({ ...validInput, currency: "tnd" });

      expect(db.insertEventPricingTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ currency: "TND" }),
      );
    });

    it("404 when client does not exist", async () => {
      vi.mocked(db.clientExistsById).mockResolvedValue(false);
      await expectAppError(service.createEvent(validInput), 404, ErrorCodes.NOT_FOUND);
    });

    it("409 when slug already exists", async () => {
      vi.mocked(db.getEventIdBySlugTx).mockResolvedValue("other-event");
      await expectAppError(
        service.createEvent(validInput),
        409,
        ErrorCodes.CONFLICT,
        "Event with this slug already exists",
      );
    });

    it("defaults basePrice 0 / currency TND", async () => {
      vi.mocked(db.insertEventTx).mockResolvedValue(createMockEvent() as never);
      vi.mocked(db.insertEventPricingTx).mockResolvedValue(
        createMockEventPricing({ basePrice: 0, currency: "TND" }) as never,
      );

      const result = await service.createEvent({ ...validInput, basePrice: 0, currency: "TND" });

      expect(result.pricing?.basePrice).toBe(0);
      expect(result.pricing?.currency).toBe("TND");
      expect(db.insertEventPricingTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ basePrice: 0, currency: "TND" }),
      );
    });
  });

  describe("getEventById / getEventBySlug", () => {
    it("returns event+pricing when found", async () => {
      const event = { ...createMockEvent(), pricing: createMockEventPricing() };
      vi.mocked(db.getEventWithPricing).mockResolvedValue(event as never);
      const result = await service.getEventById(eventId);
      expect(result?.id).toBe(eventId);
      expect(db.getEventWithPricing).toHaveBeenCalledWith(eventId);
    });
    it("returns null when not found", async () => {
      vi.mocked(db.getEventWithPricing).mockResolvedValue(null);
      expect(await service.getEventById("nope")).toBeNull();
    });
    it("getEventBySlug returns event+pricing", async () => {
      const event = { ...createMockEvent(), pricing: createMockEventPricing() };
      vi.mocked(db.getEventWithPricingBySlug).mockResolvedValue(event as never);
      const result = await service.getEventBySlug("event");
      expect(result?.slug).toBe("event");
      expect(db.getEventWithPricingBySlug).toHaveBeenCalledWith("event");
    });
  });

  describe("assertEventOpen", () => {
    it("allows OPEN", () => {
      expect(() => assertEventOpen({ status: "OPEN" })).not.toThrow();
    });
    it.each(["CLOSED", "ARCHIVED"] as const)("rejects %s", (status) => {
      expectAppErrorSync(() => assertEventOpen({ status }), 400, ErrorCodes.EVENT_NOT_OPEN);
    });
  });

  describe("assertEventAcceptsPublicActions", () => {
    it("allows date-only end dates through the full final UTC day", () => {
      expect(() =>
        assertEventAcceptsPublicActions(
          { status: "OPEN", endDate: new Date("2026-05-28T00:00:00.000Z") },
          new Date("2026-05-28T18:00:00.000Z"),
        ),
      ).not.toThrow();
    });
    it("keeps explicit end times exact", () => {
      expectAppErrorSync(
        () =>
          assertEventAcceptsPublicActions(
            { status: "OPEN", endDate: new Date("2026-05-28T12:00:00.000Z") },
            new Date("2026-05-28T18:00:00.000Z"),
          ),
        400,
        ErrorCodes.EVENT_NOT_OPEN,
      );
    });
  });

  describe("assertEventWritable", () => {
    it.each(["OPEN", "CLOSED"] as const)("allows %s", (status) => {
      expect(() => assertEventWritable({ status })).not.toThrow();
    });
    it("rejects ARCHIVED", () => {
      expectAppErrorSync(
        () => assertEventWritable({ status: "ARCHIVED" }),
        400,
        ErrorCodes.INVALID_STATUS_TRANSITION,
      );
    });
  });

  describe("updateEvent", () => {
    it("updates event fields", async () => {
      const event = { ...createMockEvent({ name: "Old" }), pricing: createMockEventPricing() };
      const updated = { ...createMockEvent({ name: "New Name" }), pricing: createMockEventPricing() };
      vi.mocked(db.getEventWithPricing)
        .mockResolvedValueOnce(event as never)
        .mockResolvedValueOnce(updated as never);

      const result = await service.updateEvent(eventId, { name: "New Name" });

      expect(result.name).toBe("New Name");
      expect(db.updateEventTx).toHaveBeenCalledWith(expect.anything(), eventId, {
        name: "New Name",
      });
    });

    it("rejects maxCapacity below registeredCount", async () => {
      vi.mocked(db.getEventWithPricing).mockResolvedValue(
        { ...createMockEvent({ registeredCount: 10, maxCapacity: 20 }), pricing: null } as never,
      );
      await expectAppError(
        service.updateEvent(eventId, { maxCapacity: 9 }),
        400,
        ErrorCodes.VALIDATION_ERROR,
        "Max capacity cannot be below current registered count",
      );
      expect(db.updateEventTx).not.toHaveBeenCalled();
    });

    it("allows maxCapacity equal to registeredCount", async () => {
      const event = { ...createMockEvent({ registeredCount: 10, maxCapacity: 20 }), pricing: null };
      const updated = { ...createMockEvent({ maxCapacity: 10 }), pricing: null };
      vi.mocked(db.getEventWithPricing)
        .mockResolvedValueOnce(event as never)
        .mockResolvedValueOnce(updated as never);
      const result = await service.updateEvent(eventId, { maxCapacity: 10 });
      expect(result.maxCapacity).toBe(10);
    });

    it("allows null maxCapacity", async () => {
      const event = { ...createMockEvent({ registeredCount: 10, maxCapacity: 20 }), pricing: null };
      const updated = { ...createMockEvent({ maxCapacity: null }), pricing: null };
      vi.mocked(db.getEventWithPricing)
        .mockResolvedValueOnce(event as never)
        .mockResolvedValueOnce(updated as never);
      const result = await service.updateEvent(eventId, { maxCapacity: null });
      expect(result.maxCapacity).toBeNull();
    });

    it("checks registrations inside the txn when currency changes; serializable isolation", async () => {
      const event = { ...createMockEvent(), pricing: createMockEventPricing({ currency: "TND" }) };
      const updated = { ...createMockEvent(), pricing: createMockEventPricing({ currency: "EUR" }) };
      vi.mocked(db.getEventWithPricing)
        .mockResolvedValueOnce(event as never)
        .mockResolvedValueOnce(updated as never);
      vi.mocked(db.countRegistrationsTx).mockResolvedValue(0);

      const result = await service.updateEvent(eventId, { currency: "EUR" });

      expect(result.pricing?.currency).toBe("EUR");
      expect(db.countRegistrationsTx).toHaveBeenCalledWith(expect.anything(), eventId);
      expect(db.upsertEventPricingTx).toHaveBeenCalledWith(expect.anything(), eventId, {
        currency: "EUR",
      });
      expect(transactionMock).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ isolationLevel: "serializable" }),
      );
    });

    it("rejects currency change when registrations exist", async () => {
      vi.mocked(db.getEventWithPricing).mockResolvedValue(
        { ...createMockEvent(), pricing: createMockEventPricing({ currency: "TND" }) } as never,
      );
      vi.mocked(db.countRegistrationsTx).mockResolvedValue(1);
      await expectAppError(
        service.updateEvent(eventId, { currency: "EUR" }),
        400,
        ErrorCodes.VALIDATION_ERROR,
        "Cannot change currency after registrations exist",
      );
      expect(db.upsertEventPricingTx).not.toHaveBeenCalled();
    });

    it("does not count registrations when currency unchanged", async () => {
      const event = { ...createMockEvent(), pricing: createMockEventPricing({ currency: "TND" }) };
      vi.mocked(db.getEventWithPricing)
        .mockResolvedValueOnce(event as never)
        .mockResolvedValueOnce(event as never);
      await service.updateEvent(eventId, { currency: "TND" });
      expect(db.countRegistrationsTx).not.toHaveBeenCalled();
      expect(db.upsertEventPricingTx).toHaveBeenCalledWith(expect.anything(), eventId, {
        currency: "TND",
      });
    });

    it("normalizes currency before comparing (case-only difference)", async () => {
      const event = { ...createMockEvent(), pricing: createMockEventPricing({ currency: "TND" }) };
      vi.mocked(db.getEventWithPricing)
        .mockResolvedValueOnce(event as never)
        .mockResolvedValueOnce(event as never);
      await service.updateEvent(eventId, { currency: "tnd" });
      expect(db.countRegistrationsTx).not.toHaveBeenCalled();
      expect(db.upsertEventPricingTx).toHaveBeenCalledWith(expect.anything(), eventId, {
        currency: "TND",
      });
    });

    it("404 when event not found", async () => {
      vi.mocked(db.getEventWithPricing).mockResolvedValue(null);
      await expectAppError(
        service.updateEvent(eventId, { name: "New" }),
        404,
        ErrorCodes.NOT_FOUND,
        "Event not found",
      );
    });

    describe("status transitions", () => {
      const okTransition = async (from: string, to: string) => {
        vi.mocked(db.getEventWithPricing)
          .mockResolvedValueOnce({ ...createMockEvent({ status: from }), pricing: null } as never)
          .mockResolvedValueOnce({ ...createMockEvent({ status: to }), pricing: null } as never);
        const result = await service.updateEvent(eventId, { status: to as never });
        expect(result.status).toBe(to);
      };

      it("CLOSED -> OPEN", () => okTransition("CLOSED", "OPEN"));
      it("OPEN -> CLOSED", () => okTransition("OPEN", "CLOSED"));
      it("OPEN -> ARCHIVED", () => okTransition("OPEN", "ARCHIVED"));

      it("same status no-op (OPEN -> OPEN)", () => okTransition("OPEN", "OPEN"));

      it.each([
        ["CLOSED", "ARCHIVED"],
        ["ARCHIVED", "OPEN"],
        ["ARCHIVED", "CLOSED"],
      ])("rejects %s -> %s", async (from, to) => {
        vi.mocked(db.getEventWithPricing).mockResolvedValue(
          { ...createMockEvent({ status: from }), pricing: null } as never,
        );
        await expectAppError(
          service.updateEvent(eventId, { status: to as never }),
          400,
          ErrorCodes.INVALID_STATUS_TRANSITION,
          `Cannot transition event from ${from} to ${to}`,
        );
      });
    });

    describe("slug uniqueness", () => {
      it("allows a unique slug", async () => {
        vi.mocked(db.getEventWithPricing)
          .mockResolvedValueOnce({ ...createMockEvent({ slug: "old" }), pricing: null } as never)
          .mockResolvedValueOnce({ ...createMockEvent({ slug: "new-slug" }), pricing: null } as never);
        vi.mocked(db.getEventIdBySlugTx).mockResolvedValue(null);
        const result = await service.updateEvent(eventId, { slug: "new-slug" });
        expect(result.slug).toBe("new-slug");
        expect(db.getEventIdBySlugTx).toHaveBeenCalledTimes(1);
      });

      it("409 when slug is taken", async () => {
        vi.mocked(db.getEventWithPricing).mockResolvedValue(
          { ...createMockEvent({ slug: "old" }), pricing: null } as never,
        );
        vi.mocked(db.getEventIdBySlugTx).mockResolvedValue("other-event");
        await expectAppError(
          service.updateEvent(eventId, { slug: "taken" }),
          409,
          ErrorCodes.CONFLICT,
          "Event with this slug already exists",
        );
      });

      it("skips slug check when unchanged", async () => {
        vi.mocked(db.getEventWithPricing)
          .mockResolvedValueOnce({ ...createMockEvent({ slug: "same" }), pricing: null } as never)
          .mockResolvedValueOnce({ ...createMockEvent({ slug: "same" }), pricing: null } as never);
        const result = await service.updateEvent(eventId, { slug: "same" });
        expect(result.slug).toBe("same");
        expect(db.getEventIdBySlugTx).not.toHaveBeenCalled();
      });
    });

    describe("date validation", () => {
      const base = () =>
        createMockEvent({ startDate: new Date("2025-06-01"), endDate: new Date("2025-06-03") });

      it("rejects endDate before existing startDate", async () => {
        vi.mocked(db.getEventWithPricing).mockResolvedValue({ ...base(), pricing: null } as never);
        await expectAppError(
          service.updateEvent(eventId, { endDate: new Date("2025-05-01") }),
          400,
          ErrorCodes.VALIDATION_ERROR,
          "End date must be greater than or equal to start date",
        );
      });

      it("rejects startDate after existing endDate", async () => {
        vi.mocked(db.getEventWithPricing).mockResolvedValue({ ...base(), pricing: null } as never);
        await expectAppError(
          service.updateEvent(eventId, { startDate: new Date("2025-07-01") }),
          400,
          ErrorCodes.VALIDATION_ERROR,
        );
      });

      it("allows a valid one-sided date update", async () => {
        vi.mocked(db.getEventWithPricing)
          .mockResolvedValueOnce({ ...base(), pricing: null } as never)
          .mockResolvedValueOnce(
            { ...base(), endDate: new Date("2025-06-10"), pricing: null } as never,
          );
        const result = await service.updateEvent(eventId, { endDate: new Date("2025-06-10") });
        expect(result.endDate).toEqual(new Date("2025-06-10"));
      });
    });
  });

  describe("listEvents", () => {
    it("returns pagination meta", async () => {
      vi.mocked(db.listEvents).mockResolvedValue({
        data: createManyMockEvents(5) as never,
        total: 15,
      });
      const result = await service.listEvents({ page: 1, limit: 5 });
      expect(result.data).toHaveLength(5);
      expect(result.meta).toMatchObject({
        page: 1,
        limit: 5,
        total: 15,
        totalPages: 3,
        hasNext: true,
        hasPrev: false,
      });
    });

    it("passes clientId / status / search filters through", async () => {
      vi.mocked(db.listEvents).mockResolvedValue({ data: [], total: 0 });
      await service.listEvents({ page: 1, limit: 10, clientId, status: "OPEN", search: "conf" });
      expect(db.listEvents).toHaveBeenCalledWith(
        expect.objectContaining({ clientId, status: "OPEN", search: "conf" }),
      );
    });

    it("empty result set", async () => {
      vi.mocked(db.listEvents).mockResolvedValue({ data: [], total: 0 });
      const result = await service.listEvents({ page: 1, limit: 10 });
      expect(result.data).toHaveLength(0);
      expect(result.meta.total).toBe(0);
      expect(result.meta.hasNext).toBe(false);
    });

    it("forwards page/limit for skip", async () => {
      vi.mocked(db.listEvents).mockResolvedValue({ data: [], total: 0 });
      await service.listEvents({ page: 3, limit: 10 });
      expect(db.listEvents).toHaveBeenCalledWith(
        expect.objectContaining({ page: 3, limit: 10 }),
      );
    });
  });

  describe("deleteEvent", () => {
    beforeEach(() => {
      vi.mocked(db.getCertificateTemplateUrlsTx).mockResolvedValue([]);
      vi.mocked(db.getAbstractFinalFileKeysTx).mockResolvedValue([]);
      vi.mocked(db.getAbstractBookStorageKeysTx).mockResolvedValue([]);
    });

    it("deletes an event without registrations", async () => {
      vi.mocked(db.getEventWithRegistrationCountTx).mockResolvedValue({
        event: createMockEvent() as never,
        registrations: 0,
      });
      await service.deleteEvent(eventId);
      expect(db.deleteEmailTemplatesByEventTx).toHaveBeenCalledWith(expect.anything(), eventId);
      expect(db.deleteEventTx).toHaveBeenCalledWith(expect.anything(), eventId);
    });

    it("collects banner + certificate + abstract + book storage keys", async () => {
      vi.mocked(db.getEventWithRegistrationCountTx).mockResolvedValue({
        event: createMockEvent({ bannerUrl: "event/banner.webp" }) as never,
        registrations: 0,
      });
      vi.mocked(db.getCertificateTemplateUrlsTx).mockResolvedValue([
        { templateUrl: "certificates/template.png" },
      ]);
      vi.mocked(db.getAbstractFinalFileKeysTx).mockResolvedValue([
        { finalFileKey: "abstracts/final.pdf" },
      ]);
      vi.mocked(db.getAbstractBookStorageKeysTx).mockResolvedValue([
        { storageKey: "abstract-books/book.pdf" },
      ]);

      await service.deleteEvent(eventId);

      expect(storageDeleteMock).toHaveBeenCalledWith("event/banner.webp");
      expect(storageDeleteMock).toHaveBeenCalledWith("certificates/template.png");
      expect(storageDeleteMock).toHaveBeenCalledWith("abstracts/final.pdf");
      expect(storageDeleteMock).toHaveBeenCalledWith("abstract-books/book.pdf");
    });

    it("404 when event missing", async () => {
      vi.mocked(db.getEventWithRegistrationCountTx).mockResolvedValue(null);
      await expectAppError(service.deleteEvent(eventId), 404, ErrorCodes.NOT_FOUND, "Event not found");
    });

    it("409 with pluralized count for 5 registrations", async () => {
      vi.mocked(db.getEventWithRegistrationCountTx).mockResolvedValue({
        event: createMockEvent() as never,
        registrations: 5,
      });
      await expectAppError(
        service.deleteEvent(eventId),
        409,
        ErrorCodes.EVENT_HAS_REGISTRATIONS,
        "Cannot delete event with 5 registration(s). Archive the event instead.",
      );
    });

    it("409 message keeps literal registration(s) for 1", async () => {
      vi.mocked(db.getEventWithRegistrationCountTx).mockResolvedValue({
        event: createMockEvent() as never,
        registrations: 1,
      });
      await expectAppError(
        service.deleteEvent(eventId),
        409,
        ErrorCodes.EVENT_HAS_REGISTRATIONS,
        "Cannot delete event with 1 registration(s). Archive the event instead.",
      );
    });
  });

  describe("incrementRegisteredCountTx", () => {
    const exec = {} as never;
    it("succeeds silently when the CAS updates a row", async () => {
      vi.mocked(db.casIncrementRegisteredTx).mockResolvedValue(true);
      await service.incrementRegisteredCountTx(exec, eventId);
      expect(db.getEventCounterInfoTx).not.toHaveBeenCalled();
    });
    it("404 when event missing", async () => {
      vi.mocked(db.casIncrementRegisteredTx).mockResolvedValue(false);
      vi.mocked(db.getEventCounterInfoTx).mockResolvedValue(null);
      await expectAppError(service.incrementRegisteredCountTx(exec, eventId), 404, ErrorCodes.NOT_FOUND);
    });
    it("400 EVENT_NOT_OPEN for non-open events", async () => {
      vi.mocked(db.casIncrementRegisteredTx).mockResolvedValue(false);
      vi.mocked(db.getEventCounterInfoTx).mockResolvedValue({
        status: "CLOSED",
        maxCapacity: null,
        registeredCount: 0,
      });
      await expectAppError(service.incrementRegisteredCountTx(exec, eventId), 400, ErrorCodes.EVENT_NOT_OPEN);
    });
    it("409 EVENT_FULL for open capacity misses", async () => {
      vi.mocked(db.casIncrementRegisteredTx).mockResolvedValue(false);
      vi.mocked(db.getEventCounterInfoTx).mockResolvedValue({
        status: "OPEN",
        maxCapacity: 10,
        registeredCount: 10,
      });
      await expectAppError(service.incrementRegisteredCountTx(exec, eventId), 409, ErrorCodes.EVENT_FULL);
    });
  });

  describe("decrementRegisteredCountTx", () => {
    const exec = {} as never;
    it("succeeds silently when the CAS updates a row", async () => {
      vi.mocked(db.casDecrementRegisteredTx).mockResolvedValue(true);
      await service.decrementRegisteredCountTx(exec, eventId);
      expect(db.getEventCounterInfoTx).not.toHaveBeenCalled();
    });
    it("404 when event missing", async () => {
      vi.mocked(db.casDecrementRegisteredTx).mockResolvedValue(false);
      vi.mocked(db.getEventCounterInfoTx).mockResolvedValue(null);
      await expectAppError(service.decrementRegisteredCountTx(exec, eventId), 404, ErrorCodes.NOT_FOUND);
    });
    it("400 when registered count already zero", async () => {
      vi.mocked(db.casDecrementRegisteredTx).mockResolvedValue(false);
      vi.mocked(db.getEventCounterInfoTx).mockResolvedValue({
        status: "OPEN",
        maxCapacity: null,
        registeredCount: 0,
      });
      await expectAppError(
        service.decrementRegisteredCountTx(exec, eventId),
        400,
        ErrorCodes.VALIDATION_ERROR,
        "Event registered count is already zero",
      );
    });
  });

  describe("uploadEventBanner", () => {
    it("rejects archived events before inspecting or uploading the file", async () => {
      vi.mocked(db.getEventWithPricing).mockResolvedValue(
        { ...createMockEvent({ status: "ARCHIVED" }), pricing: null } as never,
      );
      await expectAppError(
        service.uploadEventBanner(eventId, {
          buffer: Buffer.from("not an image"),
          filename: "banner.png",
          mimetype: "image/png",
        }),
        400,
        ErrorCodes.INVALID_STATUS_TRANSITION,
      );
      expect(fileTypeFromBuffer).not.toHaveBeenCalled();
    });
  });

  describe("eventExists", () => {
    it("true when it exists", async () => {
      vi.mocked(db.eventExists).mockResolvedValue(true);
      expect(await service.eventExists(eventId)).toBe(true);
      expect(db.eventExists).toHaveBeenCalledWith(eventId);
    });
    it("false when it does not", async () => {
      vi.mocked(db.eventExists).mockResolvedValue(false);
      expect(await service.eventExists("nope")).toBe(false);
    });
  });
});
