import { ErrorCodes } from "@app/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyRegistrationSettlementInput, RegistrationPatch } from "@app/db";

// --- @app/db mock -----------------------------------------------------------
const db = vi.hoisted(() => ({
  withTxn: vi.fn(),
  withLockingTxn: vi.fn(),
  lockRegistrationForUpdate: vi.fn(),
  settleRegistrationTxn: vi.fn(),
  applyRegistrationSettlement: vi.fn(),
  emitSettlementEvents: vi.fn(),
  syncNetworkingRegistration: vi.fn(),
  enqueueRealtimeOutboxEvent: vi.fn(),
  enqueueTriggeredEmailOutbox: vi.fn(),
  casIncrementRegisteredTx: vi.fn(),
  casDecrementRegisteredTx: vi.fn(),
  getEventCounterInfoTx: vi.fn(),
  updateUsageAmount: vi.fn(),
  countUsagesForSponsorship: vi.fn(),
  updateSponsorshipRow: vi.fn(),
  findFormById: vi.fn(),
  findActiveRegistrationFormById: vi.fn(),
  findAccessDetailsByIds: vi.fn(),
  findClientModuleState: vi.fn(),
  searchRegistrantsForSponsorship: vi.fn(),
  getRegistrationByIdRow: vi.fn(),
  getRegistrationByIdempotencyKeyRow: vi.fn(),
  getRegistrationClientId: vi.fn(),
  getRegistrationEditToken: vi.fn(),
  getRegistrationEditLinkSource: vi.fn(),
  listRegistrationRows: vi.fn(),
  getEventForRegistrationCreate: vi.fn(),
  getEventForRegistrationAdmin: vi.fn(),
  findRegistrationFormForEvent: vi.fn(),
  registrationExistsByEmailForm: vi.fn(),
  findRegistrationForMutation: vi.fn(),
  findRegistrationWithFormEvent: vi.fn(),
  insertRegistrationRow: vi.fn(),
  deleteRegistrationRow: vi.fn(),
  getNetworkingProfilePhotoByRegistration: vi.fn(),
  findRegistrationUsagesForRecalc: vi.fn(),
  findRegistrationUsageLinks: vi.fn(),
  deleteRegistrationUsages: vi.fn(),
  allocateReferenceNumber: vi.fn(),
  insertAuditLog: vi.fn(),
  listRegistrationAuditLogRows: vi.fn(),
  findUserNamesByIds: vi.fn(),
  listRegistrationEmailLogRows: vi.fn(),
  getRegistrationFormSchemaForEvent: vi.fn(),
  pgUniqueViolation: (err: unknown) => {
    const e = err as { code?: unknown; constraint?: unknown } | null;
    return e?.code === "23505"
      ? { constraint: typeof e.constraint === "string" ? e.constraint : "" }
      : null;
  },
}));
vi.mock("@app/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@app/db")>();
  return {
    ...db,
    settlementEventPair: real.settlementEventPair,
    // The paid-count error classes are the real ones (mapped by class).
    AccessCapacityExceededError: real.AccessCapacityExceededError,
    AccessNotFoundError: real.AccessNotFoundError,
    AccessPaidCountUnderflowError: real.AccessPaidCountUnderflowError,
  };
});

/**
 * settleRegistrationTxn over the mocked rows (the real one is DB-tested in
 * packages/db), with its rules: usages recomputed against the breakdown (or
 * its sponsorshipTotal kept without usages), the caller's decision or the
 * derived status, paid places by the old → new delta, and one writer call
 * with the changed money columns.
 */
type SettleMockOptions = {
  priceBreakdown?: Record<string, unknown> & { subtotal: number; sponsorshipTotal: number; accessItems: unknown[]; calculatedBasePrice: number };
  totalAmount?: number;
  paidAmount?: number;
  paymentStatus?: string;
  paidAt?: Date | null;
  decide?: (state: Record<string, unknown>) => { paymentStatus?: string; paidAmount?: number; paidAt?: Date | null } | undefined;
  fields?: Record<string, unknown>;
};
db.settleRegistrationTxn.mockImplementation(async (tx: unknown, id: string, options: SettleMockOptions = {}) => {
  const row = await db.findRegistrationForMutation(id, tx);
  if (!row) return null;
  const before = {
    paymentStatus: row.paymentStatus,
    paidAt: row.paidAt ?? null,
    paidAmount: row.paidAmount,
    totalAmount: row.totalAmount,
    sponsorshipAmount: row.sponsorshipAmount,
    priceBreakdown: row.priceBreakdown,
  };
  const repriced = options.priceBreakdown !== undefined;
  const gross = options.priceBreakdown ?? before.priceBreakdown;
  const usages = (await db.findRegistrationUsagesForRecalc(id, tx)) ?? [];
  const covered = new Set<string>();
  let sponsorship = usages.length === 0 ? gross.sponsorshipTotal : 0;
  for (const usage of usages) {
    for (const accessId of usage.sponsorship.coveredAccessIds ?? []) covered.add(accessId);
    const amount = calculateApplicableAmount(usage.sponsorship, {
      totalAmount: gross.subtotal,
      baseAmount: gross.calculatedBasePrice,
      accessTypeIds: gross.accessItems.map((item: { accessId: string }) => item.accessId),
      priceBreakdown: gross,
    });
    sponsorship += amount;
    if (amount !== usage.amountApplied) await db.updateUsageAmount(tx, usage.id, amount);
  }
  sponsorship = Math.min(sponsorship, gross.subtotal);
  const priceBreakdown = netBreakdown(gross, sponsorship);
  const totalAmount = options.totalAmount ?? (repriced ? priceBreakdown.subtotal : before.totalAmount);
  const decision = options.decide?.({ before, gross: totalAmount, sponsorship, net: Math.max(0, totalAmount - sponsorship) }) ?? {
    paymentStatus: options.paymentStatus,
    paidAmount: options.paidAmount,
    paidAt: options.paidAt,
  };
  const paidAmount = decision.paidAmount ?? before.paidAmount;
  let paymentStatus: string;
  let paidAt: Date | null;
  if (decision.paymentStatus !== undefined) {
    paymentStatus = decision.paymentStatus;
    paidAt = decision.paidAt !== undefined ? decision.paidAt : before.paidAt;
  } else {
    const derived = deriveSettlement({
      gross: totalAmount,
      sponsorship,
      paid: paidAmount,
      currentStatus: before.paymentStatus,
      paidAt: before.paidAt,
      now: new Date(),
    });
    paymentStatus = derived.status;
    paidAt = derived.paidAt;
  }
  const oldPaid = paidAccessQuantities(before.paymentStatus, before.priceBreakdown, covered);
  const newPaid = paidAccessQuantities(paymentStatus, priceBreakdown, covered);
  const paidAccess = { incremented: [] as string[], decremented: [] as string[] };
  for (const accessId of new Set([...oldPaid.keys(), ...newPaid.keys()])) {
    const delta = (newPaid.get(accessId) ?? 0) - (oldPaid.get(accessId) ?? 0);
    if (delta > 0) paidAccess.incremented.push(accessId);
    if (delta < 0) paidAccess.decremented.push(accessId);
  }
  const settlement: Record<string, unknown> = {};
  if (repriced) Object.assign(settlement, { priceBreakdown, totalAmount, sponsorshipAmount: sponsorship });
  if (decision.paidAmount !== undefined) settlement.paidAmount = paidAmount;
  if (paymentStatus !== before.paymentStatus) settlement.paymentStatus = paymentStatus;
  if ((paidAt?.getTime() ?? null) !== (before.paidAt?.getTime() ?? null)) settlement.paidAt = paidAt;
  await db.applyRegistrationSettlement(tx, { registrationId: id, settlement, fields: options.fields });
  const after = { paymentStatus, paidAt, paidAmount, totalAmount, sponsorshipAmount: sponsorship, priceBreakdown };
  return { written: true, eventId: row.eventId, before, after, coveredAccessIds: [...covered], paidAccess };
});

// emitSettlementEvents with @app/db's body, over the mocked primitives.
db.emitSettlementEvents.mockImplementation(
  async (tx: unknown, events: Array<{ type: string; payload: { id: unknown } }>) => {
    const changed = new Set(
      events
        .filter((ev) => ev.type === "registration.updated" || ev.type === "registration.paymentConfirmed")
        .map((ev) => String(ev.payload.id)),
    );
    for (const id of changed) await db.syncNetworkingRegistration(id, tx);
    return Promise.all(events.map((ev) => db.enqueueRealtimeOutboxEvent(tx, ev)));
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

// --- @app/integrations + file-type mocks (payment-proof upload path) --------
const integ = vi.hoisted(() => ({
  getStorageProvider: vi.fn(),
  compressFile: vi.fn(),
}));
vi.mock("@app/integrations", async (importOriginal) => ({
  // Keep the real extractStorageKeyFromUrl (pure); stub the storage/IO fns.
  ...(await importOriginal<Record<string, unknown>>()),
  ...integ,
}));

const ft = vi.hoisted(() => ({ fileTypeFromBuffer: vi.fn() }));
vi.mock("file-type", () => ft);

import {
  calculateApplicableAmount,
  calculateDiscountAmount,
  calculateSettlement,
  deriveSettlement,
  netBreakdown,
  paidAccessQuantities,
} from "@app/shared";
import { validateSelections } from "../access/access-validation";
import { RegistrationsService } from "./registrations.service";
import { AppException } from "../../core/app-exception";
import type { Config } from "../../core/config";
import type { AccessService } from "../access/access.service";
import type { PricingService } from "../pricing/pricing.service";

const FUTURE = new Date(Date.now() + 86_400_000);

function emptyBreakdown(total = 0) {
  return {
    basePrice: total,
    appliedRules: [],
    calculatedBasePrice: total,
    accessItems: [],
    accessTotal: 0,
    subtotal: total,
    sponsorships: [],
    sponsorshipTotal: 0,
    total,
    currency: "TND",
    droppedAccessItems: [],
  };
}

/** A stored breakdown whose sponsorship matches the sponsorship_amount column. */
function sponsoredBreakdown(total: number, sponsorship: number) {
  return { ...emptyBreakdown(total), sponsorshipTotal: sponsorship, total: total - sponsorship };
}

function makeRegRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "reg1",
    formId: "form1",
    eventId: "ev1",
    email: "a@b.com",
    firstName: "A",
    lastName: "B",
    phone: null,
    paymentStatus: "PENDING",
    paidAmount: 0,
    totalAmount: 100,
    sponsorshipAmount: 0,
    sponsorshipCode: null,
    paidAt: null,
    note: null,
    role: "PARTICIPANT",
    accessTypeIds: [],
    formData: {},
    priceBreakdown: emptyBreakdown(100),
    editToken: "tok-64",
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    form: { id: "form1", name: "Reg Form" },
    event: { id: "ev1", name: "Ev", slug: "ev", clientId: "c1" },
    accessCheckIns: [],
    ...overrides,
  };
}

// Registration form with one free-text answer (admin create/edit load it).
const ANSWER_SCHEMA = {
  steps: [{ id: "s1", title: "Step", fields: [{ id: "answer", type: "text" }] }],
};

function activeClient() {
  return { active: true, enabledModules: ["registrations", "pricing"] };
}

describe("RegistrationsService", () => {
  let service: RegistrationsService;
  let access: {
    assertAccessSelectionRequirement: ReturnType<typeof vi.fn>;
    validateAccessSelections: ReturnType<typeof vi.fn>;
    incrementAccessRegisteredCountTx: ReturnType<typeof vi.fn>;
    decrementAccessRegisteredCountTx: ReturnType<typeof vi.fn>;
    syncPaidCountDelta: ReturnType<typeof vi.fn>;
    getAlreadyCoveredAccessIds: ReturnType<typeof vi.fn>;
    handleCapacityReached: ReturnType<typeof vi.fn>;
  };
  let pricing: { calculatePrice: ReturnType<typeof vi.fn> };
  let storage: {
    uploadPrivate: ReturnType<typeof vi.fn>;
    getSignedUrl: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db.withTxn.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
    db.withLockingTxn.mockImplementation((fn: (tx: unknown) => unknown) => db.withTxn(fn));
    db.lockRegistrationForUpdate.mockResolvedValue(true);
    db.enqueueRealtimeOutboxEvent.mockResolvedValue(true);
    db.enqueueTriggeredEmailOutbox.mockResolvedValue(true);
    db.casIncrementRegisteredTx.mockResolvedValue(true);
    db.casDecrementRegisteredTx.mockResolvedValue(true);
    db.allocateReferenceNumber.mockResolvedValue("26-EV-001");
    db.insertAuditLog.mockResolvedValue(undefined);
    db.applyRegistrationSettlement.mockResolvedValue(true);
    db.findAccessDetailsByIds.mockResolvedValue([]);
    db.findClientModuleState.mockResolvedValue(activeClient());
    db.findRegistrationUsagesForRecalc.mockResolvedValue([]);
    db.getRegistrationFormSchemaForEvent.mockResolvedValue({ schema: ANSWER_SCHEMA });

    ft.fileTypeFromBuffer.mockResolvedValue({ mime: "application/pdf", ext: "pdf" });
    integ.compressFile.mockResolvedValue({
      buffer: Buffer.from("x"),
      contentType: "application/pdf",
      ext: "pdf",
    });
    storage = {
      uploadPrivate: vi.fn().mockResolvedValue("event/reg1/proof.pdf"),
      getSignedUrl: vi.fn().mockResolvedValue("https://signed"),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    integ.getStorageProvider.mockReturnValue(storage);

    access = {
      assertAccessSelectionRequirement: vi.fn().mockResolvedValue(undefined),
      validateAccessSelections: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
      incrementAccessRegisteredCountTx: vi.fn().mockResolvedValue(undefined),
      decrementAccessRegisteredCountTx: vi.fn().mockResolvedValue(undefined),
      syncPaidCountDelta: vi.fn().mockResolvedValue(undefined),
      handleCapacityReached: vi.fn().mockResolvedValue(0),
      getAlreadyCoveredAccessIds: vi.fn().mockResolvedValue(new Set()),
    };
    pricing = { calculatePrice: vi.fn().mockResolvedValue(emptyBreakdown(100)) };

    service = new RegistrationsService(
      access as unknown as AccessService,
      pricing as unknown as PricingService,
      {
        publicLinkAllowedOrigins: ["https://events.example.com"],
      } as Config,
    );
  });

  // ---- verifyEditToken -----------------------------------------------------
  describe("verifyEditToken", () => {
    const token = "a".repeat(64);
    it("true for the matching token", async () => {
      db.getRegistrationEditToken.mockResolvedValue({ editToken: token });
      expect(await service.verifyEditToken("reg1", token)).toBe(true);
    });
    it("false for a wrong token of equal length", async () => {
      db.getRegistrationEditToken.mockResolvedValue({ editToken: token });
      expect(await service.verifyEditToken("reg1", "b".repeat(64))).toBe(false);
    });
    it("false when no token is stored", async () => {
      db.getRegistrationEditToken.mockResolvedValue({ editToken: null });
      expect(await service.verifyEditToken("reg1", token)).toBe(false);
    });
    it("false on a length mismatch (timingSafeEqual throws → caught)", async () => {
      db.getRegistrationEditToken.mockResolvedValue({ editToken: token });
      expect(await service.verifyEditToken("reg1", "short")).toBe(false);
    });
  });

  // ---- getRegistrationById -------------------------------------------------
  describe("getRegistrationById", () => {
    it("strips editToken and idempotencyKey", async () => {
      db.getRegistrationByIdRow.mockResolvedValue(makeRegRow({ idempotencyKey: "idem-key-1" }));
      const result = await service.getRegistrationById("reg1");
      expect(result).not.toBeNull();
      expect("editToken" in (result as object)).toBe(false);
      expect("idempotencyKey" in (result as object)).toBe(false);
    });
    it("returns null when missing", async () => {
      db.getRegistrationByIdRow.mockResolvedValue(null);
      expect(await service.getRegistrationById("nope")).toBeNull();
    });
  });

  describe("getRegistrationByIdempotencyKey", () => {
    it("keeps editToken (for the token rename)", async () => {
      db.getRegistrationByIdempotencyKeyRow.mockResolvedValue(makeRegRow());
      const result = await service.getRegistrationByIdempotencyKey("k");
      expect(result?.editToken).toBe("tok-64");
    });
  });

  // ---- listRegistrations stats bucketing -----------------------------------
  describe("listRegistrations", () => {
    it("buckets stats (paid uses paidAmount; refunded counted but unbucketed)", async () => {
      db.listRegistrationRows.mockResolvedValue({
        rows: [],
        total: 4,
        stats: [
          { paymentStatus: "PAID", cnt: 1, totalAmount: 100, paidAmount: 90 },
          { paymentStatus: "PENDING", cnt: 1, totalAmount: 50, paidAmount: 0 },
          { paymentStatus: "SPONSORED", cnt: 1, totalAmount: 70, paidAmount: 0 },
          { paymentStatus: "REFUNDED", cnt: 1, totalAmount: 30, paidAmount: 0 },
        ],
      });
      const res = await service.listRegistrations("ev1", { page: 1, limit: 20 } as never);
      expect(res.stats.total).toBe(4);
      expect(res.stats.totalAmount).toBe(250);
      expect(res.stats.paid).toEqual({ count: 1, amount: 90 });
      expect(res.stats.pending).toEqual({ count: 1, amount: 50 });
      expect(res.stats.sponsored).toEqual({ count: 1, amount: 70 });
    });
  });

  // ---- createAdminRegistration --------------------------------------------
  describe("createAdminRegistration", () => {
    beforeEach(() => {
      db.findRegistrationFormForEvent.mockResolvedValue({
        id: "form1",
        eventId: "ev1",
        schemaVersion: 3,
      });
      db.registrationExistsByEmailForm.mockResolvedValue(false);
      db.getEventForRegistrationAdmin.mockResolvedValue({
        id: "ev1",
        clientId: "c1",
        status: "OPEN",
        endDate: FUTURE,
        maxCapacity: null,
        registeredCount: 0,
        client: activeClient(),
      });
      db.insertRegistrationRow.mockResolvedValue({ id: "reg1" });
      db.getRegistrationByIdRow.mockResolvedValue(makeRegRow());
    });

    it("sets paidAmount to the net price when created as PAID", async () => {
      await service.createAdminRegistration(
        "ev1",
        {
          email: "paid@example.com",
          firstName: "Paid",
          lastName: "Registrant",
          formData: {},
          paymentStatus: "PAID",
          accessSelections: [],
        } as never,
        "admin1",
      );

      expect(db.insertRegistrationRow.mock.calls[0]?.[0]).toMatchObject({
        paymentStatus: "PAID",
        totalAmount: 100,
        paidAmount: 100,
      });
    });
  });

  // ---- createRegistration --------------------------------------------------
  describe("createRegistration", () => {
    const baseInput = {
      formId: "form1",
      formData: {},
      email: "New@Example.com",
      accessSelections: [] as { accessId: string; quantity: number }[],
    };

    beforeEach(() => {
      db.findFormById.mockResolvedValue({ id: "form1", eventId: "ev1", schemaVersion: 3 });
      db.registrationExistsByEmailForm.mockResolvedValue(false);
      db.getEventForRegistrationCreate.mockResolvedValue({
        clientId: "c1",
        status: "OPEN",
        endDate: FUTURE,
        maxCapacity: null,
        registeredCount: 0,
        client: activeClient(),
      });
      db.insertRegistrationRow.mockResolvedValue({ id: "reg1" });
      db.getRegistrationByIdRow.mockResolvedValue(makeRegRow());
    });

    it("enforces a required option before persisting a public registration", async () => {
      db.findFormById.mockResolvedValue({ id: "form1", eventId: "ev1", schemaVersion: 3, schema: { settings: { accessSelectionRequired: true } } });
      access.assertAccessSelectionRequirement.mockRejectedValue(new AppException(ErrorCodes.ACCESS_SELECTION_REQUIRED, "Choose an option", 400));
      await expect(service.createRegistration(baseInput as never, emptyBreakdown(100)))
        .rejects.toMatchObject({ code: ErrorCodes.ACCESS_SELECTION_REQUIRED });
      expect(access.assertAccessSelectionRequirement).toHaveBeenCalledWith("ev1", {}, [], { accessSelectionRequired: true });
      expect(db.insertRegistrationRow).not.toHaveBeenCalled();
    });

    it("rejects a public linkBaseUrl outside the configured origins", async () => {
      await expect(
        service.createRegistration(
          { ...baseInput, linkBaseUrl: "https://evil.example" } as never,
          emptyBreakdown(100),
        ),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: ErrorCodes.VALIDATION_ERROR,
      });
      expect(db.findFormById).not.toHaveBeenCalled();
      expect(db.insertRegistrationRow).not.toHaveBeenCalled();
    });

    it("stores gross total so a 40 sponsorship on 100 leaves 60 due", async () => {
      await service.createRegistration(baseInput as never, {
        ...emptyBreakdown(100), sponsorshipTotal: 40, total: 60,
      });
      const stored = db.insertRegistrationRow.mock.calls[0][0];
      expect(stored).toMatchObject({ totalAmount: 100, sponsorshipAmount: 40 });
      expect(calculateSettlement({ ...stored, paidAmount: 0 }).amountDue).toBe(60);
    });

    it("creates, reserves nothing when no access, increments event, audits, emits, queues email", async () => {
      const result = await service.createRegistration(baseInput as never, emptyBreakdown(100));
      expect(result.id).toBe("reg1");
      expect(db.insertRegistrationRow).toHaveBeenCalledTimes(1);
      // email normalized lowercase on insert
      expect(db.insertRegistrationRow.mock.calls[0][0].email).toBe("new@example.com");
      expect(db.casIncrementRegisteredTx).toHaveBeenCalledTimes(1);
      // realtime: registration.created only (no access) — first enqueue call
      expect(db.enqueueRealtimeOutboxEvent.mock.calls[0][1].type).toBe(
        "registration.created",
      );
      expect(db.enqueueTriggeredEmailOutbox).toHaveBeenCalledTimes(1);
    });

    it("reserves access + emits countsChanged with REAL accessIds", async () => {
      const input = {
        ...baseInput,
        accessSelections: [{ accessId: "acc1", quantity: 2 }],
      } as never;
      await service.createRegistration(input, emptyBreakdown(100));
      expect(access.incrementAccessRegisteredCountTx).toHaveBeenCalledWith(
        "acc1",
        2,
        expect.anything(),
      );
      const countsEvt = db.enqueueRealtimeOutboxEvent.mock.calls.find(
        (c) => c[1].type === "eventAccess.countsChanged",
      );
      expect(countsEvt?.[1].payload.accessIds).toEqual(["acc1"]);
    });

    it("409 on duplicate email+form", async () => {
      db.registrationExistsByEmailForm.mockResolvedValue(true);
      await expect(
        service.createRegistration(baseInput as never, emptyBreakdown(100)),
      ).rejects.toMatchObject({ code: "REG_8002", statusCode: 409 });
    });

    it("404 when form missing", async () => {
      db.findFormById.mockResolvedValue(null);
      await expect(
        service.createRegistration(baseInput as never, emptyBreakdown(100)),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("409 EVENT_FULL at capacity", async () => {
      db.getEventForRegistrationCreate.mockResolvedValue({
        clientId: "c1",
        status: "OPEN",
        endDate: FUTURE,
        maxCapacity: 5,
        registeredCount: 5,
        client: activeClient(),
      });
      await expect(
        service.createRegistration(baseInput as never, emptyBreakdown(100)),
      ).rejects.toMatchObject({ code: "EVT_8002", statusCode: 409 });
    });

    it("400 when LAB_SPONSORSHIP but sponsorships module enabled", async () => {
      db.getEventForRegistrationCreate.mockResolvedValue({
        clientId: "c1",
        status: "OPEN",
        endDate: FUTURE,
        maxCapacity: null,
        registeredCount: 0,
        client: { active: true, enabledModules: ["registrations", "pricing", "sponsorships"] },
      });
      const input = { ...baseInput, paymentMethod: "LAB_SPONSORSHIP", labName: "X" } as never;
      await expect(
        service.createRegistration(input, emptyBreakdown(100)),
      ).rejects.toMatchObject({ code: "RES_3003", statusCode: 400 });
    });

    it("propagates outbox enqueue failure (rolls back)", async () => {
      db.enqueueTriggeredEmailOutbox.mockRejectedValue(new Error("boom"));
      await expect(
        service.createRegistration(baseInput as never, emptyBreakdown(100)),
      ).rejects.toThrow("boom");
    });

    it("maps an email+form 23505 race to REGISTRATION_ALREADY_EXISTS", async () => {
      db.insertRegistrationRow.mockRejectedValue({
        code: "23505",
        constraint: "registrations_email_form_id_key",
      });
      await expect(
        service.createRegistration(baseInput as never, emptyBreakdown(100)),
      ).rejects.toMatchObject({ code: "REG_8002", statusCode: 409 });
    });
  });

  // ---- createPublicRegistration idempotency --------------------------------
  describe("createPublicRegistration", () => {
    it("short-circuits to created=false when idempotencyKey already exists", async () => {
      db.getRegistrationByIdempotencyKeyRow.mockResolvedValue(makeRegRow());
      const res = await service.createPublicRegistration("form1", {
        idempotencyKey: "11111111-1111-1111-1111-111111111111",
        formData: {},
        email: "a@b.com",
        accessSelections: [],
      } as never);
      expect(res.created).toBe(false);
      expect(res.registration.token).toBe("tok-64");
      expect(db.findActiveRegistrationFormById).not.toHaveBeenCalled();
    });

    it("recovers a create-time idempotency 23505 race to created=false/200", async () => {
      db.getRegistrationByIdempotencyKeyRow
        .mockResolvedValueOnce(null) // short-circuit miss
        .mockResolvedValueOnce(makeRegRow()); // recovery hit
      db.findActiveRegistrationFormById.mockResolvedValue({
        id: "form1",
        eventId: "ev1",
        schemaVersion: 1,
        schema: { steps: [{ fields: [] }] },
        active: true,
        type: "REGISTRATION",
        event: { clientId: "c1", status: "OPEN", endDate: FUTURE },
      });
      db.findFormById.mockResolvedValue({ id: "form1", eventId: "ev1", schemaVersion: 1 });
      db.registrationExistsByEmailForm.mockResolvedValue(false);
      db.getEventForRegistrationCreate.mockResolvedValue({
        clientId: "c1",
        status: "OPEN",
        endDate: FUTURE,
        maxCapacity: null,
        registeredCount: 0,
        client: activeClient(),
      });
      db.insertRegistrationRow.mockRejectedValue({
        code: "23505",
        constraint: "registrations_idempotency_key_key",
      });

      const res = await service.createPublicRegistration("form1", {
        idempotencyKey: "11111111-1111-1111-1111-111111111111",
        formData: {},
        email: "a@b.com",
        accessSelections: [],
      } as never);
      expect(res.created).toBe(false);
      expect(res.registration.token).toBe("tok-64");
    });
  });

  // ---- updateRegistration --------------------------------------------------
  describe("updateRegistration", () => {
    beforeEach(() => {
      db.findRegistrationForMutation.mockResolvedValue(
        makeRegRow({
          event: { clientId: "c1", status: "OPEN", client: activeClient() },
        }),
      );
      db.getRegistrationByIdRow.mockResolvedValue(makeRegRow());
    });

    it("locks the registration before reading it", async () => {
      await service.updateRegistration("reg1", { note: "hi" } as never, "admin1");
      expect(db.withLockingTxn).toHaveBeenCalledTimes(1);
      const [lock] = db.lockRegistrationForUpdate.mock.invocationCallOrder;
      const [read] = db.findRegistrationForMutation.mock.invocationCallOrder;
      expect(lock).toBeLessThan(read!);
    });

    it("updates a note and audits", async () => {
      await service.updateRegistration("reg1", { note: "hi" } as never, "admin1");
      expect(db.applyRegistrationSettlement).toHaveBeenCalled();
      expect(db.insertAuditLog).toHaveBeenCalled();
    });

    it("404 when registration not found", async () => {
      db.findRegistrationForMutation.mockResolvedValue(null);
      await expect(
        service.updateRegistration("x", { note: "hi" } as never),
      ).rejects.toMatchObject({ code: "REG_8001", statusCode: 404 });
    });

    it("rejects an invalid payment transition (WAIVED→PAID)", async () => {
      db.findRegistrationForMutation.mockResolvedValue(
        makeRegRow({
          paymentStatus: "WAIVED",
          event: { clientId: "c1", status: "OPEN", client: activeClient() },
        }),
      );
      await expect(
        service.updateRegistration("reg1", { paymentStatus: "PAID" } as never),
      ).rejects.toMatchObject({ code: "STT_12002", statusCode: 400 });
    });

    it("emits EMPTY accessIds on countsChanged when status changes", async () => {
      await service.updateRegistration("reg1", { paymentStatus: "PAID" } as never);
      const countsEvt = db.enqueueRealtimeOutboxEvent.mock.calls.find(
        (c) => c[1].type === "eventAccess.countsChanged",
      );
      expect(countsEvt?.[1].payload.accessIds).toEqual([]);
    });

    // Decision after 2.6a: `PATCH /registrations/:id` with `{}` used to fail
    // with a 500 (nothing to write); it now changes nothing.
    it("returns the registration unchanged for an empty body: no write, audit or event", async () => {
      const result = await service.updateRegistration("reg1", {} as never, "admin1");
      expect(result).toMatchObject({ id: "reg1", paymentStatus: "PENDING" });
      expect(result).not.toHaveProperty("editToken");
      expect(db.withLockingTxn).not.toHaveBeenCalled();
      expect(db.applyRegistrationSettlement).not.toHaveBeenCalled();
      expect(db.insertAuditLog).not.toHaveBeenCalled();
      expect(db.enqueueRealtimeOutboxEvent).not.toHaveBeenCalled();
      expect(db.syncNetworkingRegistration).not.toHaveBeenCalled();
    });

    it("404 for an empty body on a missing registration", async () => {
      db.getRegistrationByIdRow.mockResolvedValue(null);
      await expect(service.updateRegistration("x", {} as never)).rejects.toMatchObject({
        code: "REG_8001",
        statusCode: 404,
      });
    });

    it("defaults PAID to the net amount after sponsorship", async () => {
      db.findRegistrationForMutation.mockResolvedValue(
        makeRegRow({
          paymentStatus: "PARTIAL",
          paidAmount: 20,
          totalAmount: 100,
          sponsorshipAmount: 40,
          event: { clientId: "c1", status: "OPEN", client: activeClient() },
        }),
      );

      await service.updateRegistration("reg1", { paymentStatus: "PAID" } as never);

      expect(writtenPatch()).toMatchObject({
        paymentStatus: "PAID",
        paidAmount: 60,
      });
    });
  });

  // ---- adminEditRegistration ----------------------------------------------
  describe("adminEditRegistration", () => {
    const adminRow = (overrides: Record<string, unknown> = {}) =>
      makeRegRow({
        event: {
          id: "ev1",
          clientId: "c1",
          status: "OPEN",
          client: activeClient(),
        },
        ...overrides,
      });

    beforeEach(() => {
      db.findRegistrationForMutation.mockResolvedValue(adminRow());
      db.getRegistrationByIdRow.mockResolvedValue(adminRow());
      db.findRegistrationUsagesForRecalc.mockResolvedValue([]);
      pricing.calculatePrice.mockResolvedValue(emptyBreakdown(100));
    });

    it("locks the registration before reading it", async () => {
      await service.adminEditRegistration("ev1", "reg1", { note: "n" } as never, "admin1");
      expect(db.withLockingTxn).toHaveBeenCalledTimes(1);
      const [lock] = db.lockRegistrationForUpdate.mock.invocationCallOrder;
      const [read] = db.findRegistrationForMutation.mock.invocationCallOrder;
      expect(lock).toBeLessThan(read!);
    });

    it("refuses to move a REFUNDED registration to another status (admin override)", async () => {
      db.findRegistrationForMutation.mockResolvedValue(adminRow({ paymentStatus: "REFUNDED" }));
      await expect(
        service.adminEditRegistration("ev1", "reg1", { paymentStatus: "PAID" } as never, "admin1"),
      ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PAYMENT_TRANSITION, statusCode: 400 });
      expect(db.applyRegistrationSettlement).not.toHaveBeenCalled();
    });

    it("still lets an admin override a status the payment paths refuse (PAID → PENDING)", async () => {
      db.findRegistrationForMutation.mockResolvedValue(
        adminRow({ paymentStatus: "PAID", paidAmount: 100 }),
      );
      await service.adminEditRegistration("ev1", "reg1", { paymentStatus: "PENDING" } as never, "admin1");
      expect(writtenPatch().paymentStatus).toBe("PENDING");
    });

    describe("price edit of a PAID registration", () => {
      const paidRow = () =>
        adminRow({
          paymentStatus: "PAID",
          paidAmount: 100,
          paidAt: new Date("2026-01-01T00:00:00.000Z"),
        });
      const repriced = { formData: { answer: "repriced" } };

      beforeEach(() => {
        db.findRegistrationForMutation.mockResolvedValue(paidRow());
        pricing.calculatePrice.mockResolvedValue(emptyBreakdown(150));
      });

      it("409 PAYMENT_ADJUSTMENT_REQUIRED when the net changes without an amount or status", async () => {
        await expect(
          service.adminEditRegistration("ev1", "reg1", repriced as never, "admin1"),
        ).rejects.toMatchObject({
          code: ErrorCodes.PAYMENT_ADJUSTMENT_REQUIRED,
          statusCode: 409,
          details: { currentNet: 100, newNet: 150, paidAmount: 100 },
        });
        expect(db.applyRegistrationSettlement).not.toHaveBeenCalled();
        expect(db.insertAuditLog).not.toHaveBeenCalled();
        expect(db.enqueueRealtimeOutboxEvent).not.toHaveBeenCalled();
      });

      it("keeps PAID with the new net as the amount collected", async () => {
        await service.adminEditRegistration("ev1", "reg1", { ...repriced, paidAmount: 150 } as never, "admin1");
        const patch = writtenPatch();
        expect(patch).toMatchObject({ totalAmount: 150, paidAmount: 150 });
        expect(patch.paymentStatus).toBeUndefined();
        expect(db.insertAuditLog.mock.calls[0]![0].changes).toMatchObject({
          paidAmount: { old: 100, new: 150 },
          totalAmount: { old: 100, new: 150 },
        });
      });

      it("defaults an explicit PAID to the new net", async () => {
        await service.adminEditRegistration("ev1", "reg1", { ...repriced, paymentStatus: "PAID" } as never, "admin1");
        expect(writtenPatch()).toMatchObject({ totalAmount: 150, paidAmount: 150 });
      });

      it("moves to PARTIAL when the admin says so, keeping the amount paid", async () => {
        await service.adminEditRegistration("ev1", "reg1", { ...repriced, paymentStatus: "PARTIAL" } as never, "admin1");
        const patch = writtenPatch();
        expect(patch).toMatchObject({ totalAmount: 150, paymentStatus: "PARTIAL" });
        expect(patch.paidAmount).toBeUndefined();
      });

      it("400 PAID_AMOUNT_BELOW_DUE when it would stay PAID with less than the new net", async () => {
        await expect(
          service.adminEditRegistration("ev1", "reg1", { ...repriced, paidAmount: 120 } as never, "admin1"),
        ).rejects.toMatchObject({
          code: ErrorCodes.PAID_AMOUNT_BELOW_DUE,
          statusCode: 400,
          details: { amountDue: 150, paidAmount: 120 },
        });
        expect(db.applyRegistrationSettlement).not.toHaveBeenCalled();
      });

      it("needs no adjustment when the net does not change", async () => {
        pricing.calculatePrice.mockResolvedValue(emptyBreakdown(100));
        await service.adminEditRegistration("ev1", "reg1", repriced as never, "admin1");
        const patch = writtenPatch();
        expect(patch).toMatchObject({ totalAmount: 100, formData: { answer: "repriced" } });
        expect(patch.paymentStatus).toBeUndefined();
        expect(patch.paidAmount).toBeUndefined();
      });
    });

    it("prices without sponsorship codes and keeps an unlinked signup sponsorship", async () => {
      db.findRegistrationForMutation.mockResolvedValue(
        adminRow({
          sponsorshipCode: "SIGNUP-CODE",
          sponsorshipAmount: 40,
          priceBreakdown: sponsoredBreakdown(100, 40),
        }),
      );
      pricing.calculatePrice.mockResolvedValue(emptyBreakdown(120));

      await service.adminEditRegistration("ev1", "reg1", { formData: { answer: "x" } } as never, "admin1");

      expect(pricing.calculatePrice).toHaveBeenCalledWith(
        "ev1",
        expect.objectContaining({ sponsorshipCodes: [] }),
        expect.anything(),
      );
      expect(writtenPatch()).toMatchObject({
        totalAmount: 120,
        sponsorshipAmount: 40,
        priceBreakdown: expect.objectContaining({ subtotal: 120, sponsorshipTotal: 40, total: 80 }),
      });
    });

    it("moves the access registered counters by the quantity delta only", async () => {
      db.findRegistrationForMutation.mockResolvedValue(
        adminRow({
          accessTypeIds: ["acc-b", "acc-a", "acc-c"],
          priceBreakdown: {
            ...emptyBreakdown(100),
            accessItems: [
              { accessId: "acc-b", quantity: 1, subtotal: 0 },
              { accessId: "acc-a", quantity: 2, subtotal: 0 },
              { accessId: "acc-c", quantity: 1, subtotal: 0 },
            ],
          },
        }),
      );

      await service.adminEditRegistration(
        "ev1",
        "reg1",
        {
          accessSelections: [
            { accessId: "acc-d", quantity: 1 },
            { accessId: "acc-c", quantity: 1 },
            { accessId: "acc-a", quantity: 3 },
          ],
        } as never,
        "admin1",
      );

      // acc-c is unchanged: no counter move (it could be full).
      expect(access.incrementAccessRegisteredCountTx.mock.calls).toEqual([
        ["acc-a", 1, expect.anything()],
        ["acc-d", 1, expect.anything()],
      ]);
      expect(access.decrementAccessRegisteredCountTx.mock.calls).toEqual([["acc-b", 1, expect.anything()]]);
      expect(writtenPatch().accessTypeIds).toEqual(["acc-d", "acc-c", "acc-a"]);
    });

    it("keeps VERIFYING while sponsorship settlement is recalculated", async () => {
      db.findRegistrationForMutation.mockResolvedValue(
        adminRow({ paymentStatus: "VERIFYING", paidAmount: 0 }),
      );
      db.findRegistrationUsagesForRecalc.mockResolvedValue([
        {
          id: "usage1",
          amountApplied: 0,
          sponsorship: { coversBasePrice: true, coveredAccessIds: [], totalAmount: 100 },
        },
      ]);

      await service.adminEditRegistration(
        "ev1",
        "reg1",
        { formData: { answer: "sponsored" } } as never,
        "admin1",
      );

      expect(writtenPatch()).toMatchObject({ sponsorshipAmount: 100 });
      expect(writtenPatch().paymentStatus).toBeUndefined();
      const event = db.enqueueRealtimeOutboxEvent.mock.calls
        .map((call) => call[1])
        .find((candidate) => candidate.type === "registration.updated");
      expect(event?.payload.paymentStatus).toBe("VERIFYING");
    });

    it("emits the settlement-derived status after an admin price edit", async () => {
      // A linked sponsorship covering the base price: fully sponsored.
      db.findRegistrationUsagesForRecalc.mockResolvedValue([
        {
          id: "usage1",
          amountApplied: 0,
          sponsorship: { coversBasePrice: true, coveredAccessIds: [], totalAmount: 100 },
        },
      ]);

      await service.adminEditRegistration(
        "ev1",
        "reg1",
        { formData: { answer: "sponsored" } } as never,
        "admin1",
      );

      expect(writtenPatch()).toMatchObject({ paymentStatus: "SPONSORED", sponsorshipAmount: 100 });
      const event = db.enqueueRealtimeOutboxEvent.mock.calls
        .map((call) => call[1])
        .find((candidate) => candidate.type === "registration.paymentConfirmed");
      expect(event?.payload.paymentStatus).toBe("SPONSORED");
      expect(db.insertAuditLog.mock.calls[0]![0].changes.paymentStatus).toEqual({ old: "PENDING", new: "SPONSORED" });
    });

    it("defaults payment-only PAID edits to the current net amount", async () => {
      db.findRegistrationForMutation.mockResolvedValue(
        adminRow({
          paymentStatus: "PARTIAL",
          paidAmount: 20,
          totalAmount: 100,
          sponsorshipAmount: 40,
        }),
      );

      await service.adminEditRegistration(
        "ev1",
        "reg1",
        { paymentStatus: "PAID" } as never,
        "admin1",
      );

      expect(writtenPatch()).toMatchObject({
        paymentStatus: "PAID",
        paidAmount: 60,
      });
    });

    it("defaults combined PAID repricing edits to the final net after sponsorship", async () => {
      db.findRegistrationForMutation.mockResolvedValue(
        adminRow({
          paymentStatus: "PENDING",
          paidAmount: 0,
          totalAmount: 100,
          sponsorshipAmount: 40,
        }),
      );
      db.findRegistrationUsagesForRecalc.mockResolvedValue([
        {
          id: "usage1",
          amountApplied: 40,
          sponsorship: {
            coversBasePrice: true,
            coveredAccessIds: [],
            totalAmount: 60,
          },
        },
      ]);
      pricing.calculatePrice.mockResolvedValue({
        ...emptyBreakdown(150),
        basePrice: 120,
        calculatedBasePrice: 120,
      });

      await service.adminEditRegistration(
        "ev1",
        "reg1",
        { paymentStatus: "PAID", formData: { answer: "repriced" } } as never,
        "admin1",
      );

      expect(db.updateUsageAmount).toHaveBeenCalledWith(expect.anything(), "usage1", 60);
      expect(writtenPatch()).toMatchObject({
        paymentStatus: "PAID",
        totalAmount: 150,
        sponsorshipAmount: 60,
        paidAmount: 90,
      });
    });

    it("preserves an explicitly supplied paid amount", async () => {
      db.findRegistrationForMutation.mockResolvedValue(
        adminRow({
          paymentStatus: "PENDING",
          totalAmount: 100,
          sponsorshipAmount: 40,
        }),
      );

      await service.adminEditRegistration(
        "ev1",
        "reg1",
        { paymentStatus: "PAID", paidAmount: 55 } as never,
        "admin1",
      );

      expect(writtenPatch().paidAmount).toBe(55);
    });
  });

  // ---- deleteRegistration --------------------------------------------------
  describe("deleteRegistration", () => {
    beforeEach(() => {
      db.findRegistrationForMutation.mockResolvedValue(
        makeRegRow({
          event: { clientId: "c1", status: "OPEN", client: activeClient() },
        }),
      );
      db.findRegistrationUsageLinks.mockResolvedValue([]);
      db.getNetworkingProfilePhotoByRegistration.mockResolvedValue(null);
    });

    it("deletes an unpaid registration and emits REAL accessIds", async () => {
      db.findRegistrationForMutation.mockResolvedValue(
        makeRegRow({
          priceBreakdown: {
            ...emptyBreakdown(100),
            accessItems: [
              { accessId: "acc1", name: "A", unitPrice: 10, quantity: 1, subtotal: 10 },
            ],
          },
          event: { clientId: "c1", status: "OPEN", client: activeClient() },
        }),
      );
      await service.deleteRegistration("reg1", "admin1");
      expect(db.deleteRegistrationRow).toHaveBeenCalledWith("reg1", expect.anything());
      const countsEvt = db.enqueueRealtimeOutboxEvent.mock.calls.find(
        (c) => c[1].type === "eventAccess.countsChanged",
      );
      expect(countsEvt?.[1].payload.accessIds).toEqual(["acc1"]);
    });

    it.each([
      ["https://assets.example/networking/ev1/profiles/np1/photo.webp", "networking/ev1/profiles/np1/photo.webp"],
      ["https://assets.example/forms/uploads/registrant-photo.webp", null],
      ["https://assets.example/networking/ev1/profiles/other/photo.webp", null],
    ])("after commit deletes only the profile's own networking photo: %s", async (photoUrl, key) => {
      db.getNetworkingProfilePhotoByRegistration.mockResolvedValue({ id: "np1", eventId: "ev1", photoUrl });
      await service.deleteRegistration("reg1", "admin1");
      expect(db.getNetworkingProfilePhotoByRegistration.mock.invocationCallOrder[0])
        .toBeLessThan(db.deleteRegistrationRow.mock.invocationCallOrder[0]!);
      if (key) expect(storage.delete).toHaveBeenCalledWith(key);
      else expect(storage.delete).not.toHaveBeenCalled();
    });

    it("blocks deleting a PAID registration without force", async () => {
      db.findRegistrationForMutation.mockResolvedValue(
        makeRegRow({
          paymentStatus: "PAID",
          event: { clientId: "c1", status: "OPEN", client: activeClient() },
        }),
      );
      await expect(service.deleteRegistration("reg1", "admin1", false)).rejects.toMatchObject(
        { code: "REG_8009", statusCode: 400 },
      );
    });

    it("403 force-delete by a non-admin (checked before any DB access)", async () => {
      await expect(
        service.deleteRegistration("reg1", "u", true, 2 /* SCIENTIFIC_COMMITTEE */),
      ).rejects.toMatchObject({ code: "AUTH_1004", statusCode: 403 });
      expect(db.withTxn).not.toHaveBeenCalled();
    });

    it("force-deletes a PAID registration for a CLIENT_ADMIN", async () => {
      db.findRegistrationForMutation.mockResolvedValue(
        makeRegRow({
          paymentStatus: "PAID",
          event: { clientId: "c1", status: "OPEN", client: activeClient() },
        }),
      );
      await service.deleteRegistration("reg1", "admin1", true, 1 /* CLIENT_ADMIN */);
      expect(db.deleteRegistrationRow).toHaveBeenCalled();
    });
  });

  // ---- getRegistrationForEdit ---------------------------------------------
  describe("getRegistrationForEdit", () => {
    it("full permissions on an OPEN event", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(
        makeRegRow({
          event: {
            id: "ev1",
            name: "Ev",
            slug: "ev",
            clientId: "c1",
            status: "OPEN",
            endDate: FUTURE,
            client: activeClient(),
          },
          form: { id: "form1", name: "Reg", schema: {} },
        }),
      );
      const r = await service.getRegistrationForEdit("reg1");
      expect(r.canEdit).toBe(true);
      expect(r.canRemoveAccess).toBe(true);
      expect(r.editRestrictions).toHaveLength(0);
    });

    // GET used to close on the end date's instant while the edit itself
    // accepts the whole last day (midnight-UTC end dates).
    it("keeps the edit open on the event's last day, as the edit does", async () => {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      db.findRegistrationWithFormEvent.mockResolvedValue(
        makeRegRow({
          event: {
            id: "ev1",
            name: "Ev",
            slug: "ev",
            clientId: "c1",
            status: "OPEN",
            endDate: today,
            client: activeClient(),
          },
          form: { id: "form1", name: "Reg", schema: {} },
        }),
      );
      const r = await service.getRegistrationForEdit("reg1");
      expect(r.canEdit).toBe(true);
      expect(r.editRestrictions).toEqual([]);
    });

    it("blocks everything for a REFUNDED registration", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(
        makeRegRow({
          paymentStatus: "REFUNDED",
          event: {
            id: "ev1",
            name: "Ev",
            slug: "ev",
            clientId: "c1",
            status: "OPEN",
            endDate: FUTURE,
            client: activeClient(),
          },
          form: { id: "form1", name: "Reg", schema: {} },
        }),
      );
      const r = await service.getRegistrationForEdit("reg1");
      expect(r.canEdit).toBe(false);
    });
  });

  // ---- editRegistrationPublic ---------------------------------------------
  describe("editRegistrationPublic", () => {
    const editFetch = (overrides: Record<string, unknown> = {}) =>
      makeRegRow({
        form: { id: "form1", name: "Reg", schema: { steps: [{ fields: [] }] } },
        event: {
          id: "ev1",
          name: "Ev",
          slug: "ev",
          clientId: "c1",
          status: "OPEN",
          endDate: FUTURE,
          client: activeClient(),
        },
        ...overrides,
      });

    beforeEach(() => {
      db.getRegistrationByIdRow.mockResolvedValue(makeRegRow());
      db.applyRegistrationSettlement.mockResolvedValue(true);
      // The settlement re-reads the row the edit locked.
      db.findRegistrationForMutation.mockImplementation((id: string, tx: unknown) =>
        db.findRegistrationWithFormEvent(id, tx),
      );
      pricing.calculatePrice.mockResolvedValue(emptyBreakdown(100));
    });

    const expected = "2026-01-01T00:00:00.000Z";
    const answerForm = { id: "form1", name: "Reg", schema: ANSWER_SCHEMA };

    it("locks the registration before reading it", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(editFetch());
      await service.editRegistrationPublic("reg1", { expectedUpdatedAt: expected, firstName: "Z" } as never);
      expect(db.withLockingTxn).toHaveBeenCalledTimes(1);
      const [lock] = db.lockRegistrationForUpdate.mock.invocationCallOrder;
      const [read] = db.findRegistrationWithFormEvent.mock.invocationCallOrder;
      expect(lock).toBeLessThan(read!);
    });

    it("skips repricing when neither the answers nor the access change", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(
        editFetch({
          form: answerForm,
          formData: { answer: "same" },
          paymentStatus: "PAID",
          paidAmount: 100,
          priceBreakdown: {
            ...emptyBreakdown(100),
            accessItems: [{ accessId: "acc1", quantity: 1, subtotal: 0 }],
          },
        }),
      );
      // The event's prices changed since signup: a reprice would move the net.
      pricing.calculatePrice.mockResolvedValue(emptyBreakdown(180));

      const result = await service.editRegistrationPublic("reg1", {
        expectedUpdatedAt: expected,
        firstName: "Z",
        formData: { answer: "same" },
        accessSelections: [{ accessId: "acc1", quantity: 1 }],
      } as never);

      expect(pricing.calculatePrice).not.toHaveBeenCalled();
      expect(db.settleRegistrationTxn).not.toHaveBeenCalled();
      expect(access.validateAccessSelections).not.toHaveBeenCalled();
      expect(access.incrementAccessRegisteredCountTx).not.toHaveBeenCalled();
      const input = db.applyRegistrationSettlement.mock.calls[0]![1] as ApplyRegistrationSettlementInput;
      expect(input.settlement).toEqual({});
      expect(input.fields).toMatchObject({ firstName: "Z", formData: { answer: "same" }, accessTypeIds: ["acc1"] });
      expect(result.priceBreakdown).toMatchObject({ total: 100 });
      expect(db.insertAuditLog.mock.calls[0]![0].changes).toEqual({ firstName: { old: "A", new: "Z" } });
      const updated = db.enqueueRealtimeOutboxEvent.mock.calls.map((call) => call[1]);
      expect(updated.map((event) => event.type)).toEqual(["registration.updated"]);
      expect(updated[0].payload.paymentStatus).toBe("PAID");
    });

    it("409 REGISTRATION_PRICE_LOCKED when a self-edit would change a PAID registration's price", async () => {
      const oldBreakdown = { ...emptyBreakdown(100), accessItems: [
        { accessId: "old", quantity: 1, subtotal: 100 },
      ] };
      db.findRegistrationWithFormEvent.mockResolvedValue(editFetch({
        paymentStatus: "PAID", paidAmount: 100, paidAt: new Date("2026-01-01T00:00:00.000Z"),
        priceBreakdown: oldBreakdown,
      }));
      pricing.calculatePrice.mockResolvedValue({ ...emptyBreakdown(150), accessItems: [
        ...oldBreakdown.accessItems, { accessId: "new", quantity: 1, subtotal: 50 },
      ] });

      await expect(service.editRegistrationPublic("reg1", { expectedUpdatedAt: expected,
        accessSelections: [{ accessId: "old", quantity: 1 }, { accessId: "new", quantity: 1 }],
      } as never)).rejects.toMatchObject({
        code: ErrorCodes.REGISTRATION_PRICE_LOCKED,
        statusCode: 409,
        details: { currentNet: 100, newNet: 150 },
      });
      expect(db.applyRegistrationSettlement).not.toHaveBeenCalled();
      expect(db.insertAuditLog).not.toHaveBeenCalled();
      expect(db.enqueueRealtimeOutboxEvent).not.toHaveBeenCalled();
    });

    it("lets a PAID registration add an item that does not change its price", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(editFetch({
        paymentStatus: "PAID", paidAmount: 100,
      }));
      pricing.calculatePrice.mockResolvedValue({ ...emptyBreakdown(100), accessItems: [
        { accessId: "free", quantity: 1, subtotal: 0 },
      ] });

      await service.editRegistrationPublic("reg1", { expectedUpdatedAt: expected,
        accessSelections: [{ accessId: "free", quantity: 1 }],
      } as never);

      const patch = writtenPatch();
      expect(patch).toMatchObject({ totalAmount: 100, accessTypeIds: ["free"] });
      expect(patch.paymentStatus).toBeUndefined();
      expect(access.incrementAccessRegisteredCountTx).toHaveBeenCalledWith("free", 1, expect.anything());
      // PAID holds every item in paid capacity: the new one took a place.
      expect(access.handleCapacityReached).toHaveBeenCalledWith("ev1", ["free"], expect.anything());
      const counts = db.enqueueRealtimeOutboxEvent.mock.calls
        .map((call) => call[1])
        .find((event) => event.type === "eventAccess.countsChanged");
      expect(counts?.payload.accessIds).toEqual(["free"]);
    });

    it("checks required choices even when a public edit only removes access", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(editFetch({
        paymentStatus: "PENDING", accessTypeIds: ["acc1"],
        priceBreakdown: { ...emptyBreakdown(100), accessItems: [{ accessId: "acc1", quantity: 1, subtotal: 0 }] },
        form: { id: "form1", name: "Reg", schema: { settings: { accessSelectionRequired: true } } },
      }));
      access.assertAccessSelectionRequirement.mockRejectedValue(new AppException(ErrorCodes.ACCESS_SELECTION_REQUIRED, "Choose an option", 400));
      await expect(service.editRegistrationPublic("reg1", { expectedUpdatedAt: expected, accessSelections: [] } as never))
        .rejects.toMatchObject({ code: ErrorCodes.ACCESS_SELECTION_REQUIRED });
      expect(access.assertAccessSelectionRequirement).toHaveBeenCalledWith("ev1", expect.anything(), [], { accessSelectionRequired: true }, expect.anything());
      expect(db.applyRegistrationSettlement).not.toHaveBeenCalled();
    });

    it.each([0, 40])("keeps gross totals during repricing with %s sponsorship", async (sponsorshipAmount) => {
      db.findRegistrationWithFormEvent.mockResolvedValue(editFetch({
        sponsorshipAmount, priceBreakdown: sponsoredBreakdown(100, sponsorshipAmount), form: answerForm,
      }));
      pricing.calculatePrice.mockResolvedValue(emptyBreakdown(100));
      await service.editRegistrationPublic("reg1", { expectedUpdatedAt: expected, formData: { answer: "x" } } as never);
      expect(pricing.calculatePrice).toHaveBeenCalledWith("ev1", expect.objectContaining({ sponsorshipCodes: [] }), expect.anything());
      const patch = writtenPatch();
      expect(patch.totalAmount).toBe(100);
      expect(patch.sponsorshipAmount).toBe(sponsorshipAmount);
      expect(calculateSettlement({ totalAmount: patch.totalAmount!, sponsorshipAmount: patch.sponsorshipAmount!, paidAmount: 0 }).amountDue)
        .toBe(100 - sponsorshipAmount);
    });

    it("validates retained dependencies when a prerequisite is removed", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(editFetch({ priceBreakdown: {
        ...emptyBreakdown(100), accessItems: [
          { accessId: "prerequisite", quantity: 1 }, { accessId: "workshop", quantity: 1 },
        ],
      } }));
      access.validateAccessSelections.mockImplementation((_event, selections, data, existing) =>
        validateSelections([{ id: "workshop", name: "Workshop", active: true, type: "WORKSHOP",
          startsAt: null, endsAt: null, maxCapacity: null, requiredAccess: [{ id: "prerequisite" }],
        }] as never, [], selections, data, existing, new Date()));
      await expect(service.editRegistrationPublic("reg1", { expectedUpdatedAt: expected,
        accessSelections: [{ accessId: "workshop", quantity: 1 }],
      } as never)).rejects.toMatchObject({ code: ErrorCodes.BAD_REQUEST });
      expect(db.applyRegistrationSettlement).not.toHaveBeenCalled();
    });

    it("validates retained access eligibility after a form-only edit", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(editFetch({
        formData: { profession: "doctor" },
        form: { id: "form1", schema: { steps: [{ id: "step1", title: "Profile", fields: [
          { id: "profession", type: "text", label: "Profession" },
        ] }] } },
        priceBreakdown: {
        ...emptyBreakdown(100), accessItems: [{ accessId: "workshop", quantity: 1 }],
      } }));
      access.validateAccessSelections.mockImplementation((_event, selections, data, existing) =>
        validateSelections([{ id: "workshop", name: "Workshop", active: true, type: "WORKSHOP",
          startsAt: null, endsAt: null, maxCapacity: null, conditionLogic: "AND",
          conditions: [{ fieldId: "profession", operator: "equals", value: "doctor" }],
        }] as never, [], selections, data, existing, new Date()));
      await expect(service.editRegistrationPublic("reg1", { expectedUpdatedAt: expected,
        formData: { profession: "nurse" },
      } as never)).rejects.toMatchObject({ code: ErrorCodes.BAD_REQUEST });
      expect(db.applyRegistrationSettlement).not.toHaveBeenCalled();
    });

    it("400 for a REFUNDED registration", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(
        editFetch({ paymentStatus: "REFUNDED" }),
      );
      await expect(
        service.editRegistrationPublic("reg1", {
          expectedUpdatedAt: expected,
          firstName: "Z",
        } as never),
      ).rejects.toMatchObject({ code: "REG_8003", statusCode: 400 });
    });

    it("409 CONCURRENT_MODIFICATION when the locked row changed since GET-for-edit", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(
        editFetch({ updatedAt: new Date("2026-01-02T00:00:00.000Z") }),
      );
      await expect(
        service.editRegistrationPublic("reg1", {
          expectedUpdatedAt: expected,
          firstName: "Z",
        } as never),
      ).rejects.toMatchObject({ code: "CON_16001", statusCode: 409 });
      expect(db.applyRegistrationSettlement).not.toHaveBeenCalled();
    });

    it("blocks removing access from a paid registration", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(
        editFetch({
          paymentStatus: "PAID",
          priceBreakdown: {
            ...emptyBreakdown(100),
            accessItems: [
              { accessId: "acc1", name: "A", unitPrice: 10, quantity: 2, subtotal: 20 },
            ],
          },
        }),
      );
      await expect(
        service.editRegistrationPublic("reg1", {
          expectedUpdatedAt: expected,
          accessSelections: [{ accessId: "acc1", quantity: 1 }],
        } as never),
      ).rejects.toMatchObject({ code: "REG_8008", statusCode: 400 });
    });

    it("allows adding access to a paid registration (by quantity delta)", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(
        editFetch({
          paymentStatus: "PAID",
          priceBreakdown: {
            ...emptyBreakdown(100),
            accessItems: [
              { accessId: "acc1", name: "A", unitPrice: 10, quantity: 1, subtotal: 10 },
            ],
          },
        }),
      );
      await service.editRegistrationPublic("reg1", {
        expectedUpdatedAt: expected,
        accessSelections: [{ accessId: "acc1", quantity: 3 }],
      } as never);
      // delta +2 (1 → 3), never a decrement
      expect(access.incrementAccessRegisteredCountTx).toHaveBeenCalledWith(
        "acc1",
        2,
        expect.anything(),
      );
      expect(access.decrementAccessRegisteredCountTx).not.toHaveBeenCalled();
    });

    it("uses the in-transaction executor for pricing + validation", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(
        editFetch({
          priceBreakdown: {
            ...emptyBreakdown(100),
            accessItems: [
              { accessId: "acc1", name: "A", unitPrice: 10, quantity: 1, subtotal: 10 },
            ],
          },
        }),
      );
      const tx = { marker: true };
      db.withTxn.mockImplementation((fn: (t: unknown) => unknown) => fn(tx));
      await service.editRegistrationPublic("reg1", {
        expectedUpdatedAt: expected,
        accessSelections: [{ accessId: "acc1", quantity: 2 }],
      } as never);
      expect(pricing.calculatePrice).toHaveBeenCalledWith(
        "ev1",
        expect.anything(),
        tx,
      );
    });
  });

  // ---- confirmPayment ------------------------------------------------------
  describe("confirmPayment", () => {
    const mutRow = (overrides: Record<string, unknown> = {}) =>
      makeRegRow({
        event: { clientId: "c1", status: "OPEN", client: activeClient() },
        ...overrides,
      });

    beforeEach(() => {
      db.findRegistrationForMutation.mockResolvedValue(mutRow());
      db.getRegistrationByIdRow.mockResolvedValue(makeRegRow());
    });

    it("defaults payment confirmation to the net amount after sponsorship", async () => {
      db.findRegistrationForMutation.mockResolvedValue(mutRow({ sponsorshipAmount: 40, totalAmount: 100, priceBreakdown: sponsoredBreakdown(100, 40) }));
      await service.confirmPayment("reg1", { paymentStatus: "PAID" } as never);
      expect(db.applyRegistrationSettlement.mock.calls[0]?.[1]).toMatchObject({
        registrationId: "reg1",
        settlement: { paidAmount: 60 },
      });
    });

    it("PENDING→PAID strips editToken, audits with IP, queues PAYMENT_CONFIRMED", async () => {
      const result = await service.confirmPayment(
        "reg1",
        { paymentStatus: "PAID" } as never,
        "admin1",
        "1.2.3.4",
      );
      expect("editToken" in result).toBe(false);
      const audit = db.insertAuditLog.mock.calls[0][0];
      expect(audit.action).toBe("PAYMENT_CONFIRMED");
      expect(audit.ipAddress).toBe("1.2.3.4");
      const email = db.enqueueTriggeredEmailOutbox.mock.calls[0];
      expect(email[1].trigger).toBe("PAYMENT_CONFIRMED");
      expect(email[2]).toBe("email:triggered:PAYMENT_CONFIRMED:reg1");
      const confirmedEvt = db.enqueueRealtimeOutboxEvent.mock.calls.find(
        (c) => c[1].type === "registration.paymentConfirmed",
      );
      expect(confirmedEvt).toBeDefined();
    });

    it("does NOT queue a PAYMENT_CONFIRMED email for a non-PAID target", async () => {
      await service.confirmPayment("reg1", { paymentStatus: "VERIFYING" } as never);
      expect(db.enqueueTriggeredEmailOutbox).not.toHaveBeenCalled();
    });

    it("rejects an invalid transition (REFUNDED→PAID)", async () => {
      db.findRegistrationForMutation.mockResolvedValue(
        mutRow({ paymentStatus: "REFUNDED" }),
      );
      await expect(
        service.confirmPayment("reg1", { paymentStatus: "PAID" } as never),
      ).rejects.toMatchObject({ code: "STT_12002", statusCode: 400 });
    });

    it("400 when paidAmount exceeds total", async () => {
      await expect(
        service.confirmPayment("reg1", {
          paymentStatus: "PAID",
          paidAmount: 999,
        } as never),
      ).rejects.toMatchObject({ code: "RES_3003", statusCode: 400 });
    });

    it("404 when registration not found", async () => {
      db.findRegistrationForMutation.mockResolvedValue(null);
      await expect(
        service.confirmPayment("x", { paymentStatus: "PAID" } as never),
      ).rejects.toMatchObject({ code: "REG_8001", statusCode: 404 });
    });

    it("404 without reading when there is no row to lock", async () => {
      db.lockRegistrationForUpdate.mockResolvedValue(false);
      await expect(
        service.confirmPayment("x", { paymentStatus: "PAID" } as never),
      ).rejects.toMatchObject({ code: "REG_8001", statusCode: 404 });
      expect(db.findRegistrationForMutation).not.toHaveBeenCalled();
    });

    it("locks the registration before reading and settling it", async () => {
      await service.confirmPayment("reg1", { paymentStatus: "PAID" } as never);
      expect(db.withLockingTxn).toHaveBeenCalledTimes(1);
      const [lock] = db.lockRegistrationForUpdate.mock.invocationCallOrder;
      const [read] = db.findRegistrationForMutation.mock.invocationCallOrder;
      const [settle] = db.settleRegistrationTxn.mock.invocationCallOrder;
      expect(lock).toBeLessThan(read!);
      expect(read).toBeLessThan(settle!);
    });

    it("400 PAID_AMOUNT_BELOW_DUE when a PAID confirmation is for less than the net", async () => {
      db.findRegistrationForMutation.mockResolvedValue(mutRow({ totalAmount: 100, sponsorshipAmount: 40, priceBreakdown: sponsoredBreakdown(100, 40) }));
      await expect(
        service.confirmPayment("reg1", { paymentStatus: "PAID", paidAmount: 50 } as never),
      ).rejects.toMatchObject({
        code: ErrorCodes.PAID_AMOUNT_BELOW_DUE,
        statusCode: 400,
        details: { amountDue: 60, paidAmount: 50 },
      });
      expect(db.applyRegistrationSettlement).not.toHaveBeenCalled();
      expect(db.insertAuditLog).not.toHaveBeenCalled();
    });

    it("accepts PAID for exactly the net and a smaller amount as PARTIAL", async () => {
      db.findRegistrationForMutation.mockResolvedValue(mutRow({ totalAmount: 100, sponsorshipAmount: 40, priceBreakdown: sponsoredBreakdown(100, 40) }));
      await service.confirmPayment("reg1", { paymentStatus: "PAID", paidAmount: 60 } as never);
      await service.confirmPayment("reg1", { paymentStatus: "PARTIAL", paidAmount: 50 } as never);
      expect(writtenPatch(0)).toMatchObject({ paymentStatus: "PAID", paidAmount: 60 });
      expect(writtenPatch(1)).toMatchObject({ paymentStatus: "PARTIAL", paidAmount: 50 });
    });

    it("allows VERIFYING → PARTIAL (a proof of a partial payment)", async () => {
      db.findRegistrationForMutation.mockResolvedValue(
        mutRow({ paymentStatus: "VERIFYING", totalAmount: 100 }),
      );
      await service.confirmPayment("reg1", { paymentStatus: "PARTIAL", paidAmount: 30 } as never);
      expect(writtenPatch()).toMatchObject({ paymentStatus: "PARTIAL", paidAmount: 30 });
      expect(writtenPatch().paidAt).toBeUndefined();
    });

    it("hands the access items it filled to the capacity handling", async () => {
      db.settleRegistrationTxn.mockImplementationOnce(async (_tx: unknown, id: string) => {
        const snapshot = {
          paymentStatus: "PENDING",
          paidAt: null,
          paidAmount: 0,
          totalAmount: 100,
          sponsorshipAmount: 0,
          priceBreakdown: emptyBreakdown(100),
        };
        return {
          written: true,
          eventId: "ev1",
          before: snapshot,
          after: { ...snapshot, paymentStatus: "PAID", paidAmount: 100 },
          coveredAccessIds: [],
          paidAccess: { incremented: ["acc1"], decremented: [] },
          id,
        };
      });
      await service.confirmPayment("reg1", { paymentStatus: "PAID" } as never);
      expect(access.handleCapacityReached).toHaveBeenCalledWith("ev1", ["acc1"], expect.anything());
    });

    it("emits countsChanged for paid places moved without a settled flip (PARTIAL)", async () => {
      db.settleRegistrationTxn.mockImplementationOnce(async () => {
        const snapshot = {
          paymentStatus: "PENDING",
          paidAt: null,
          paidAmount: 0,
          totalAmount: 100,
          sponsorshipAmount: 50,
          priceBreakdown: emptyBreakdown(100),
        };
        return {
          written: true,
          eventId: "ev1",
          before: snapshot,
          after: { ...snapshot, paymentStatus: "PARTIAL", paidAmount: 20 },
          coveredAccessIds: ["acc2"],
          paidAccess: { incremented: ["acc2"], decremented: [] },
        };
      });
      await service.confirmPayment("reg1", { paymentStatus: "PARTIAL", paidAmount: 20 } as never);
      const counts = db.enqueueRealtimeOutboxEvent.mock.calls.find(
        (c) => c[1].type === "eventAccess.countsChanged",
      );
      expect(counts?.[1].payload.accessIds).toContain("acc2");
    });

    it("maps a full access item to 409 ACCESS_CAPACITY_EXCEEDED", async () => {
      const { AccessCapacityExceededError } = await import("@app/db");
      db.settleRegistrationTxn.mockRejectedValueOnce(new AccessCapacityExceededError("acc1", "Gala", 0, 1));
      await expect(
        service.confirmPayment("reg1", { paymentStatus: "PAID" } as never),
      ).rejects.toMatchObject({
        code: ErrorCodes.ACCESS_CAPACITY_EXCEEDED,
        statusCode: 409,
        details: { remaining: 0, requested: 1 },
      });
      expect(db.insertAuditLog).not.toHaveBeenCalled();
    });
  });

  // ---- uploadPaymentProof --------------------------------------------------
  describe("uploadPaymentProof", () => {
    const proofFetch = (overrides: Record<string, unknown> = {}) =>
      makeRegRow({
        paymentProofUrl: null,
        form: { id: "form1", name: "Reg", schema: {} },
        event: {
          id: "ev1",
          name: "Ev",
          slug: "ev",
          clientId: "c1",
          status: "OPEN",
          endDate: FUTURE,
          client: activeClient(),
        },
        ...overrides,
      });
    const pdf = () => ({
      buffer: Buffer.from("data"),
      filename: "p.pdf",
      mimetype: "application/pdf",
    });

    beforeEach(() => {
      db.findRegistrationWithFormEvent.mockResolvedValue(proofFetch());
    });

    it("uploads a PDF privately, sets VERIFYING + BANK_TRANSFER, queues email", async () => {
      const result = await service.uploadPaymentProof("reg1", pdf());
      expect(storage.uploadPrivate).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/^ev1\/reg1\/proof-[0-9a-f-]{36}\.pdf$/),
        "application/pdf",
        { contentDisposition: "attachment" },
      );
      const patch = writtenPatch();
      expect(patch.paymentStatus).toBe("VERIFYING");
      expect(patch.paymentMethod).toBe("BANK_TRANSFER");
      expect(db.enqueueTriggeredEmailOutbox.mock.calls[0][2]).toBe(
        "email:triggered:PAYMENT_PROOF_SUBMITTED:reg1",
      );
      expect(result.fileName).toBe("proof.pdf");
    });

    it("rejects a disallowed header mimetype without sniffing", async () => {
      await expect(
        service.uploadPaymentProof("reg1", { ...pdf(), mimetype: "text/plain" }),
      ).rejects.toMatchObject({ code: "FIL_10001", statusCode: 400 });
      expect(ft.fileTypeFromBuffer).not.toHaveBeenCalled();
    });

    it("rejects when magic bytes are undetectable", async () => {
      ft.fileTypeFromBuffer.mockResolvedValue(undefined);
      await expect(service.uploadPaymentProof("reg1", pdf())).rejects.toMatchObject({
        code: "FIL_10001",
        statusCode: 400,
      });
    });

    it("rejects when the detected type is not allowed", async () => {
      ft.fileTypeFromBuffer.mockResolvedValue({ mime: "image/gif", ext: "gif" });
      await expect(service.uploadPaymentProof("reg1", pdf())).rejects.toMatchObject({
        code: "FIL_10001",
        statusCode: 400,
      });
    });

    it("rejects an oversized file", async () => {
      const big = { ...pdf(), buffer: Buffer.alloc(10 * 1024 * 1024 + 1) };
      await expect(service.uploadPaymentProof("reg1", big)).rejects.toMatchObject({
        code: "FIL_10002",
        statusCode: 400,
      });
    });

    it("404 when the registration is missing", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(null);
      await expect(service.uploadPaymentProof("x", pdf())).rejects.toMatchObject({
        code: "REG_8001",
        statusCode: 404,
      });
    });

    it("rejects upload for a PAID registration (transition blocked)", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(
        proofFetch({ paymentStatus: "PAID" }),
      );
      await expect(service.uploadPaymentProof("reg1", pdf())).rejects.toMatchObject({
        code: "STT_12002",
        statusCode: 400,
      });
    });

    it("rejects upload for a REFUNDED registration", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(
        proofFetch({ paymentStatus: "REFUNDED" }),
      );
      await expect(service.uploadPaymentProof("reg1", pdf())).rejects.toMatchObject({
        code: "STT_12002",
        statusCode: 400,
      });
    });

    it("accepts a PNG and stores it as WebP", async () => {
      ft.fileTypeFromBuffer.mockResolvedValue({ mime: "image/png", ext: "png" });
      integ.compressFile.mockResolvedValue({
        buffer: Buffer.from("webp"),
        contentType: "image/webp",
        ext: "webp",
      });
      const result = await service.uploadPaymentProof("reg1", {
        ...pdf(),
        mimetype: "image/png",
      });
      expect(result.fileName).toBe("proof.webp");
      expect(result.mimeType).toBe("image/webp");
    });

    // ---- write ordering: upload new key → update row → delete old ----------
    describe("write ordering", () => {
      const oldProof = "ev1/reg1/proof.pdf";
      const uploadedKey = () => storage.uploadPrivate.mock.calls[0][1] as string;

      beforeEach(() => {
        storage.uploadPrivate.mockImplementation(
          async (_buffer: Buffer, key: string) => key,
        );
        db.findRegistrationWithFormEvent.mockResolvedValue(
          proofFetch({ paymentProofUrl: oldProof, paymentStatus: "VERIFYING" }),
        );
      });

      it("uploads under a fresh key and deletes the old proof only after the row update", async () => {
        const result = await service.uploadPaymentProof("reg1", pdf());

        expect(uploadedKey()).not.toBe(oldProof);
        expect(result.fileUrl).toBe(uploadedKey());
        expect(writtenPatch().paymentProofUrl).toBe(
          uploadedKey(),
        );
        expect(storage.delete).toHaveBeenCalledTimes(1);
        expect(storage.delete).toHaveBeenCalledWith(oldProof);
        const [uploadOrder] = storage.uploadPrivate.mock.invocationCallOrder;
        const [updateOrder] = db.applyRegistrationSettlement.mock.invocationCallOrder;
        const [deleteOrder] = storage.delete.mock.invocationCallOrder;
        expect(uploadOrder).toBeLessThan(updateOrder);
        expect(updateOrder).toBeLessThan(deleteOrder);
      });

      it("never reuses a key across uploads", async () => {
        await service.uploadPaymentProof("reg1", pdf());
        await service.uploadPaymentProof("reg1", pdf());
        const [first, second] = storage.uploadPrivate.mock.calls.map((c) => c[1]);
        expect(first).not.toBe(second);
      });

      it("row update failure keeps the old proof, deletes the new object and rethrows", async () => {
        const dbDown = new Error("db down");
        db.applyRegistrationSettlement.mockRejectedValueOnce(dbDown);

        await expect(service.uploadPaymentProof("reg1", pdf())).rejects.toBe(dbDown);

        expect(storage.delete).toHaveBeenCalledTimes(1);
        expect(storage.delete).toHaveBeenCalledWith(uploadedKey());
        expect(storage.delete).not.toHaveBeenCalledWith(oldProof);
      });

      it("post-upload re-validation failure (now PAID) removes the new object and keeps the old", async () => {
        db.findRegistrationWithFormEvent
          .mockResolvedValueOnce(
            proofFetch({ paymentProofUrl: oldProof, paymentStatus: "VERIFYING" }),
          )
          .mockResolvedValueOnce(
            proofFetch({ paymentProofUrl: oldProof, paymentStatus: "PAID" }),
          );

        await expect(service.uploadPaymentProof("reg1", pdf())).rejects.toMatchObject({
          code: "STT_12002",
          statusCode: 400,
        });

        expect(db.applyRegistrationSettlement).not.toHaveBeenCalled();
        expect(storage.delete).toHaveBeenCalledTimes(1);
        expect(storage.delete).toHaveBeenCalledWith(uploadedKey());
        // The re-check ran on the row read after the registration lock.
        const [, reread] = db.findRegistrationWithFormEvent.mock.invocationCallOrder;
        const [lock] = db.lockRegistrationForUpdate.mock.invocationCallOrder;
        expect(lock).toBeLessThan(reread!);
        expect(db.withLockingTxn).toHaveBeenCalledTimes(1);
      });

      it("deletes the proof the transaction replaced, not the one seen before the upload", async () => {
        const raced = "ev1/reg1/proof-11111111-1111-4111-8111-111111111111.webp";
        db.findRegistrationWithFormEvent
          .mockResolvedValueOnce(
            proofFetch({ paymentProofUrl: oldProof, paymentStatus: "VERIFYING" }),
          )
          .mockResolvedValueOnce(
            proofFetch({ paymentProofUrl: raced, paymentStatus: "VERIFYING" }),
          );

        await service.uploadPaymentProof("reg1", pdf());

        expect(storage.delete).toHaveBeenCalledTimes(1);
        expect(storage.delete).toHaveBeenCalledWith(raced);
      });

      it("an old-proof delete failure does not fail the request", async () => {
        storage.delete.mockRejectedValueOnce(new Error("storage down"));

        const result = await service.uploadPaymentProof("reg1", pdf());

        expect(result.fileUrl).toBe(uploadedKey());
        expect(storage.delete).toHaveBeenCalledWith(oldProof);
      });

      it.each([
        ["another registration's object", "ev1/reg2/proof.pdf"],
        ["another event's object", "ev2/reg1/proof.pdf"],
        ["an external URL", "https://evil.example/whatever.pdf"],
      ])("never deletes a stored proof URL outside this registration's prefix (%s)", async (_label, url) => {
        db.findRegistrationWithFormEvent.mockResolvedValue(
          proofFetch({ paymentProofUrl: url, paymentStatus: "VERIFYING" }),
        );

        await service.uploadPaymentProof("reg1", pdf());

        expect(db.applyRegistrationSettlement).toHaveBeenCalledTimes(1);
        expect(storage.delete).not.toHaveBeenCalled();
      });
    });
  });

  // ---- selectPaymentMethod -------------------------------------------------
  describe("selectPaymentMethod", () => {
    const methodFetch = (overrides: Record<string, unknown> = {}) =>
      makeRegRow({
        paymentMethod: null,
        labName: null,
        form: { id: "form1", name: "Reg", schema: {} },
        event: {
          id: "ev1",
          name: "Ev",
          slug: "ev",
          clientId: "c1",
          status: "OPEN",
          endDate: FUTURE,
          client: activeClient(),
        },
        ...overrides,
      });

    it("CASH stays PENDING and audits", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(methodFetch());
      await service.selectPaymentMethod("reg1", { paymentMethod: "CASH" } as never);
      const patch = writtenPatch();
      expect(patch.paymentStatus).toBe("PENDING");
      expect(patch.paymentMethod).toBe("CASH");
      expect(patch.labName).toBeNull();
      expect(db.insertAuditLog.mock.calls[0][0].action).toBe(
        "PAYMENT_METHOD_SELECTED",
      );
    });

    it("rejects LAB_SPONSORSHIP when the sponsorships module is enabled", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(
        methodFetch({
          event: {
            id: "ev1",
            name: "Ev",
            slug: "ev",
            clientId: "c1",
            status: "OPEN",
            endDate: FUTURE,
            client: {
              active: true,
              enabledModules: ["registrations", "pricing", "sponsorships"],
            },
          },
        }),
      );
      await expect(
        service.selectPaymentMethod("reg1", {
          paymentMethod: "LAB_SPONSORSHIP",
          labName: "X",
        } as never),
      ).rejects.toMatchObject({ code: "RES_3003", statusCode: 400 });
    });

    it("rejects when the registration is not PENDING", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(
        methodFetch({ paymentStatus: "VERIFYING" }),
      );
      await expect(
        service.selectPaymentMethod("reg1", { paymentMethod: "CASH" } as never),
      ).rejects.toMatchObject({ code: "REG_8004", statusCode: 400 });
      // VERIFYING → PENDING is in the transition table; the public path is stricter.
      expect(db.applyRegistrationSettlement).not.toHaveBeenCalled();
    });

    it("checks PENDING on the row re-read under the registration lock", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(methodFetch());
      await service.selectPaymentMethod("reg1", { paymentMethod: "CASH" } as never);
      expect(db.withLockingTxn).toHaveBeenCalledTimes(1);
      const [lock] = db.lockRegistrationForUpdate.mock.invocationCallOrder;
      const [read] = db.findRegistrationWithFormEvent.mock.invocationCallOrder;
      expect(lock).toBeLessThan(read!);
    });
  });

  // ---- listRegistrationAuditLogs ------------------------------------------
  describe("listRegistrationAuditLogs", () => {
    it("resolves SYSTEM / PUBLIC / user performer names", async () => {
      db.listRegistrationAuditLogRows.mockResolvedValue({
        rows: [
          {
            id: "a1",
            action: "CREATE",
            changes: null,
            performedBy: "SYSTEM",
            performedAt: new Date("2026-01-01T00:00:00.000Z"),
            ipAddress: null,
          },
          {
            id: "a2",
            action: "UPDATE",
            changes: null,
            performedBy: "PUBLIC",
            performedAt: new Date("2026-01-02T00:00:00.000Z"),
            ipAddress: null,
          },
          {
            id: "a3",
            action: "PAYMENT_CONFIRMED",
            changes: null,
            performedBy: "u1",
            performedAt: new Date("2026-01-03T00:00:00.000Z"),
            ipAddress: "9.9.9.9",
          },
        ],
        total: 3,
      });
      db.findUserNamesByIds.mockResolvedValue([{ id: "u1", name: "Alice" }]);

      const res = await service.listRegistrationAuditLogs("reg1", {
        page: 1,
        limit: 50,
      } as never);
      expect(db.findUserNamesByIds).toHaveBeenCalledWith(["u1"]);
      expect(res.data[0].performedByName).toBe("System");
      expect(res.data[1].performedByName).toBe("Registrant (Self-Edit)");
      expect(res.data[2].performedByName).toBe("Alice");
      expect(res.data[2].performedAt).toBe("2026-01-03T00:00:00.000Z");
      expect(res.meta.total).toBe(3);
    });
  });

  // ---- listRegistrationEmailLogs ------------------------------------------
  describe("listRegistrationEmailLogs", () => {
    it("maps rows and ISO-serialises timestamps", async () => {
      db.listRegistrationEmailLogRows.mockResolvedValue({
        rows: [
          {
            id: "e1",
            subject: "Welcome",
            status: "SENT",
            trigger: "REGISTRATION_CREATED",
            templateName: "Tmpl",
            errorMessage: null,
            queuedAt: new Date("2026-01-01T00:00:00.000Z"),
            sentAt: new Date("2026-01-01T00:05:00.000Z"),
            deliveredAt: null,
            openedAt: null,
            clickedAt: null,
            bouncedAt: null,
            failedAt: null,
          },
        ],
        total: 1,
      });
      const res = await service.listRegistrationEmailLogs("reg1", {
        page: 1,
        limit: 50,
      } as never);
      expect(res.data[0].templateName).toBe("Tmpl");
      expect(res.data[0].queuedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(res.data[0].sentAt).toBe("2026-01-01T00:05:00.000Z");
      expect(res.data[0].deliveredAt).toBeNull();
    });
  });

  // ---- 0.5: response shapes (no credentials / internal fields) -------------
  describe("response shapes", () => {
    // Every internal column populated with a recognisable sentinel.
    const SENTINELS = [
      "tok-64",
      "idem-key-1",
      "SECRET-NOTE",
      "staff-user-1",
      "https://link-base.example",
      "proofs/secret-proof.pdf",
      "BANKREF-1",
    ];
    const internalRow = (overrides: Record<string, unknown> = {}) =>
      makeRegRow({
        referenceNumber: "26-EV-001",
        networkingOptIn: true,
        paymentMethod: "BANK_TRANSFER",
        labName: null,
        currency: "TND",
        baseAmount: 100,
        discountAmount: 0,
        accessAmount: 0,
        submittedAt: new Date("2026-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        lastEditedAt: null,
        formSchemaVersion: 3,
        droppedAccessIds: [],
        idempotencyKey: "idem-key-1",
        note: "SECRET-NOTE",
        checkedInAt: new Date("2026-01-02T00:00:00.000Z"),
        checkedInBy: "staff-user-1",
        linkBaseUrl: "https://link-base.example",
        paymentProofUrl: "proofs/secret-proof.pdf",
        paymentReference: "BANKREF-1",
        ...overrides,
      });
    const PUBLIC_KEYS = [
      "accessAmount",
      "accessSelections",
      "baseAmount",
      "createdAt",
      "currency",
      "discountAmount",
      "droppedAccessSelections",
      "email",
      "event",
      "eventId",
      "firstName",
      "form",
      "formData",
      "formId",
      "hasPaymentProof",
      "id",
      "labName",
      "lastEditedAt",
      "lastName",
      "networkingOptIn",
      "paidAmount",
      "paidAt",
      "paymentMethod",
      "paymentStatus",
      "phone",
      "priceBreakdown",
      "referenceNumber",
      "sponsorshipAmount",
      "sponsorshipCode",
      "submittedAt",
      "totalAmount",
      "updatedAt",
    ];
    const withoutSentinels = (value: unknown, allow: string[] = []) => {
      const json = JSON.stringify(value);
      for (const sentinel of SENTINELS.filter((x) => !allow.includes(x))) {
        expect(json).not.toContain(sentinel);
      }
    };

    it("admin list rows never carry editToken or idempotencyKey", async () => {
      db.listRegistrationRows.mockResolvedValue({
        rows: [internalRow()],
        total: 1,
        stats: [],
      });
      const res = await service.listRegistrations("ev1", { page: 1, limit: 20 } as never);
      expect(res.data[0]).not.toHaveProperty("editToken");
      expect(res.data[0]).not.toHaveProperty("idempotencyKey");
      // Admin-only data stays available to admins.
      expect(res.data[0]).toMatchObject({ note: "SECRET-NOTE", checkedInBy: "staff-user-1" });
    });

    it("admin create, update and admin-edit responses never carry editToken", async () => {
      db.getRegistrationByIdRow.mockResolvedValue(internalRow());
      db.findRegistrationForMutation.mockResolvedValue(
        internalRow({ event: { clientId: "c1", status: "OPEN", client: activeClient() } }),
      );
      const updated = await service.updateRegistration("reg1", { note: "x" } as never, "admin1");
      expect(updated).not.toHaveProperty("editToken");
      expect(updated).not.toHaveProperty("idempotencyKey");

      db.getEventForRegistrationAdmin.mockResolvedValue({
        clientId: "c1",
        status: "OPEN",
        client: activeClient(),
      });
      db.findRegistrationFormForEvent.mockResolvedValue({ id: "form1", schemaVersion: 1, schema: null });
      db.registrationExistsByEmailForm.mockResolvedValue(false);
      db.getEventForRegistrationCreate.mockResolvedValue({
        clientId: "c1",
        status: "OPEN",
        endDate: FUTURE,
        maxCapacity: null,
        registeredCount: 0,
        client: activeClient(),
      });
      db.insertRegistrationRow.mockResolvedValue({ id: "reg1" });
      const created = await service.createAdminRegistration(
        "ev1",
        { email: "x@y.tn", firstName: "X", lastName: "Y", formData: {}, role: "PARTICIPANT", accessSelections: [], sendEmail: false } as never,
        "admin1",
      );
      expect(created).not.toHaveProperty("editToken");
      expect(created).not.toHaveProperty("idempotencyKey");
    });

    it("public create (idempotent replay) returns the allowlisted DTO plus the registrant's token", async () => {
      db.getRegistrationByIdempotencyKeyRow.mockResolvedValue(internalRow());
      const res = await service.createPublicRegistration("form1", {
        idempotencyKey: "11111111-1111-1111-1111-111111111111",
        formData: {},
        email: "a@b.com",
        accessSelections: [],
      } as never);
      expect(Object.keys(res.registration).sort()).toEqual([...PUBLIC_KEYS, "token"].sort());
      expect(res.registration.token).toBe("tok-64");
      expect(res.registration.hasPaymentProof).toBe(true);
      expect(res.registration.event).toEqual({ id: "ev1", name: "Ev", slug: "ev" });
      expect(res.registration.form).toEqual({ id: "form1", name: "Reg Form" });
      withoutSentinels(res.registration, ["tok-64"]);
      expect(JSON.stringify(res.registration).match(/tok-64/g)).toHaveLength(1);
    });

    it("public edit returns the DTO without any token", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(
        internalRow({
          paymentStatus: "PAID",
          priceBreakdown: {
            ...emptyBreakdown(100),
            accessItems: [{ accessId: "acc1", name: "A", unitPrice: 10, quantity: 1, subtotal: 10 }],
          },
          form: { id: "form1", name: "Reg", schema: { steps: [{ fields: [] }] } },
          event: {
            id: "ev1",
            name: "Ev",
            slug: "ev",
            clientId: "c1",
            status: "OPEN",
            endDate: FUTURE,
            client: activeClient(),
          },
        }),
      );
      db.applyRegistrationSettlement.mockResolvedValue(true);
      db.getRegistrationByIdRow.mockResolvedValue(internalRow({ paymentProofUrl: null }));
      const res = await service.editRegistrationPublic("reg1", {
        expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
        accessSelections: [{ accessId: "acc1", quantity: 2 }],
      } as never);
      expect(Object.keys(res.registration).sort()).toEqual(PUBLIC_KEYS);
      expect(res.registration.hasPaymentProof).toBe(false);
      withoutSentinels(res);
    });

    it("GET-for-edit returns the DTO with the form schema and a minimal event", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(
        internalRow({
          form: { id: "form1", name: "Reg", schema: { steps: [] } },
          event: {
            id: "ev1",
            name: "Ev",
            slug: "ev",
            clientId: "c1",
            status: "OPEN",
            endDate: FUTURE,
            client: activeClient(),
          },
        }),
      );
      const res = await service.getRegistrationForEdit("reg1");
      const keys = PUBLIC_KEYS.filter((k) => k !== "droppedAccessSelections");
      expect(Object.keys(res.registration).sort()).toEqual(keys);
      expect(res.registration.form).toEqual({ id: "form1", name: "Reg", schema: { steps: [] } });
      expect(res.registration.event).toEqual({
        id: "ev1",
        name: "Ev",
        slug: "ev",
        status: "OPEN",
        endDate: FUTURE,
      });
      expect(res.registration.hasPaymentProof).toBe(true);
      withoutSentinels(res);
    });
  });

  // ---- 0.5: audited self-edit link ------------------------------------------
  describe("issueSelfEditLink", () => {
    it("audits the issuance and returns the email self-edit link", async () => {
      db.getRegistrationEditLinkSource.mockResolvedValue({
        id: "reg1",
        editToken: "tok-64",
        linkBaseUrl: "https://forms.example.org",
        eventSlug: "summit",
      });
      const res = await service.issueSelfEditLink("reg1", "admin1", "1.2.3.4");
      expect(res).toEqual({ url: "https://forms.example.org/summit/registration/reg1/tok-64" });
      expect(db.insertAuditLog).toHaveBeenCalledTimes(1);
      const [entry] = db.insertAuditLog.mock.calls[0];
      expect(entry).toMatchObject({
        entityType: "Registration",
        entityId: "reg1",
        action: "EDIT_LINK_ISSUED",
        performedBy: "admin1",
        ipAddress: "1.2.3.4",
      });
      // The credential never lands in the audit trail.
      expect(JSON.stringify(entry)).not.toContain("tok-64");
    });

    it("404 when the registration has no edit token (admin-created); nothing audited", async () => {
      db.getRegistrationEditLinkSource.mockResolvedValue({
        id: "reg1",
        editToken: null,
        linkBaseUrl: null,
        eventSlug: "summit",
      });
      await expect(service.issueSelfEditLink("reg1", "admin1")).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(db.insertAuditLog).not.toHaveBeenCalled();
    });

    it("404 when the registration is gone", async () => {
      db.getRegistrationEditLinkSource.mockResolvedValue(null);
      await expect(service.issueSelfEditLink("nope", "admin1")).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.REGISTRATION_NOT_FOUND,
      });
      expect(db.insertAuditLog).not.toHaveBeenCalled();
    });
  });
});
