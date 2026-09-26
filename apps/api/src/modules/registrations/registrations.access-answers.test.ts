import { ErrorCodes } from "@app/contracts";
import type { EventAccessWithPrereqIds } from "@app/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Public access grouping/validation evaluate access conditions on the answers
// the form shows (coerced as create stores them), so what grouping offers is
// what create accepts. Access and registration services run for real; only
// the DB layer and pricing are mocked.
const db = vi.hoisted(() => ({
  getDb: vi.fn(() => ({})),
  withTxn: vi.fn(),
  withLockingTxn: vi.fn(),
  lockRegistrationForUpdate: vi.fn(),
  applyRegistrationSettlement: vi.fn(),
  emitSettlementEvents: vi.fn(),
  getEventWithPricing: vi.fn(),
  findClientModuleState: vi.fn(),
  getRegistrationFormSchemaForEvent: vi.fn(),
  getActiveAccessForGrouping: vi.fn(),
  getAccessByIdsForValidation: vi.fn(),
  getIncludedInBaseAccess: vi.fn(),
  casIncrementAccessRegisteredCount: vi.fn(),
  findActiveRegistrationFormById: vi.fn(),
  findFormById: vi.fn(),
  registrationExistsByEmailForm: vi.fn(),
  getEventForRegistrationCreate: vi.fn(),
  allocateReferenceNumber: vi.fn(),
  insertRegistrationRow: vi.fn(),
  casIncrementRegisteredTx: vi.fn(),
  getEventCounterInfoTx: vi.fn(),
  insertAuditLog: vi.fn(),
  enqueueRealtimeOutboxEvent: vi.fn(),
  enqueueTriggeredEmailOutbox: vi.fn(),
  getRegistrationByIdRow: vi.fn(),
  findAccessDetailsByIds: vi.fn(),
  enqueueNetworkingRegistrationSyncs: vi.fn(),
  enqueueNetworkingRegistrationCreatedSync: vi.fn(),
}));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...db,
}));

// emitSettlementEvents with @app/db's body, over the mocked primitives.
db.emitSettlementEvents.mockImplementation(
  async (tx: unknown, events: Array<{ type: string; eventId?: string; payload: { id: unknown } }>) => {
    await db.enqueueNetworkingRegistrationSyncs(
      tx,
      events.flatMap((ev) =>
        (ev.type === "registration.updated" || ev.type === "registration.paymentConfirmed") && ev.eventId
          ? [{ registrationId: String(ev.payload.id), eventId: ev.eventId }]
          : [],
      ),
    );
    const results: unknown[] = [];
    for (const ev of events) results.push(await db.enqueueRealtimeOutboxEvent(tx, ev));
    return results;
  },
);

import type { Config } from "../../core/config";
import { AccessPublicController } from "../access/access.public.controller";
import { AccessService } from "../access/access.service";
import type { PricingService } from "../pricing/pricing.service";
import { RegistrationCreateService } from "./registrations.create.service";
import { RegistrationSideEffects } from "./registrations.side-effects";

const FUTURE = new Date(Date.now() + 7 * 86_400_000);
const EVENT_ID = "11111111-1111-4111-8111-111111111111";

// `specialty` is shown only to doctors; the form app compares
// case-insensitively, so "Doctor" shows it too.
const SCHEMA = {
  steps: [
    {
      id: "s1",
      title: "Profile",
      fields: [
        {
          id: "profession",
          type: "radio",
          label: "Profession",
          required: true,
          options: [{ id: "doctor" }, { id: "Doctor" }, { id: "nurse" }],
        },
        {
          id: "specialty",
          type: "text",
          label: "Specialty",
          conditions: [{ id: "c1", fieldId: "profession", operator: "equals", value: "doctor" }],
        },
      ],
    },
  ],
};

function item(id: string, conditions: EventAccessWithPrereqIds["conditions"]): EventAccessWithPrereqIds {
  return {
    id,
    eventId: EVENT_ID,
    type: "ADDON",
    name: id,
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
    conditions,
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
  } as EventAccessWithPrereqIds;
}

const ACCESS = [
  item("cardio-workshop", [{ fieldId: "specialty", operator: "equals", value: "cardiology" }]),
  item("nurse-lunch", [{ fieldId: "profession", operator: "equals", value: "nurse" }]),
  item("open-dinner", null),
];

const client = { active: true, enabledModules: ["registrations", "pricing"] };
const openEvent = { clientId: "c1", status: "OPEN", endDate: FUTURE };

let controller: AccessPublicController;
let registrations: RegistrationCreateService;

beforeEach(() => {
  vi.clearAllMocks();
  db.getDb.mockReturnValue({});
  db.withTxn.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
  db.withLockingTxn.mockImplementation((fn: (tx: unknown) => unknown) => db.withTxn(fn));
  db.lockRegistrationForUpdate.mockResolvedValue(true);
  db.getEventWithPricing.mockResolvedValue({ id: EVENT_ID, ...openEvent });
  db.findClientModuleState.mockResolvedValue(client);
  db.getRegistrationFormSchemaForEvent.mockResolvedValue({ schema: SCHEMA });
  db.getActiveAccessForGrouping.mockResolvedValue(ACCESS);
  db.getAccessByIdsForValidation.mockImplementation(async (ids: string[]) =>
    ACCESS.filter((a) => ids.includes(a.id)),
  );
  db.getIncludedInBaseAccess.mockResolvedValue([]);
  db.casIncrementAccessRegisteredCount.mockResolvedValue(true);
  db.findActiveRegistrationFormById.mockResolvedValue({
    id: "form1",
    eventId: EVENT_ID,
    schemaVersion: 1,
    schema: SCHEMA,
    event: openEvent,
  });
  db.findFormById.mockResolvedValue({ id: "form1", eventId: EVENT_ID, schemaVersion: 1, schema: SCHEMA });
  db.registrationExistsByEmailForm.mockResolvedValue(false);
  db.getEventForRegistrationCreate.mockResolvedValue({ ...openEvent, client, maxCapacity: null, registeredCount: 0 });
  db.allocateReferenceNumber.mockResolvedValue("26-EV-001");
  db.insertRegistrationRow.mockResolvedValue({ id: "reg1" });
  db.casIncrementRegisteredTx.mockResolvedValue(true);
  db.enqueueRealtimeOutboxEvent.mockResolvedValue(true);
  db.enqueueTriggeredEmailOutbox.mockResolvedValue(true);
  db.findAccessDetailsByIds.mockResolvedValue([]);
  db.getRegistrationByIdRow.mockResolvedValue({
    id: "reg1",
    formId: "form1",
    eventId: EVENT_ID,
    email: "a@b.com",
    formData: {},
    priceBreakdown: { accessItems: [] },
    accessTypeIds: [],
    editToken: "tok",
    accessCheckIns: [],
    form: { id: "form1", name: "Reg" },
    event: { id: EVENT_ID, name: "Ev", slug: "ev", clientId: "c1" },
  });

  const access = new AccessService();
  controller = new AccessPublicController(access);
  const pricing = {
    calculatePrice: vi.fn().mockResolvedValue({
      basePrice: 0,
      appliedRules: [],
      calculatedBasePrice: 0,
      accessItems: [],
      accessTotal: 0,
      subtotal: 0,
      sponsorships: [],
      sponsorshipTotal: 0,
      total: 0,
      currency: "TND",
      droppedAccessItems: [],
    }),
  };
  registrations = new RegistrationCreateService(
    access,
    pricing as unknown as PricingService,
    { publicLinkAllowedOrigins: [] } as unknown as Config,
    new RegistrationSideEffects(access),
  );
});

async function offered(formData: Record<string, unknown>): Promise<string[]> {
  const grouped = await controller.grouped(
    { eventId: EVENT_ID },
    { formData, selectedAccessIds: [] },
  );
  const items = [
    ...grouped.groups.flatMap((g) => g.slots.flatMap((s) => s.items)),
    ...(grouped.addonGroup?.slots.flatMap((s) => s.items) ?? []),
  ] as Array<{ id: string }>;
  return items.map((i) => i.id).sort();
}

function create(formData: Record<string, unknown>, accessIds: string[]) {
  return registrations.createPublicRegistration("form1", {
    formData,
    email: "a@b.com",
    accessSelections: accessIds.map((accessId) => ({ accessId, quantity: 1 })),
  } as never);
}

describe("public access grouping sees only the answers the form shows", () => {
  it("does not offer an access conditioned on a hidden field's lingering answer", async () => {
    // Chose doctor, typed a specialty, then switched to nurse: the form hides
    // `specialty` but still sends its answer.
    expect(await offered({ profession: "nurse", specialty: "cardiology" })).toEqual([
      "nurse-lunch",
      "open-dinner",
    ]);
    const validation = await controller.validate(
      { eventId: EVENT_ID },
      {
        formData: { profession: "nurse", specialty: "cardiology" },
        selections: [{ accessId: "cardio-workshop", quantity: 1 }],
      },
    );
    expect(validation.valid).toBe(false);
  });

  it("offers it while the field is shown, including by a case-insensitive match", async () => {
    expect(await offered({ profession: "Doctor", specialty: "cardiology" })).toEqual([
      "cardio-workshop",
      "open-dinner",
    ]);
  });

  it("does not require answers the registrant has not given yet", async () => {
    expect(await offered({})).toEqual(["open-dinner"]);
  });
});

describe("public access grouping agrees with create", () => {
  it.each([
    { name: "lingering hidden answer", formData: { profession: "nurse", specialty: "cardiology" } },
    { name: "shown by a case-insensitive match", formData: { profession: "Doctor", specialty: "cardiology" } },
    { name: "answer that create trims", formData: { profession: "doctor", specialty: " cardiology " } },
    { name: "unknown keys", formData: { profession: "doctor", specialty: "x", injected: "cardiology" } },
  ])("$name: create accepts exactly what grouping offers", async ({ formData }) => {
    const offer = await offered(formData);

    await expect(create(formData, offer)).resolves.toMatchObject({ created: true });
    for (const rejected of ACCESS.map((a) => a.id).filter((id) => !offer.includes(id))) {
      await expect(create(formData, [rejected])).rejects.toMatchObject({
        code: ErrorCodes.BAD_REQUEST,
      });
    }
  });
});
