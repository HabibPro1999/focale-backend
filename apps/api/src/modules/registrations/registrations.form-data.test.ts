import { ErrorCodes, type EventPricingWithRules } from "@app/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyRegistrationSettlementInput, RegistrationPatch } from "@app/db";

// One pricing input (2.11): the public quote, public create/self-edit and
// admin create/edit all store and price the answers to the fields the form
// app shows. Pricing runs for real here (PricingService + the rule evaluator);
// only the DB layer is mocked.
const db = vi.hoisted(() => ({
  // pricing
  getFormForPriceQuote: vi.fn(),
  getEventPricingGate: vi.fn(),
  getEventPricing: vi.fn(),
  findEventAccessByIds: vi.fn(),
  findPendingSponsorships: vi.fn(),
  // registrations
  withTxn: vi.fn(),
  withLockingTxn: vi.fn(),
  lockRegistrationForUpdate: vi.fn(),
  applyRegistrationSettlement: vi.fn(),
  settleRegistrationTxn: vi.fn(),
  emitSettlementEvents: vi.fn(),
  findClientModuleState: vi.fn(),
  findActiveRegistrationFormById: vi.fn(),
  findFormById: vi.fn(),
  findRegistrationFormForEvent: vi.fn(),
  getRegistrationFormSchemaForEvent: vi.fn(),
  registrationExistsByEmailForm: vi.fn(),
  getEventForRegistrationCreate: vi.fn(),
  getEventForRegistrationAdmin: vi.fn(),
  allocateReferenceNumber: vi.fn(),
  insertRegistrationRow: vi.fn(),
  casIncrementRegisteredTx: vi.fn(),
  getEventCounterInfoTx: vi.fn(),
  insertAuditLog: vi.fn(),
  enqueueRealtimeOutboxEvent: vi.fn(),
  enqueueTriggeredEmailOutbox: vi.fn(),
  getRegistrationByIdRow: vi.fn(),
  findRegistrationForMutation: vi.fn(),
  findRegistrationWithFormEvent: vi.fn(),
  findRegistrationUsagesForRecalc: vi.fn(),
  syncNetworkingRegistration: vi.fn(),
}));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...db,
}));

// settleRegistrationTxn for a registration without sponsorship usages (the
// real one is DB-tested): the repriced breakdown and gross, the stored
// status, one writer call.
db.settleRegistrationTxn.mockImplementation(
  async (
    tx: unknown,
    registrationId: string,
    options: { priceBreakdown: { subtotal: number; sponsorshipTotal: number }; totalAmount: number; fields?: unknown },
  ) => {
    const sponsorship = Math.min(options.priceBreakdown.sponsorshipTotal, options.priceBreakdown.subtotal);
    const priceBreakdown = { ...options.priceBreakdown, sponsorshipTotal: sponsorship, total: options.priceBreakdown.subtotal - sponsorship };
    await db.applyRegistrationSettlement(tx, {
      registrationId,
      settlement: { priceBreakdown, totalAmount: options.totalAmount, sponsorshipAmount: sponsorship },
      fields: options.fields,
    });
    const after = { paymentStatus: "PENDING", paidAmount: 0, totalAmount: options.totalAmount, priceBreakdown };
    return { written: true, eventId: "ev1", before: after, after, coveredAccessIds: [], paidAccess: { incremented: [], decremented: [] } };
  },
);

// emitSettlementEvents with @app/db's body, over the mocked primitives.
db.emitSettlementEvents.mockImplementation(
  async (tx: unknown, events: Array<{ type: string; payload: { id: unknown } }>) => {
    const changed = new Set(
      events
        .filter((ev) => ev.type === "registration.updated" || ev.type === "registration.paymentConfirmed")
        .map((ev) => String(ev.payload.id)),
    );
    for (const id of changed) await db.syncNetworkingRegistration(id, tx);
    const results: unknown[] = [];
    for (const ev of events) results.push(await db.enqueueRealtimeOutboxEvent(tx, ev));
    return results;
  },
);

/**
 * The columns the settlement writer was asked to set by its call `n`: the
 * other fields, the settlement, and the amounts the writer derives from a
 * written breakdown.
 */
function writtenPatch(n = 0): RegistrationPatch {
  const input = db.applyRegistrationSettlement.mock.calls[n]?.[1] as ApplyRegistrationSettlementInput | undefined;
  if (!input) throw new Error(`applyRegistrationSettlement call ${n} not made`);
  const pb = input.settlement.priceBreakdown;
  return {
    ...input.fields,
    ...input.settlement,
    ...(pb
      ? {
          baseAmount: pb.calculatedBasePrice,
          accessAmount: pb.accessTotal,
          discountAmount: calculateDiscountAmount(pb.appliedRules),
        }
      : {}),
  };
}

import { calculateDiscountAmount } from "@app/shared";
import type { Config } from "../../core/config";
import type { AccessService } from "../access/access.service";
import { PricingPublicController } from "../pricing/pricing.public.controller";
import { PricingService } from "../pricing/pricing.service";
import { RegistrationsService } from "./registrations.service";
import { RegistrationSideEffects } from "./registrations.side-effects";

const FUTURE = new Date(Date.now() + 7 * 86_400_000);

// `memberId` is shown when member equals "YES" — the form app compares
// case-insensitively, so it shows for "yes". `promo` is shown for non-members.
const SCHEMA = {
  steps: [
    {
      id: "s1",
      title: "Profile",
      fields: [
        {
          id: "member",
          type: "radio",
          label: "Member",
          required: true,
          options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
        },
        {
          id: "memberId",
          type: "text",
          label: "Member ID",
          required: true,
          conditions: [{ id: "c1", fieldId: "member", operator: "equals", value: "YES" }],
        },
        {
          id: "promo",
          type: "text",
          label: "Promo code",
          conditions: [{ id: "c2", fieldId: "member", operator: "equals", value: "no" }],
        },
      ],
    },
  ],
};

const PRICING: EventPricingWithRules = {
  id: "pricing1",
  eventId: "ev1",
  basePrice: 300,
  currency: "TND",
  rules: [
    {
      id: "member-rate",
      name: "Member rate",
      price: 150,
      priority: 10,
      active: true,
      conditionLogic: "AND",
      conditions: [{ fieldId: "memberId", operator: "is_not_empty" }],
    },
    {
      id: "early",
      name: "Early promo",
      price: 200,
      priority: 5,
      active: true,
      conditionLogic: "AND",
      conditions: [{ fieldId: "promo", operator: "equals", value: "EARLY" }],
    },
  ],
  onlinePaymentEnabled: false,
  onlinePaymentUrl: null,
  cashPaymentEnabled: false,
  bankName: null,
  bankAccountName: null,
  bankAccountNumber: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as EventPricingWithRules;

const client = { active: true, enabledModules: ["registrations", "pricing"] };
const openEvent = { clientId: "c1", status: "OPEN", endDate: FUTURE, client };

let service: RegistrationsService;
let quote: PricingPublicController;
let access: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  db.withTxn.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
  db.withLockingTxn.mockImplementation((fn: (tx: unknown) => unknown) => db.withTxn(fn));
  db.lockRegistrationForUpdate.mockResolvedValue(true);
  db.findClientModuleState.mockResolvedValue(client);
  db.getEventPricingGate.mockResolvedValue({ status: "OPEN", client, currentCurrency: "TND" });
  db.getEventPricing.mockResolvedValue(PRICING);
  db.findEventAccessByIds.mockResolvedValue([]);
  db.findPendingSponsorships.mockResolvedValue([]);
  db.getFormForPriceQuote.mockResolvedValue({
    id: "form1",
    eventId: "ev1",
    type: "REGISTRATION",
    active: true,
    schema: SCHEMA,
    event: openEvent,
  });
  db.findActiveRegistrationFormById.mockResolvedValue({
    id: "form1",
    eventId: "ev1",
    schemaVersion: 1,
    schema: SCHEMA,
    event: openEvent,
  });
  db.findFormById.mockResolvedValue({ id: "form1", eventId: "ev1", schemaVersion: 1, schema: SCHEMA });
  db.findRegistrationFormForEvent.mockResolvedValue({ id: "form1", schemaVersion: 1 });
  db.getRegistrationFormSchemaForEvent.mockResolvedValue({ schema: SCHEMA });
  db.registrationExistsByEmailForm.mockResolvedValue(false);
  db.getEventForRegistrationCreate.mockResolvedValue({ ...openEvent, maxCapacity: null, registeredCount: 0 });
  db.getEventForRegistrationAdmin.mockResolvedValue({ ...openEvent, maxCapacity: null, registeredCount: 0 });
  db.allocateReferenceNumber.mockResolvedValue("26-EV-001");
  db.insertRegistrationRow.mockResolvedValue({ id: "reg1" });
  db.casIncrementRegisteredTx.mockResolvedValue(true);
  db.enqueueRealtimeOutboxEvent.mockResolvedValue(true);
  db.enqueueTriggeredEmailOutbox.mockResolvedValue(true);
  db.findRegistrationUsagesForRecalc.mockResolvedValue([]);
  db.applyRegistrationSettlement.mockResolvedValue(true);
  db.getRegistrationByIdRow.mockResolvedValue({
    id: "reg1",
    formId: "form1",
    eventId: "ev1",
    email: "a@b.com",
    formData: {},
    priceBreakdown: { accessItems: [] },
    accessTypeIds: [],
    editToken: "tok",
    accessCheckIns: [],
    form: { id: "form1", name: "Reg" },
    event: { id: "ev1", name: "Ev", slug: "ev", clientId: "c1" },
  });

  access = {
    validateAccessSelections: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
    assertAccessSelectionRequirement: vi.fn().mockResolvedValue(undefined),
    incrementAccessRegisteredCountTx: vi.fn().mockResolvedValue(undefined),
    decrementAccessRegisteredCountTx: vi.fn().mockResolvedValue(undefined),
    syncPaidCountDelta: vi.fn().mockResolvedValue(undefined),
    getAlreadyCoveredAccessIds: vi.fn().mockResolvedValue(new Set()),
    handleCapacityReached: vi.fn().mockResolvedValue(0),
  };
  const pricing = new PricingService();
  quote = new PricingPublicController(pricing);
  service = new RegistrationsService(
    access as unknown as AccessService,
    pricing,
    { publicLinkAllowedOrigins: [] } as unknown as Config,
    new RegistrationSideEffects(access as unknown as AccessService),
  );
});

function storedRow() {
  const row = db.insertRegistrationRow.mock.calls[0]?.[0] as {
    formData: Record<string, unknown>;
    totalAmount: number;
    priceBreakdown: { calculatedBasePrice: number; total: number; appliedRules: unknown[] };
  };
  expect(row).toBeDefined();
  return row;
}

describe("public quote equals the public create charge", () => {
  it.each([
    {
      name: "a stale answer to a hidden field does not price the quote",
      formData: { member: "no", memberId: "M-1", promo: "EARLY" },
      price: 200,
      stored: { member: "no", promo: "EARLY" },
    },
    {
      name: "a field the form shows by a case-insensitive match is priced by both",
      formData: { member: "yes", memberId: "M-1" },
      price: 150,
      stored: { member: "yes", memberId: "M-1" },
    },
    {
      name: "both price the trimmed answer that gets stored",
      formData: { member: "no", promo: " EARLY " },
      price: 200,
      stored: { member: "no", promo: "EARLY" },
    },
  ])("$name", async ({ formData, price, stored }) => {
    const quoted = await quote.calculatePrice(
      { formId: "form1" },
      { formData, selectedAccessItems: [], sponsorshipCodes: [] },
    );
    await service.createPublicRegistration("form1", {
      formData,
      email: "a@b.com",
      accessSelections: [],
    } as never);

    const row = storedRow();
    expect(quoted.total).toBe(price);
    expect(row.totalAmount).toBe(quoted.subtotal);
    expect(row.priceBreakdown).toMatchObject({
      calculatedBasePrice: quoted.calculatedBasePrice,
      appliedRules: quoted.appliedRules,
      total: quoted.total,
    });
    expect(row.formData).toEqual(stored);
  });

  it("both reject a missing answer to a required field the form shows", async () => {
    const formData = { member: "yes" };
    await expect(
      quote.calculatePrice({ formId: "form1" }, { formData, selectedAccessItems: [], sponsorshipCodes: [] }),
    ).rejects.toMatchObject({ code: ErrorCodes.FORM_VALIDATION_ERROR });
    await expect(
      service.createPublicRegistration("form1", { formData, email: "a@b.com", accessSelections: [] } as never),
    ).rejects.toMatchObject({ code: ErrorCodes.FORM_VALIDATION_ERROR });
    expect(db.insertRegistrationRow).not.toHaveBeenCalled();
  });
});

describe("public self-edit stores and prices the visible answers", () => {
  it("drops an answer the edit hides and prices what it stores", async () => {
    db.findRegistrationWithFormEvent.mockResolvedValue({
      id: "reg1",
      formId: "form1",
      eventId: "ev1",
      paymentStatus: "PENDING",
      paidAmount: 0,
      totalAmount: 150,
      sponsorshipAmount: 0,
      sponsorshipCode: null,
      paidAt: null,
      accessTypeIds: [],
      formData: { member: "yes", memberId: "M-1" },
      priceBreakdown: { accessItems: [] },
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      form: { id: "form1", name: "Reg", schema: SCHEMA },
      event: { id: "ev1", name: "Ev", slug: "ev", ...openEvent },
    });

    await service.editRegistrationPublic("reg1", {
      expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
      formData: { member: "no", promo: "EARLY" },
    } as never);

    const patch = writtenPatch() as {
      formData: Record<string, unknown>;
      totalAmount: number;
    };
    expect(patch.formData).toEqual({ member: "no", promo: "EARLY" });
    expect(patch.totalAmount).toBe(200);
  });
});

describe("admin create/edit validate without enforcing required answers", () => {
  const adminInput = (formData: Record<string, unknown>) =>
    ({
      email: "admin-made@example.com",
      firstName: "A",
      lastName: "B",
      formData,
      role: "PARTICIPANT",
      accessSelections: [],
      sendEmail: false,
    }) as never;

  it("create stores and prices only the visible answers", async () => {
    // memberId is required and shown, but admins may leave it blank.
    await service.createAdminRegistration("ev1", adminInput({ member: "yes", promo: "EARLY" }), "admin1");

    const row = storedRow();
    expect(row.formData).toEqual({ member: "yes" });
    expect(row.totalAmount).toBe(300);
  });

  it("create rejects an answer that is not a valid option", async () => {
    await expect(
      service.createAdminRegistration("ev1", adminInput({ member: "maybe" }), "admin1"),
    ).rejects.toMatchObject({ code: ErrorCodes.FORM_VALIDATION_ERROR, statusCode: 400 });
    expect(db.insertRegistrationRow).not.toHaveBeenCalled();
  });

  const current = {
    id: "reg1",
    formId: "form1",
    eventId: "ev1",
    email: "a@b.com",
    firstName: "A",
    lastName: "B",
    phone: null,
    role: "PARTICIPANT",
    note: null,
    paymentStatus: "PENDING",
    paymentMethod: null,
    paidAmount: 0,
    paidAt: null,
    totalAmount: 150,
    sponsorshipAmount: 0,
    sponsorshipCode: null,
    accessTypeIds: [],
    formData: { member: "yes", memberId: "M-1" },
    priceBreakdown: { accessItems: [] },
    event: { clientId: "c1", status: "OPEN", client },
  };

  it("edit stores and prices the cleaned answers", async () => {
    db.findRegistrationForMutation.mockResolvedValue(current);

    await service.adminEditRegistration(
      "ev1",
      "reg1",
      { formData: { member: "no", memberId: "M-1", promo: " EARLY " } } as never,
      "admin1",
    );

    const patch = writtenPatch() as {
      formData: Record<string, unknown>;
      totalAmount: number;
    };
    expect(patch.formData).toEqual({ member: "no", promo: "EARLY" });
    expect(patch.totalAmount).toBe(200);
  });

  it("an access-only edit prices the stored answers", async () => {
    db.findRegistrationForMutation.mockResolvedValue(current);

    await service.adminEditRegistration("ev1", "reg1", { accessSelections: [] } as never, "admin1");

    expect(db.getRegistrationFormSchemaForEvent).not.toHaveBeenCalled();
    const patch = writtenPatch() as {
      formData?: unknown;
      totalAmount: number;
    };
    expect(patch.formData).toBeUndefined();
    expect(patch.totalAmount).toBe(150);
  });
});
