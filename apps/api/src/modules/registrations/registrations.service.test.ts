import { ErrorCodes } from "@app/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/db", async (importOriginal) =>
  (await import("./__testing__/service-mocks.js")).mockDbModule(importOriginal),
);
vi.mock("@app/integrations", async (importOriginal) =>
  (await import("./__testing__/service-mocks.js")).mockIntegrationsModule(importOriginal),
);
vi.mock("file-type", async () => (await import("./__testing__/service-mocks.js")).ft);

import { calculateSettlement } from "@app/shared";
import {
  FUTURE,
  PUBLIC_KEYS,
  activeClient,
  db,
  emptyBreakdown,
  installServiceMocks,
  internalRow,
  makeRegRow,
  withoutSentinels,
  type AccessMock,
  type PricingMock,
  type StorageMock,
} from "./__testing__/service-mocks";
import { AccessCapacityExceededError } from "@app/db";
import { RegistrationsService } from "./registrations.service";
import { RegistrationPaymentsService } from "./registrations.payments.service";
import { RegistrationSideEffects } from "./registrations.side-effects";
import { AppException } from "../../core/app-exception";
import type { Config } from "../../core/config";
import type { AccessService } from "../access/access.service";
import type { PricingService } from "../pricing/pricing.service";

describe("RegistrationsService", () => {
  let service: RegistrationsService;
  let payments: RegistrationPaymentsService;
  let access: AccessMock;
  let pricing: PricingMock;
  let storage: StorageMock;

  beforeEach(() => {
    ({ access, pricing, storage } = installServiceMocks());

    service = new RegistrationsService(
      access as unknown as AccessService,
      pricing as unknown as PricingService,
      {
        publicLinkAllowedOrigins: ["https://events.example.com"],
      } as Config,
      new RegistrationSideEffects(access as unknown as AccessService),
    );
    payments = new RegistrationPaymentsService(
      access as unknown as AccessService,
      new RegistrationSideEffects(access as unknown as AccessService),
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
          { paymentStatus: "PAID", cnt: 1, totalAmount: 100, paidAmount: 90, amountDue: 0 },
          { paymentStatus: "PENDING", cnt: 1, totalAmount: 50, paidAmount: 0, amountDue: 50 },
          { paymentStatus: "SPONSORED", cnt: 1, totalAmount: 70, paidAmount: 0, amountDue: 0 },
          { paymentStatus: "REFUNDED", cnt: 1, totalAmount: 30, paidAmount: 0, amountDue: 30 },
        ],
      });
      const res = await service.listRegistrations("ev1", { page: 1, limit: 20 } as never);
      expect(res.stats.total).toBe(4);
      expect(res.stats.totalAmount).toBe(250);
      expect(res.stats.paid).toEqual({ count: 1, amount: 90 });
      expect(res.stats.pending).toEqual({ count: 1, amount: 50 });
      expect(res.stats.sponsored).toEqual({ count: 1, amount: 70 });
    });

    it("pending.amount is the amount due, and collected sums paid amounts except refunds", async () => {
      db.listRegistrationRows.mockResolvedValue({
        rows: [],
        total: 9,
        stats: [
          { paymentStatus: "PAID", cnt: 2, totalAmount: 200, paidAmount: 180, amountDue: 0 },
          // Two partials: gross 300, sponsorship 40, 100 paid → 160 due.
          { paymentStatus: "PARTIAL", cnt: 2, totalAmount: 300, paidAmount: 100, amountDue: 160 },
          { paymentStatus: "PENDING", cnt: 1, totalAmount: 50, paidAmount: 0, amountDue: 50 },
          { paymentStatus: "VERIFYING", cnt: 1, totalAmount: 80, paidAmount: 20, amountDue: 60 },
          { paymentStatus: "SPONSORED", cnt: 1, totalAmount: 70, paidAmount: 10, amountDue: 0 },
          { paymentStatus: "WAIVED", cnt: 1, totalAmount: 40, paidAmount: 0, amountDue: 40 },
          { paymentStatus: "REFUNDED", cnt: 1, totalAmount: 30, paidAmount: 30, amountDue: 0 },
        ],
      });
      const res = await service.listRegistrations("ev1", { page: 1, limit: 20 } as never);
      expect(res.stats).toEqual({
        total: 9,
        totalAmount: 770,
        collected: 180 + 100 + 20 + 10,
        paid: { count: 2, amount: 180 },
        pending: { count: 4, amount: 160 + 50 + 60 },
        sponsored: { count: 2, amount: 110 },
      });
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

    it("stores the gross price and ignores a sponsorship priced into the breakdown", async () => {
      await service.createRegistration(baseInput as never, {
        ...emptyBreakdown(100), sponsorshipTotal: 40, total: 60,
        sponsorships: [{ code: "SP-QUOTED", amount: 40, valid: true }],
      });
      const stored = db.insertRegistrationRow.mock.calls[0][0];
      expect(stored).toMatchObject({ totalAmount: 100, sponsorshipAmount: 0, sponsorshipCode: null });
      expect(stored.priceBreakdown).toMatchObject({ sponsorships: [], sponsorshipTotal: 0, total: 100 });
      expect(calculateSettlement({ ...stored, paidAmount: 0 }).amountDue).toBe(100);
      expect(db.claimSponsorshipCodeTxn).not.toHaveBeenCalled();
      expect(db.settleRegistrationTxn).not.toHaveBeenCalled();
    });

    describe("with a sponsorship code (plan 2.7)", () => {
      const sponsorship = {
        id: "sp1",
        eventId: "ev1",
        code: "SP-ABCD2345",
        status: "PENDING",
        targetRegistrationId: null,
        totalAmount: 100,
        coversBasePrice: true,
        coveredAccessIds: [],
      };
      const settledAs = (paymentStatus: string, sponsorshipAmount: number, incremented: string[] = []) => ({
        written: true,
        eventId: "ev1",
        before: { paymentStatus: "PENDING", sponsorshipAmount: 0 },
        after: { paymentStatus, sponsorshipAmount },
        coveredAccessIds: [],
        paidAccess: { incremented, decremented: [] },
      });
      const withCode = (code: string) => ({ ...baseInput, sponsorshipCode: code }) as never;

      beforeEach(() => {
        db.claimSponsorshipCodeTxn.mockResolvedValue({ outcome: "available", sponsorship });
        db.linkSponsorshipUsageTxn.mockResolvedValue({ id: "use1", sponsorshipId: "sp1", amountApplied: 100 });
      });

      it("locks the normalized code first, then consumes it: usage + USED, settled SPONSORED", async () => {
        const order: string[] = [];
        db.claimSponsorshipCodeTxn.mockImplementation(async () => {
          order.push("claim");
          return { outcome: "available", sponsorship };
        });
        db.getEventForRegistrationCreate.mockImplementation(async () => {
          order.push("event");
          return { clientId: "c1", status: "OPEN", endDate: FUTURE, maxCapacity: null, registeredCount: 0, client: activeClient() };
        });
        db.allocateReferenceNumber.mockImplementation(async () => {
          order.push("reference");
          return "26-EV-001";
        });

        db.settleRegistrationTxn.mockResolvedValueOnce(settledAs("SPONSORED", 100, ["acc1"]));
        await service.createRegistration(withCode("  sp-abcd2345 "), emptyBreakdown(100));

        expect(order).toEqual(["claim", "event", "reference"]);
        expect(db.withLockingTxn).toHaveBeenCalledTimes(1);
        expect(db.claimSponsorshipCodeTxn).toHaveBeenCalledWith(expect.anything(), "ev1", "SP-ABCD2345");
        const stored = db.insertRegistrationRow.mock.calls[0][0];
        expect(stored).toMatchObject({ sponsorshipCode: "SP-ABCD2345", sponsorshipAmount: 0, totalAmount: 100, paymentStatus: "PENDING" });
        expect(db.linkSponsorshipUsageTxn).toHaveBeenCalledWith(expect.anything(), {
          sponsorship,
          registrationId: "reg1",
          priceBreakdown: expect.objectContaining({ subtotal: 100, sponsorshipTotal: 0 }),
          appliedBy: "PUBLIC",
        });
        const [, settledId, options] = db.settleRegistrationTxn.mock.calls[0];
        expect(settledId).toBe("reg1");
        expect(options).toMatchObject({
          coveredAccessIdsBefore: [],
          priceBreakdown: { subtotal: 100, sponsorships: [{ code: "SP-ABCD2345", amount: 100, valid: true }] },
        });
        expect(access.handleCapacityReached).toHaveBeenCalledWith("ev1", ["acc1"], expect.anything());
      });

      it("audits LINK_TO_REGISTRATION and emits sponsorship.linked with the settled status", async () => {
        db.settleRegistrationTxn.mockResolvedValueOnce(settledAs("SPONSORED", 100));
        await service.createRegistration(withCode("SP-ABCD2345"), emptyBreakdown(100));

        const audits = db.insertAuditLog.mock.calls.map((c) => c[0]);
        expect(audits).toContainEqual(expect.objectContaining({
          entityType: "Sponsorship",
          entityId: "sp1",
          action: "LINK_TO_REGISTRATION",
          performedBy: "PUBLIC",
          changes: expect.objectContaining({
            registrationId: { old: null, new: "reg1" },
            amountApplied: { old: 0, new: 100 },
            status: { old: "PENDING", new: "USED" },
          }),
        }));
        expect(audits).toContainEqual(expect.objectContaining({
          entityType: "Registration",
          action: "CREATE",
          changes: expect.objectContaining({
            sponsorshipCode: { old: null, new: "SP-ABCD2345" },
            paymentStatus: { old: null, new: "SPONSORED" },
          }),
        }));
        const events = db.enqueueRealtimeOutboxEvent.mock.calls.map((c) => c[1]);
        expect(events.find((e) => e.type === "registration.created")?.payload).toMatchObject({ id: "reg1", paymentStatus: "SPONSORED" });
        expect(events.find((e) => e.type === "sponsorship.linked")?.payload).toEqual({ id: "sp1", registrationId: "reg1" });
      });

      it("400 INVALID_SPONSORSHIP_CODE for an unknown or cancelled code; nothing is written", async () => {
        db.claimSponsorshipCodeTxn.mockResolvedValue({ outcome: "invalid" });
        await expect(service.createRegistration(withCode("SP-NOPE"), emptyBreakdown(100)))
          .rejects.toMatchObject({ code: ErrorCodes.INVALID_SPONSORSHIP_CODE, statusCode: 400 });
        expect(db.insertRegistrationRow).not.toHaveBeenCalled();
        expect(db.allocateReferenceNumber).not.toHaveBeenCalled();
        expect(db.casIncrementRegisteredTx).not.toHaveBeenCalled();
      });

      it.each(["USED", "TARGETED", "LINKED", "CLAIMED"])(
        "409 SPONSORSHIP_CODE_ALREADY_USED when the code is %s; nothing is written",
        async (reason) => {
          db.claimSponsorshipCodeTxn.mockResolvedValue({ outcome: "used", reason, sponsorshipId: "sp1" });
          await expect(service.createRegistration(withCode("SP-ABCD2345"), emptyBreakdown(100)))
            .rejects.toMatchObject({ code: ErrorCodes.SPONSORSHIP_CODE_ALREADY_USED, statusCode: 409 });
          expect(db.insertRegistrationRow).not.toHaveBeenCalled();
          expect(db.linkSponsorshipUsageTxn).not.toHaveBeenCalled();
        },
      );

      it("maps a 23505 on the signup-code index to SPONSORSHIP_CODE_ALREADY_USED", async () => {
        db.insertRegistrationRow.mockRejectedValue({
          code: "23505",
          constraint: "registrations_event_id_sponsorship_code_key",
        });
        await expect(service.createRegistration(withCode("SP-ABCD2345"), emptyBreakdown(100)))
          .rejects.toMatchObject({ code: ErrorCodes.SPONSORSHIP_CODE_ALREADY_USED, statusCode: 409 });
      });

      it("maps a paid-capacity failure while settling to ACCESS_CAPACITY_EXCEEDED", async () => {
        db.settleRegistrationTxn.mockRejectedValueOnce(new AccessCapacityExceededError("acc1", "Gala", 0, 1));
        await expect(service.createRegistration(withCode("SP-ABCD2345"), emptyBreakdown(100)))
          .rejects.toMatchObject({ code: ErrorCodes.ACCESS_CAPACITY_EXCEEDED, statusCode: 409 });
        expect(db.enqueueTriggeredEmailOutbox).not.toHaveBeenCalled();
      });

      it("treats a blank code as no code", async () => {
        await service.createRegistration(withCode("   "), emptyBreakdown(100));
        expect(db.claimSponsorshipCodeTxn).not.toHaveBeenCalled();
        expect(db.insertRegistrationRow.mock.calls[0][0].sponsorshipCode).toBeNull();
      });
    });

    it.each([
      ["OPEN", 409, ErrorCodes.EVENT_FULL],
      ["CLOSED", 400, ErrorCodes.EVENT_NOT_OPEN],
    ] as const)(
      "maps a missed event-counter increment on a %s event to %s %s; nothing is announced",
      async (status, statusCode, code) => {
        db.casIncrementRegisteredTx.mockResolvedValue(false);
        db.getEventCounterInfoTx.mockResolvedValue({ status, maxCapacity: 10, registeredCount: 10 });
        await expect(service.createRegistration(baseInput as never, emptyBreakdown(100)))
          .rejects.toMatchObject({ code, statusCode });
        expect(db.enqueueTriggeredEmailOutbox).not.toHaveBeenCalled();
      },
    );

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
    it("prices without the code and returns the settled breakdown as stored (plan 2.7)", async () => {
      const settledBreakdown = {
        ...emptyBreakdown(100),
        sponsorships: [{ code: "SP-ABCD2345", amount: 100, valid: true }],
        sponsorshipTotal: 100,
        total: 0,
      };
      db.getRegistrationByIdempotencyKeyRow.mockResolvedValue(null);
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
      db.insertRegistrationRow.mockResolvedValue({ id: "reg1" });
      db.claimSponsorshipCodeTxn.mockResolvedValue({
        outcome: "available",
        sponsorship: { id: "sp1", eventId: "ev1", code: "SP-ABCD2345", status: "PENDING", targetRegistrationId: null, totalAmount: 100, coversBasePrice: true, coveredAccessIds: [] },
      });
      db.linkSponsorshipUsageTxn.mockResolvedValue({ id: "use1", sponsorshipId: "sp1", amountApplied: 100 });
      db.settleRegistrationTxn.mockResolvedValueOnce({
        written: true,
        eventId: "ev1",
        before: { paymentStatus: "PENDING" },
        after: { paymentStatus: "SPONSORED", sponsorshipAmount: 100 },
        coveredAccessIds: [],
        paidAccess: { incremented: [], decremented: [] },
      });
      db.getRegistrationByIdRow.mockResolvedValue(
        makeRegRow({ paymentStatus: "SPONSORED", sponsorshipAmount: 100, priceBreakdown: settledBreakdown }),
      );

      const res = await service.createPublicRegistration("form1", {
        formData: {},
        email: "a@b.com",
        accessSelections: [],
        sponsorshipCode: "sp-abcd2345",
      } as never);

      expect(pricing.calculatePrice).toHaveBeenCalledWith("ev1", expect.objectContaining({ sponsorshipCodes: [] }));
      expect(res.created).toBe(true);
      expect(res.priceBreakdown).toEqual(settledBreakdown);
      expect(res.registration.paymentStatus).toBe("SPONSORED");
    });

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

  // ---- deleteRegistration --------------------------------------------------
  describe("deleteRegistration", () => {
    beforeEach(() => {
      db.findRegistrationForMutation.mockResolvedValue(
        makeRegRow({
          event: { clientId: "c1", status: "OPEN", client: activeClient() },
        }),
      );
      db.lockRegistrationSponsorships.mockResolvedValue([]);
      db.releaseRegistrationUsagesTxn.mockResolvedValue({ coveredAccessIds: [], sponsorships: [] });
      db.getNetworkingProfilePhotoByRegistration.mockResolvedValue(null);
    });

    it("locks the linked sponsorships, then the registration, then releases its usages", async () => {
      await service.deleteRegistration("reg1", "admin1");
      const [sponsorships] = db.lockRegistrationSponsorships.mock.invocationCallOrder;
      const [registration] = db.lockRegistrationForUpdate.mock.invocationCallOrder;
      const [release] = db.releaseRegistrationUsagesTxn.mock.invocationCallOrder;
      expect(sponsorships).toBeLessThan(registration!);
      expect(registration).toBeLessThan(release!);
      expect(db.withLockingTxn).toHaveBeenCalled();
    });

    it("releases the paid places the covered items held (PARTIAL)", async () => {
      db.findRegistrationForMutation.mockResolvedValue(
        makeRegRow({
          paymentStatus: "PARTIAL",
          priceBreakdown: {
            ...emptyBreakdown(100),
            accessItems: [{ accessId: "acc1", name: "A", unitPrice: 10, quantity: 1, subtotal: 10 }],
          },
          event: { clientId: "c1", status: "OPEN", client: activeClient() },
        }),
      );
      db.releaseRegistrationUsagesTxn.mockResolvedValue({
        coveredAccessIds: ["acc1"],
        sponsorships: [{ id: "s1", before: "CANCELLED", after: "CANCELLED" }],
      });
      await service.deleteRegistration("reg1", "admin1");
      expect(access.syncPaidCountDelta).toHaveBeenCalledWith(
        "ev1",
        expect.objectContaining({ status: "PARTIAL", coveredAccessIds: new Set(["acc1"]) }),
        expect.objectContaining({ status: "PENDING" }),
        expect.anything(),
      );
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

    it("force-deletes a PAID registration and records the force in the audit", async () => {
      db.findRegistrationForMutation.mockResolvedValue(
        makeRegRow({
          paymentStatus: "PAID",
          event: { clientId: "c1", status: "OPEN", client: activeClient() },
        }),
      );
      await service.deleteRegistration("reg1", "admin1", true);
      expect(db.deleteRegistrationRow).toHaveBeenCalled();
      expect(db.insertAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "DELETE",
          changes: expect.objectContaining({ forceDelete: { old: null, new: true } }),
        }),
        expect.anything(),
      );
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
      const updated = await payments.updateRegistration("reg1", { note: "x" } as never, "admin1");
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
