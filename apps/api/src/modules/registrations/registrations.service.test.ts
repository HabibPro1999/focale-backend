import { beforeEach, describe, expect, it, vi } from "vitest";

// --- @app/db mock -----------------------------------------------------------
const db = vi.hoisted(() => ({
  withTxn: vi.fn(),
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
  listRegistrationRows: vi.fn(),
  getEventForRegistrationCreate: vi.fn(),
  getEventForRegistrationAdmin: vi.fn(),
  findRegistrationFormForEvent: vi.fn(),
  registrationExistsByEmailForm: vi.fn(),
  findRegistrationForMutation: vi.fn(),
  findRegistrationWithFormEvent: vi.fn(),
  insertRegistrationRow: vi.fn(),
  updateRegistrationRow: vi.fn(),
  deleteRegistrationRow: vi.fn(),
  casUpdateRegistrationByUpdatedAt: vi.fn(),
  findRegistrationUsagesForRecalc: vi.fn(),
  findRegistrationUsageLinks: vi.fn(),
  deleteRegistrationUsages: vi.fn(),
  generateReferenceNumber: vi.fn(),
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
vi.mock("@app/db", () => db);

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

import { RegistrationsService } from "./registrations.service";
import { AppException } from "../../core/app-exception";
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

function activeClient() {
  return { active: true, enabledModules: ["registrations", "pricing"] };
}

describe("RegistrationsService", () => {
  let service: RegistrationsService;
  let access: {
    validateAccessSelections: ReturnType<typeof vi.fn>;
    incrementAccessRegisteredCountTx: ReturnType<typeof vi.fn>;
    decrementAccessRegisteredCountTx: ReturnType<typeof vi.fn>;
    syncPaidCountDelta: ReturnType<typeof vi.fn>;
    getAlreadyCoveredAccessIds: ReturnType<typeof vi.fn>;
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
    db.enqueueRealtimeOutboxEvent.mockResolvedValue(true);
    db.enqueueTriggeredEmailOutbox.mockResolvedValue(true);
    db.casIncrementRegisteredTx.mockResolvedValue(true);
    db.casDecrementRegisteredTx.mockResolvedValue(true);
    db.generateReferenceNumber.mockResolvedValue("26-EV-001");
    db.insertAuditLog.mockResolvedValue(undefined);
    db.updateRegistrationRow.mockResolvedValue(undefined);
    db.findAccessDetailsByIds.mockResolvedValue([]);
    db.findClientModuleState.mockResolvedValue(activeClient());
    db.findRegistrationUsagesForRecalc.mockResolvedValue([]);

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
      validateAccessSelections: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
      incrementAccessRegisteredCountTx: vi.fn().mockResolvedValue(undefined),
      decrementAccessRegisteredCountTx: vi.fn().mockResolvedValue(undefined),
      syncPaidCountDelta: vi.fn().mockResolvedValue(undefined),
      getAlreadyCoveredAccessIds: vi.fn().mockResolvedValue(new Set()),
    };
    pricing = { calculatePrice: vi.fn().mockResolvedValue(emptyBreakdown(100)) };

    service = new RegistrationsService(
      access as unknown as AccessService,
      pricing as unknown as PricingService,
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
    it("strips editToken", async () => {
      db.getRegistrationByIdRow.mockResolvedValue(makeRegRow());
      const result = await service.getRegistrationById("reg1");
      expect(result).not.toBeNull();
      expect("editToken" in (result as object)).toBe(false);
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

    it("updates a note and audits", async () => {
      await service.updateRegistration("reg1", { note: "hi" } as never, "admin1");
      expect(db.updateRegistrationRow).toHaveBeenCalled();
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
      db.casUpdateRegistrationByUpdatedAt.mockResolvedValue(1);
      pricing.calculatePrice.mockResolvedValue(emptyBreakdown(100));
    });

    const expected = "2026-01-01T00:00:00.000Z";

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

    it("409 CONCURRENT_MODIFICATION when the CAS matches no rows", async () => {
      db.findRegistrationWithFormEvent.mockResolvedValue(editFetch());
      db.casUpdateRegistrationByUpdatedAt.mockResolvedValue(0);
      await expect(
        service.editRegistrationPublic("reg1", {
          expectedUpdatedAt: expected,
          firstName: "Z",
        } as never),
      ).rejects.toMatchObject({ code: "CON_16001", statusCode: 409 });
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

    it("PENDING→PAID keeps editToken, audits with IP, queues PAYMENT_CONFIRMED", async () => {
      const result = await service.confirmPayment(
        "reg1",
        { paymentStatus: "PAID" } as never,
        "admin1",
        "1.2.3.4",
      );
      expect(result.editToken).toBe("tok-64"); // NOT stripped
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
        "ev1/reg1/proof.pdf",
        "application/pdf",
        { contentDisposition: "attachment" },
      );
      const patch = db.updateRegistrationRow.mock.calls[0][1];
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
      const patch = db.updateRegistrationRow.mock.calls[0][1];
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
});
