import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "@app/contracts";

// Mock the db query layer (the seam the service talks to). withTxn is a
// passthrough invoking the callback with a dummy tx (all query fns are mocked).
vi.mock("@app/db", () => ({
  getDb: vi.fn(() => ({})),
  withTxn: vi.fn(),
  getEventDatesForAccess: vi.fn(),
  getEventAccessById: vi.fn(),
  getEventAccessForUpdate: vi.fn(),
  getEventAccessWithPrereqs: vi.fn(),
  listEventAccessRows: vi.fn(),
  getAccessClientId: vi.fn(),
  findExistingAccessIdsInEvent: vi.fn(),
  getEventPrereqEdges: vi.fn(),
  getActiveAccessForGrouping: vi.fn(),
  getAccessByIdsForValidation: vi.fn(),
  getIncludedInBaseAccess: vi.fn(),
  insertEventAccess: vi.fn(),
  updateEventAccessRow: vi.fn(),
  setAccessPrerequisites: vi.fn(),
  countRegistrationsWithAccess: vi.fn(),
  countActiveSponsorshipsWithAccess: vi.fn(),
  getAccessDependentIds: vi.fn(),
  removePrerequisiteEdge: vi.fn(),
  deleteEventAccessById: vi.fn(),
  casIncrementAccessRegisteredCount: vi.fn(),
  casDecrementAccessRegisteredCount: vi.fn(),
  casIncrementAccessPaidCount: vi.fn(),
  casDecrementAccessPaidCount: vi.fn(),
  getAccessCapacityInfo: vi.fn(),
  getAccessRegisteredCount: vi.fn(),
  getAccessPaidCount: vi.fn(),
  getAccessCapacityRowsByIds: vi.fn(),
  getUnsettledRegistrationsWithAccess: vi.fn(),
  getRegistrationCoveredAccessIds: vi.fn(),
  updateRegistrationForAccessDrop: vi.fn(),
  insertAccessAuditLog: vi.fn(),
  enqueueTriggeredEmailOutbox: vi.fn(),
}));

import * as db from "@app/db";
import { AccessService } from "./access.service";
import type { CreateEventAccessInput } from "@app/contracts";

const m = db as unknown as Record<string, ReturnType<typeof vi.fn>>;
const service = new AccessService();

const eventId = "event-123";
const startDate = new Date("2025-06-01T00:00:00Z");
const endDate = new Date("2025-06-03T00:00:00Z");
const eventDates = { id: eventId, startDate, endDate };

function accessRow(o: Record<string, unknown> = {}) {
  return {
    id: "access-1",
    eventId,
    type: "OTHER",
    name: "Access",
    description: null,
    location: null,
    startsAt: null,
    endsAt: null,
    price: 0,
    currency: "TND",
    maxCapacity: null,
    registeredCount: 0,
    paidCount: 0,
    availableFrom: null,
    availableTo: null,
    conditions: null,
    conditionLogic: "AND",
    sortOrder: 0,
    active: true,
    groupLabel: null,
    allowCompanion: false,
    includedInBase: false,
    companionPrice: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    requiredAccess: [],
    ...o,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  m.getDb.mockReturnValue({});
  m.withTxn.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
});

// ===========================================================================
// createEventAccess
// ===========================================================================
describe("createEventAccess", () => {
  it("creates an access item", async () => {
    m.getEventDatesForAccess.mockResolvedValue(eventDates);
    m.insertEventAccess.mockResolvedValue(
      accessRow({ name: "Morning Workshop", type: "WORKSHOP", price: 50 }),
    );

    const result = await service.createEventAccess({
      eventId,
      name: "Morning Workshop",
      type: "WORKSHOP",
      price: 50,
      startsAt: new Date("2025-06-01T09:00:00Z"),
      endsAt: new Date("2025-06-01T12:00:00Z"),
    } as CreateEventAccessInput);

    expect(result.name).toBe("Morning Workshop");
    expect(m.insertEventAccess).toHaveBeenCalled();
  });

  it("throws when event not found", async () => {
    m.getEventDatesForAccess.mockResolvedValue(null);
    await expect(
      service.createEventAccess({ eventId: "x", name: "T" } as CreateEventAccessInput),
    ).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND });
  });

  it("throws when dates fall outside event boundaries", async () => {
    m.getEventDatesForAccess.mockResolvedValue(eventDates);
    await expect(
      service.createEventAccess({
        eventId,
        name: "WS",
        startsAt: new Date("2025-05-01T00:00:00Z"),
      } as CreateEventAccessInput),
    ).rejects.toMatchObject({ code: ErrorCodes.ACCESS_DATE_OUT_OF_BOUNDS });
  });

  it("rejects when a prerequisite id does not exist in the event", async () => {
    m.getEventDatesForAccess.mockResolvedValue(eventDates);
    m.findExistingAccessIdsInEvent.mockResolvedValue(["p1"]);
    await expect(
      service.createEventAccess({
        eventId,
        name: "Adv",
        requiredAccessIds: ["p1", "p2"],
      } as CreateEventAccessInput),
    ).rejects.toMatchObject({ code: ErrorCodes.BAD_REQUEST });
  });

  it("creates with prerequisites when all exist", async () => {
    m.getEventDatesForAccess.mockResolvedValue(eventDates);
    m.findExistingAccessIdsInEvent.mockResolvedValue(["p1", "p2"]);
    m.insertEventAccess.mockResolvedValue(
      accessRow({ requiredAccess: [{ id: "p1", name: "P" }, { id: "p2", name: "P" }] }),
    );
    const result = await service.createEventAccess({
      eventId,
      name: "Adv",
      requiredAccessIds: ["p1", "p2"],
    } as CreateEventAccessInput);
    expect(result.requiredAccess).toHaveLength(2);
    expect(m.insertEventAccess).toHaveBeenCalledWith(expect.anything(), ["p1", "p2"]);
  });

  it("applies service defaults for omitted fields", async () => {
    m.getEventDatesForAccess.mockResolvedValue(eventDates);
    m.insertEventAccess.mockResolvedValue(accessRow());
    await service.createEventAccess({ eventId, name: "Simple" } as CreateEventAccessInput);
    expect(m.insertEventAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "OTHER",
        price: 0,
        currency: "TND",
        active: true,
        conditionLogic: "AND",
        sortOrder: 0,
        allowCompanion: false,
      }),
      [],
    );
  });
});

// ===========================================================================
// updateEventAccess
// ===========================================================================
describe("updateEventAccess", () => {
  const existing = () => ({ ...accessRow(), event: { startDate, endDate } });

  it("updates fields on an existing item", async () => {
    m.getEventAccessForUpdate.mockResolvedValue(existing());
    m.updateEventAccessRow.mockResolvedValue(accessRow({ name: "New", price: 75 }));
    m.getEventAccessWithPrereqs.mockResolvedValue(accessRow({ name: "New", price: 75 }));

    const result = await service.updateEventAccess("access-1", { name: "New", price: 75 });
    expect(result.name).toBe("New");
    expect(result.price).toBe(75);
  });

  it("throws when access not found", async () => {
    m.getEventAccessForUpdate.mockResolvedValue(null);
    await expect(
      service.updateEventAccess("x", { name: "T" }),
    ).rejects.toMatchObject({ code: ErrorCodes.ACCESS_NOT_FOUND });
  });

  it("throws when updated dates fall outside event boundaries", async () => {
    m.getEventAccessForUpdate.mockResolvedValue(existing());
    await expect(
      service.updateEventAccess("access-1", { startsAt: new Date("2025-07-01T00:00:00Z") }),
    ).rejects.toMatchObject({ code: ErrorCodes.ACCESS_DATE_OUT_OF_BOUNDS });
  });

  it("throws when merged start time ends up after end time", async () => {
    m.getEventAccessForUpdate.mockResolvedValue({
      ...accessRow({
        startsAt: new Date("2025-06-01T09:00:00Z"),
        endsAt: new Date("2025-06-01T11:00:00Z"),
      }),
      event: { startDate, endDate },
    });
    await expect(
      service.updateEventAccess("access-1", { startsAt: new Date("2025-06-01T12:00:00Z") }),
    ).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_ERROR });
  });

  it("rejects lowering maxCapacity below settled paid count", async () => {
    m.getEventAccessForUpdate.mockResolvedValue({
      ...accessRow({ maxCapacity: 20, registeredCount: 15, paidCount: 8 }),
      event: { startDate, endDate },
    });
    await expect(
      service.updateEventAccess("access-1", { maxCapacity: 7 }),
    ).rejects.toMatchObject({
      code: ErrorCodes.ACCESS_CAPACITY_EXCEEDED,
      details: { paidCount: 8, requestedMaxCapacity: 7 },
    });
    expect(m.updateEventAccessRow).not.toHaveBeenCalled();
  });

  it("allows lowering maxCapacity below registeredCount when paidCount still fits", async () => {
    m.getEventAccessForUpdate.mockResolvedValue({
      ...accessRow({ maxCapacity: 20, registeredCount: 12, paidCount: 5 }),
      event: { startDate, endDate },
    });
    m.updateEventAccessRow.mockResolvedValue(accessRow({ maxCapacity: 5 }));
    m.getAccessCapacityRowsByIds.mockResolvedValue([
      { id: "access-1", name: "Access", maxCapacity: 5, paidCount: 5 },
    ]);
    m.getUnsettledRegistrationsWithAccess.mockResolvedValue([]);
    m.getEventAccessWithPrereqs.mockResolvedValue(accessRow({ maxCapacity: 5 }));

    const result = await service.updateEventAccess("access-1", { maxCapacity: 5 });
    expect(result.maxCapacity).toBe(5);
    expect(m.getUnsettledRegistrationsWithAccess).toHaveBeenCalledWith(
      eventId,
      "access-1",
      expect.anything(),
    );
  });

  it("detects circular prerequisites (transitive)", async () => {
    // Existing graph A→B→C; adding C→A closes the cycle.
    m.getEventAccessForUpdate.mockResolvedValue({
      ...accessRow({ id: "access-c" }),
      event: { startDate, endDate },
    });
    m.findExistingAccessIdsInEvent.mockResolvedValue(["access-a"]);
    m.getEventPrereqEdges.mockResolvedValue([
      { owner: "access-a", required: "access-b" },
      { owner: "access-b", required: "access-c" },
    ]);
    await expect(
      service.updateEventAccess("access-c", { requiredAccessIds: ["access-a"] }),
    ).rejects.toMatchObject({ code: ErrorCodes.ACCESS_CIRCULAR_DEPENDENCY });
  });

  it("allows acyclic prerequisite updates", async () => {
    m.getEventAccessForUpdate.mockResolvedValue({
      ...accessRow({ id: "access-main" }),
      event: { startDate, endDate },
    });
    m.findExistingAccessIdsInEvent.mockResolvedValue(["prereq"]);
    m.getEventPrereqEdges.mockResolvedValue([]);
    m.updateEventAccessRow.mockResolvedValue(accessRow({ id: "access-main" }));
    m.setAccessPrerequisites.mockResolvedValue(undefined);
    m.getEventAccessWithPrereqs.mockResolvedValue(
      accessRow({ id: "access-main", requiredAccess: [{ id: "prereq", name: "P" }] }),
    );

    const result = await service.updateEventAccess("access-main", {
      requiredAccessIds: ["prereq"],
    });
    expect(result.requiredAccess).toHaveLength(1);
    expect(m.setAccessPrerequisites).toHaveBeenCalledWith("access-main", ["prereq"]);
  });
});

// ===========================================================================
// deleteEventAccess
// ===========================================================================
describe("deleteEventAccess", () => {
  it("deletes cleanly when nothing references it", async () => {
    m.getEventAccessById.mockResolvedValue(accessRow());
    m.countRegistrationsWithAccess.mockResolvedValue(0);
    m.countActiveSponsorshipsWithAccess.mockResolvedValue(0);
    m.getAccessDependentIds.mockResolvedValue([]);
    m.deleteEventAccessById.mockResolvedValue(undefined);

    await service.deleteEventAccess("access-1");
    expect(m.deleteEventAccessById).toHaveBeenCalledWith("access-1");
  });

  it("throws when access not found", async () => {
    m.getEventAccessById.mockResolvedValue(null);
    await expect(service.deleteEventAccess("x")).rejects.toMatchObject({
      code: ErrorCodes.ACCESS_NOT_FOUND,
    });
  });

  it("throws when access has registrations", async () => {
    m.getEventAccessById.mockResolvedValue(accessRow());
    m.countRegistrationsWithAccess.mockResolvedValue(5);
    await expect(service.deleteEventAccess("access-1")).rejects.toMatchObject({
      code: ErrorCodes.ACCESS_HAS_REGISTRATIONS,
    });
  });

  it("throws when access is referenced by active sponsorships", async () => {
    m.getEventAccessById.mockResolvedValue(accessRow());
    m.countRegistrationsWithAccess.mockResolvedValue(0);
    m.countActiveSponsorshipsWithAccess.mockResolvedValue(2);
    await expect(service.deleteEventAccess("access-1")).rejects.toMatchObject({
      code: ErrorCodes.ACCESS_HAS_SPONSORSHIPS,
    });
  });

  it("disconnects dependents before deleting", async () => {
    m.getEventAccessById.mockResolvedValue(accessRow());
    m.countRegistrationsWithAccess.mockResolvedValue(0);
    m.countActiveSponsorshipsWithAccess.mockResolvedValue(0);
    m.getAccessDependentIds.mockResolvedValue(["dep-1", "dep-2"]);
    m.deleteEventAccessById.mockResolvedValue(undefined);

    await service.deleteEventAccess("access-1");
    expect(m.removePrerequisiteEdge).toHaveBeenCalledWith("dep-1", "access-1");
    expect(m.removePrerequisiteEdge).toHaveBeenCalledWith("dep-2", "access-1");
    expect(m.deleteEventAccessById).toHaveBeenCalledWith("access-1");
  });
});

// ===========================================================================
// simple reads
// ===========================================================================
describe("reads", () => {
  it("listEventAccess passes options through", async () => {
    m.listEventAccessRows.mockResolvedValue([accessRow()]);
    await service.listEventAccess(eventId, { active: true, type: "WORKSHOP" });
    expect(m.listEventAccessRows).toHaveBeenCalledWith(eventId, {
      active: true,
      type: "WORKSHOP",
    });
  });

  it("getAccessClientId delegates to the query", async () => {
    m.getAccessClientId.mockResolvedValue("client-1");
    expect(await service.getAccessClientId("access-1")).toBe("client-1");
  });
});

// ===========================================================================
// getGroupedAccess / validateAccessSelections wiring
// ===========================================================================
describe("getGroupedAccess", () => {
  it("groups active access fetched from the db", async () => {
    m.getActiveAccessForGrouping.mockResolvedValue([
      accessRow({ id: "ws", type: "WORKSHOP", startsAt: new Date("2025-06-01T09:00:00Z") }),
    ]);
    const result = await service.getGroupedAccess(eventId, {}, []);
    expect(result.groups).toHaveLength(1);
  });
});

describe("validateAccessSelections", () => {
  it("fetches selected + included items and validates", async () => {
    m.getAccessByIdsForValidation.mockResolvedValue([
      accessRow({ id: "a1", active: true }),
    ]);
    m.getIncludedInBaseAccess.mockResolvedValue([]);
    const result = await service.validateAccessSelections(
      eventId,
      [{ accessId: "a1", quantity: 1 }],
      {},
    );
    expect(result.valid).toBe(true);
  });

  it("skips the selected-items query when there are no selections", async () => {
    m.getIncludedInBaseAccess.mockResolvedValue([]);
    const result = await service.validateAccessSelections(eventId, [], {});
    expect(result.valid).toBe(true);
    expect(m.getAccessByIdsForValidation).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// capacity counters
// ===========================================================================
describe("incrementAccessRegisteredCountTx", () => {
  it("succeeds when the guarded update affects a row", async () => {
    m.casIncrementAccessRegisteredCount.mockResolvedValue(true);
    await expect(
      service.incrementAccessRegisteredCountTx("access-1", 1),
    ).resolves.toBeUndefined();
  });

  it("throws NOT_FOUND when the access is gone", async () => {
    m.casIncrementAccessRegisteredCount.mockResolvedValue(false);
    m.getAccessCapacityInfo.mockResolvedValue(null);
    await expect(
      service.incrementAccessRegisteredCountTx("x", 1),
    ).rejects.toMatchObject({ code: ErrorCodes.ACCESS_NOT_FOUND });
  });

  it("throws only once paid count has filled capacity", async () => {
    m.casIncrementAccessRegisteredCount.mockResolvedValue(false);
    m.getAccessCapacityInfo.mockResolvedValue({
      name: "Workshop",
      maxCapacity: 10,
      paidCount: 10,
    });
    await expect(
      service.incrementAccessRegisteredCountTx("access-1", 1),
    ).rejects.toMatchObject({
      code: ErrorCodes.ACCESS_CAPACITY_EXCEEDED,
      details: { remaining: 0, requested: 1 },
    });
  });
});

describe("decrementAccessRegisteredCountTx", () => {
  it("succeeds within the floor", async () => {
    m.casDecrementAccessRegisteredCount.mockResolvedValue(true);
    await expect(
      service.decrementAccessRegisteredCountTx("access-1", 1),
    ).resolves.toBeUndefined();
  });

  it("throws NOT_FOUND when missing", async () => {
    m.casDecrementAccessRegisteredCount.mockResolvedValue(false);
    m.getAccessRegisteredCount.mockResolvedValue(null);
    await expect(
      service.decrementAccessRegisteredCountTx("x", 1),
    ).rejects.toMatchObject({ code: ErrorCodes.ACCESS_NOT_FOUND });
  });

  it("throws on underflow", async () => {
    m.casDecrementAccessRegisteredCount.mockResolvedValue(false);
    m.getAccessRegisteredCount.mockResolvedValue({ registeredCount: 1 });
    await expect(
      service.decrementAccessRegisteredCountTx("access-1", 2),
    ).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION_ERROR,
      details: { registeredCount: 1, requested: 2 },
    });
  });
});

describe("incrementPaidCount", () => {
  it("succeeds within capacity", async () => {
    m.casIncrementAccessPaidCount.mockResolvedValue(true);
    await expect(service.incrementPaidCount("access-1", 1)).resolves.toBeUndefined();
    expect(m.getAccessCapacityInfo).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when missing", async () => {
    m.casIncrementAccessPaidCount.mockResolvedValue(false);
    m.getAccessCapacityInfo.mockResolvedValue(null);
    await expect(service.incrementPaidCount("x", 1)).rejects.toMatchObject({
      code: ErrorCodes.ACCESS_NOT_FOUND,
    });
  });

  it("fails atomically when quantity exceeds remaining capacity", async () => {
    m.casIncrementAccessPaidCount.mockResolvedValue(false);
    m.getAccessCapacityInfo.mockResolvedValue({
      name: "Workshop",
      maxCapacity: 10,
      paidCount: 8,
    });
    await expect(service.incrementPaidCount("access-1", 3)).rejects.toMatchObject({
      code: ErrorCodes.ACCESS_CAPACITY_EXCEEDED,
      details: { remaining: 2, requested: 3 },
    });
  });
});

describe("decrementPaidCount", () => {
  it("succeeds within the floor", async () => {
    m.casDecrementAccessPaidCount.mockResolvedValue(true);
    await expect(service.decrementPaidCount("access-1", 1)).resolves.toBeUndefined();
  });

  it("throws on underflow", async () => {
    m.casDecrementAccessPaidCount.mockResolvedValue(false);
    m.getAccessPaidCount.mockResolvedValue({ paidCount: 1 });
    await expect(service.decrementPaidCount("access-1", 2)).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION_ERROR,
      details: { paidCount: 1, requested: 2 },
    });
  });
});

// ===========================================================================
// syncPaidCountDelta
// ===========================================================================
describe("syncPaidCountDelta", () => {
  it("increments only newly-paid access quantities", async () => {
    m.casIncrementAccessPaidCount.mockResolvedValue(true);
    m.getAccessCapacityRowsByIds.mockResolvedValue([]);

    await service.syncPaidCountDelta(
      eventId,
      {
        status: "PARTIAL",
        priceBreakdown: {
          accessItems: [
            { accessId: "access-1", quantity: 1 },
            { accessId: "access-2", quantity: 1 },
          ],
        },
        coveredAccessIds: new Set(["access-1"]),
      },
      {
        status: "PARTIAL",
        priceBreakdown: {
          accessItems: [
            { accessId: "access-1", quantity: 1 },
            { accessId: "access-2", quantity: 1 },
          ],
        },
        coveredAccessIds: new Set(["access-1", "access-2"]),
      },
    );

    expect(m.casIncrementAccessPaidCount).toHaveBeenCalledTimes(1);
    expect(m.casIncrementAccessPaidCount).toHaveBeenCalledWith(
      "access-2",
      1,
      expect.anything(),
    );
    expect(m.getAccessCapacityRowsByIds).toHaveBeenCalledWith(
      ["access-2"],
      expect.anything(),
    );
  });

  it("decrements partial coverage on refund", async () => {
    m.casDecrementAccessPaidCount.mockResolvedValue(true);
    await service.syncPaidCountDelta(
      eventId,
      {
        status: "PARTIAL",
        priceBreakdown: { accessItems: [{ accessId: "access-1", quantity: 2 }] },
        coveredAccessIds: new Set(["access-1"]),
      },
      {
        status: "REFUNDED",
        priceBreakdown: { accessItems: [{ accessId: "access-1", quantity: 2 }] },
      },
    );
    expect(m.casDecrementAccessPaidCount).toHaveBeenCalledWith(
      "access-1",
      2,
      expect.anything(),
    );
    expect(m.casIncrementAccessPaidCount).not.toHaveBeenCalled();
  });

  it("does nothing when a fully settled registration stays settled", async () => {
    await service.syncPaidCountDelta(
      eventId,
      { status: "SPONSORED", priceBreakdown: { accessItems: [{ accessId: "access-1", quantity: 1 }] } },
      { status: "SPONSORED", priceBreakdown: { accessItems: [{ accessId: "access-1", quantity: 1 }] } },
    );
    expect(m.casIncrementAccessPaidCount).not.toHaveBeenCalled();
    expect(m.casDecrementAccessPaidCount).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// handleCapacityReached — priceBreakdown recompute + outbox dedupe
// ===========================================================================
describe("handleCapacityReached", () => {
  const regBase = {
    id: "reg-1",
    email: "u@x.com",
    firstName: "U",
    lastName: "X",
    accessTypeIds: ["access-1", "access-2"],
    droppedAccessIds: [],
    totalAmount: 180,
    accessAmount: 80,
    sponsorshipAmount: 0,
    priceBreakdown: {
      calculatedBasePrice: 100,
      accessItems: [
        { accessId: "access-1", quantity: 1, subtotal: 50, name: "WS", unitPrice: 50 },
        { accessId: "access-2", quantity: 1, subtotal: 30, name: "DIN", unitPrice: 30 },
      ],
      accessTotal: 80,
      subtotal: 180,
      sponsorshipTotal: 0,
      total: 180,
      droppedAccessItems: [],
    },
  };

  it("drops the at-capacity access and recomputes the breakdown", async () => {
    m.getAccessCapacityRowsByIds.mockResolvedValue([
      { id: "access-1", name: "WS", maxCapacity: 10, paidCount: 10 },
    ]);
    m.getUnsettledRegistrationsWithAccess.mockResolvedValue([{ ...regBase }]);
    m.getRegistrationCoveredAccessIds.mockResolvedValue([]);
    m.casDecrementAccessRegisteredCount.mockResolvedValue(true);

    const affected = await service.handleCapacityReached(eventId, ["access-1"]);
    expect(affected).toBe(1);

    const [, patch] = m.updateRegistrationForAccessDrop.mock.calls[0];
    expect(patch.totalAmount).toBe(130);
    expect(patch.accessAmount).toBe(30);
    expect(patch.accessTypeIds).toEqual(["access-2"]);
    expect(patch.droppedAccessIds).toEqual(["access-1"]);
    expect(patch.priceBreakdown.accessItems).toHaveLength(1);
    expect(patch.priceBreakdown.subtotal).toBe(130);
    expect(patch.priceBreakdown.droppedAccessItems[0].reason).toBe("capacity_reached");
    expect(patch.paymentStatus).toBeUndefined();
    expect(m.enqueueTriggeredEmailOutbox).not.toHaveBeenCalled();

    const [audit] = m.insertAccessAuditLog.mock.calls[0];
    expect(audit.action).toBe("ACCESS_CAPACITY_REACHED");
    expect(audit.performedBy).toBe("SYSTEM");
  });

  it("marks fully-covered registrations SPONSORED and enqueues the confirmation email", async () => {
    m.getAccessCapacityRowsByIds.mockResolvedValue([
      { id: "access-1", name: "WS", maxCapacity: 10, paidCount: 10 },
    ]);
    m.getUnsettledRegistrationsWithAccess.mockResolvedValue([
      { ...regBase, sponsorshipAmount: 200 },
    ]);
    m.getRegistrationCoveredAccessIds.mockResolvedValue([]);
    m.casDecrementAccessRegisteredCount.mockResolvedValue(true);

    await service.handleCapacityReached(eventId, ["access-1"]);

    const [, patch] = m.updateRegistrationForAccessDrop.mock.calls[0];
    expect(patch.paymentStatus).toBe("SPONSORED");
    expect(patch.totalAmount).toBe(0);
    expect(m.enqueueTriggeredEmailOutbox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ trigger: "PAYMENT_CONFIRMED" }),
      "email:triggered:PAYMENT_CONFIRMED:reg-1",
    );
  });

  it("skips a registration whose access is sponsorship-protected", async () => {
    m.getAccessCapacityRowsByIds.mockResolvedValue([
      { id: "access-1", name: "WS", maxCapacity: 10, paidCount: 10 },
    ]);
    m.getUnsettledRegistrationsWithAccess.mockResolvedValue([{ ...regBase }]);
    m.getRegistrationCoveredAccessIds.mockResolvedValue(["access-1"]);

    const affected = await service.handleCapacityReached(eventId, ["access-1"]);
    expect(affected).toBe(0);
    expect(m.updateRegistrationForAccessDrop).not.toHaveBeenCalled();
  });

  it("does nothing for access below capacity", async () => {
    m.getAccessCapacityRowsByIds.mockResolvedValue([
      { id: "access-1", name: "WS", maxCapacity: 10, paidCount: 5 },
    ]);
    const affected = await service.handleCapacityReached(eventId, ["access-1"]);
    expect(affected).toBe(0);
    expect(m.getUnsettledRegistrationsWithAccess).not.toHaveBeenCalled();
  });
});
