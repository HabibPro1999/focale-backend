import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, CreateEventAccessSchema } from "@app/contracts";

// Mock the db query layer (the seam the service talks to). withTxn is a
// passthrough invoking the callback with a dummy tx (all query fns are mocked).
vi.mock("@app/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@app/db")>();
  return {
  // The paid-count error classes are the real ones (the service maps them by class).
  AccessCapacityExceededError: real.AccessCapacityExceededError,
  AccessNotFoundError: real.AccessNotFoundError,
  AccessPaidCountUnderflowError: real.AccessPaidCountUnderflowError,
  applyPaidAccessDelta: vi.fn(),
  takePaidAccess: vi.fn(),
  releasePaidAccess: vi.fn(),
  findRegistrationFormSchema: vi.fn(),
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
  getAccessCapacityInfo: vi.fn(),
  getAccessRegisteredCount: vi.fn(),
  getRegistrationCoveredAccessIds: vi.fn(),
  enqueueAccessDrops: vi.fn(),
  };
});

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
    m.enqueueAccessDrops.mockResolvedValue(["access-1"]);
    m.getEventAccessWithPrereqs.mockResolvedValue(accessRow({ maxCapacity: 5 }));

    const result = await service.updateEventAccess("access-1", { maxCapacity: 5 });
    expect(result.maxCapacity).toBe(5);
    // The drop of the now-full item from unsettled registrations goes through the outbox.
    expect(m.enqueueAccessDrops).toHaveBeenCalledWith(expect.anything(), eventId, ["access-1"], "capacity_reached");
  });

  it("deactivating an item enqueues its drop from unsettled registrations", async () => {
    m.getEventAccessForUpdate.mockResolvedValue({
      ...accessRow({ active: true }),
      event: { startDate, endDate },
    });
    m.updateEventAccessRow.mockResolvedValue(accessRow({ active: false }));
    m.enqueueAccessDrops.mockResolvedValue(["access-1"]);
    m.getEventAccessWithPrereqs.mockResolvedValue(accessRow({ active: false }));

    await service.updateEventAccess("access-1", { active: false });
    expect(m.enqueueAccessDrops).toHaveBeenCalledWith(expect.anything(), eventId, ["access-1"], "deactivated");
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

describe("incrementPaidCount / decrementPaidCount", () => {
  it("take and release paid places through @app/db", async () => {
    m.takePaidAccess.mockResolvedValue(undefined);
    m.releasePaidAccess.mockResolvedValue(undefined);
    await expect(service.incrementPaidCount("access-1", 2)).resolves.toBeUndefined();
    await expect(service.decrementPaidCount("access-1", 1)).resolves.toBeUndefined();
    expect(m.takePaidAccess).toHaveBeenCalledWith(expect.anything(), "access-1", 2);
    expect(m.releasePaidAccess).toHaveBeenCalledWith(expect.anything(), "access-1", 1);
  });

  it("maps a missing access item to ACCESS_NOT_FOUND", async () => {
    m.takePaidAccess.mockRejectedValue(new db.AccessNotFoundError("x"));
    await expect(service.incrementPaidCount("x", 1)).rejects.toMatchObject({
      code: ErrorCodes.ACCESS_NOT_FOUND,
      statusCode: 404,
      message: "Access not found",
    });
  });

  it("maps a full access item to ACCESS_CAPACITY_EXCEEDED with the remaining places", async () => {
    m.takePaidAccess.mockRejectedValue(new db.AccessCapacityExceededError("access-1", "Workshop", 2, 3));
    await expect(service.incrementPaidCount("access-1", 3)).rejects.toMatchObject({
      code: ErrorCodes.ACCESS_CAPACITY_EXCEEDED,
      statusCode: 409,
      message: "Workshop has insufficient capacity (2 spots remaining, requested 3)",
      details: { remaining: 2, requested: 3 },
    });
  });

  it("maps an underflow to VALIDATION_ERROR", async () => {
    m.releasePaidAccess.mockRejectedValue(new db.AccessPaidCountUnderflowError("access-1", 1, 2));
    await expect(service.decrementPaidCount("access-1", 2)).rejects.toMatchObject({
      code: ErrorCodes.VALIDATION_ERROR,
      statusCode: 409,
      message: "Paid access count cannot be decremented below zero",
      details: { paidCount: 1, requested: 2 },
    });
  });
});

// ===========================================================================
// syncPaidCountDelta: thin wrapper over @app/db applyPaidAccessDelta
// ===========================================================================
describe("syncPaidCountDelta", () => {
  const oldState = {
    status: "PARTIAL",
    priceBreakdown: { accessItems: [{ accessId: "access-2", quantity: 1 }] },
    coveredAccessIds: new Set<string>(),
  };
  const newState = { ...oldState, coveredAccessIds: new Set(["access-2"]) };

  it("moves the paid counts, then enqueues the drop check for the items that went up", async () => {
    m.applyPaidAccessDelta.mockResolvedValue({ incremented: ["access-2"], decremented: [] });
    m.enqueueAccessDrops.mockResolvedValue([]);
    await service.syncPaidCountDelta(eventId, oldState, newState);
    expect(m.applyPaidAccessDelta).toHaveBeenCalledWith(expect.anything(), oldState, newState);
    expect(m.enqueueAccessDrops).toHaveBeenCalledWith(expect.anything(), eventId, ["access-2"], "capacity_reached");
  });

  it("skips the capacity check when nothing went up", async () => {
    m.applyPaidAccessDelta.mockResolvedValue({ incremented: [], decremented: ["access-2"] });
    await service.syncPaidCountDelta(eventId, newState, { ...newState, status: "REFUNDED" });
    expect(m.enqueueAccessDrops).not.toHaveBeenCalled();
  });

  it("maps a capacity failure to the API error", async () => {
    m.applyPaidAccessDelta.mockRejectedValue(new db.AccessCapacityExceededError("access-2", "Gala", 0, 1));
    await expect(service.syncPaidCountDelta(eventId, oldState, newState)).rejects.toMatchObject({
      code: ErrorCodes.ACCESS_CAPACITY_EXCEEDED,
      details: { remaining: 0, requested: 1 },
    });
    expect(m.enqueueAccessDrops).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// handleCapacityReached — enqueue only (the drop runs in the worker, plan 2.8;
// its recompute is covered by packages/db/tests/db/access-drop.db.test.ts)
// ===========================================================================
describe("handleCapacityReached", () => {
  it("enqueues the capacity drop in the caller's transaction and changes no registration", async () => {
    const tx = { __tx: true };
    m.enqueueAccessDrops.mockResolvedValue(["access-1"]);
    expect(await service.handleCapacityReached(eventId, ["access-1", "access-2"], tx as never)).toBe(1);
    expect(m.enqueueAccessDrops).toHaveBeenCalledWith(tx, eventId, ["access-1", "access-2"], "capacity_reached");
  });
});

describe("required access choice", () => {
  const settings = { accessSelectionRequired: true };
  it("does no reads when the setting is absent", async () => {
    await service.assertAccessSelectionRequirement(eventId, {}, [], undefined);
    expect(m.getActiveAccessForGrouping).not.toHaveBeenCalled();
  });
  it("rejects an empty choice if a visible, non-full option exists", async () => {
    m.getActiveAccessForGrouping.mockResolvedValue([accessRow()]);
    await expect(service.assertAccessSelectionRequirement(eventId, {}, [], settings)).rejects.toMatchObject({ code: ErrorCodes.ACCESS_SELECTION_REQUIRED });
  });
  it("accepts any selected non-included access", async () => {
    m.getAccessByIdsForValidation.mockResolvedValue([accessRow()]);
    await service.assertAccessSelectionRequirement(eventId, {}, [{ accessId: "access-1", quantity: 1 }], settings);
    expect(m.getActiveAccessForGrouping).not.toHaveBeenCalled();
  });
  it("does not count automatically included access as a choice", async () => {
    m.getAccessByIdsForValidation.mockResolvedValue([accessRow({ includedInBase: true })]);
    m.getActiveAccessForGrouping.mockResolvedValue([accessRow({ id: "optional" })]);
    await expect(service.assertAccessSelectionRequirement(eventId, {}, [{ accessId: "access-1", quantity: 1 }], settings)).rejects.toMatchObject({ code: ErrorCodes.ACCESS_SELECTION_REQUIRED });
  });
  it.each([
    { maxCapacity: 1, paidCount: 1 }, { includedInBase: true },
    { availableTo: new Date(0) }, { requiredAccess: [{ id: "unselected" }] },
    { conditions: [{ fieldId: "category", operator: "equals", value: "doctor" }] },
  ])("waives the requirement when no option is selectable: %j", async (row) => {
    m.getActiveAccessForGrouping.mockResolvedValue([accessRow(row)]);
    await expect(service.assertAccessSelectionRequirement(eventId, {}, [], settings)).resolves.toBeUndefined();
  });
});

describe("condition option IDs", () => {
  const schema = { steps: [{ fields: [{ id: "country", label: "Country", type: "country", options: [{ id: "TN", label: "Tunisie" }] }] }] };
  it("rejects labels on create and allows actual option IDs", async () => {
    m.getEventDatesForAccess.mockResolvedValue(eventDates);
    m.findRegistrationFormSchema.mockResolvedValue({ schema });
    const data = CreateEventAccessSchema.parse({ eventId: "11111111-1111-4111-8111-111111111111", name: "Dinner", conditions: [{ fieldId: "country", operator: "equals" as const, value: "Tunisie" }] });
    await expect(service.createEventAccess(data)).rejects.toMatchObject({ code: ErrorCodes.ACCESS_CONDITION_INVALID_OPTION, details: { fieldId: "country", exampleOptionIds: ["TN"] } });
    expect(m.insertEventAccess).not.toHaveBeenCalled();
    await service.createEventAccess({ ...data, conditions: [{ ...data.conditions![0], value: "TN" }] });
    expect(m.insertEventAccess).toHaveBeenCalled();
  });
  it("grandfathers conditions on unrelated updates, validates explicit edits", async () => {
    m.getEventAccessForUpdate.mockResolvedValue({ ...accessRow(), event: eventDates });
    m.findRegistrationFormSchema.mockResolvedValue({ schema });
    await service.updateEventAccess("access-1", { name: "New name" });
    expect(m.findRegistrationFormSchema).not.toHaveBeenCalled();
    await expect(service.updateEventAccess("access-1", { conditions: [{ fieldId: "country", operator: "in", value: ["Tunisie"] }] })).rejects.toMatchObject({ code: ErrorCodes.ACCESS_CONDITION_INVALID_OPTION });
  });
});
