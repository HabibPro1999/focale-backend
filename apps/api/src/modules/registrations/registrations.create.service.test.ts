import { ErrorCodes } from "@app/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/db", async (importOriginal) =>
  (await import("./__testing__/service-mocks.js")).mockDbModule(importOriginal),
);

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
} from "./__testing__/service-mocks";
import { AccessCapacityExceededError } from "@app/db";
import { RegistrationCreateService } from "./registrations.create.service";
import { RegistrationSideEffects } from "./registrations.side-effects";
import { AppException } from "../../core/app-exception";
import type { Config } from "../../core/config";
import type { AccessService } from "../access/access.service";
import type { PricingService } from "../pricing/pricing.service";

describe("RegistrationCreateService", () => {
  let service: RegistrationCreateService;
  let access: AccessMock;
  let pricing: PricingMock;

  beforeEach(() => {
    ({ access, pricing } = installServiceMocks());

    service = new RegistrationCreateService(
      access as unknown as AccessService,
      pricing as unknown as PricingService,
      {
        publicLinkAllowedOrigins: ["https://events.example.com"],
      } as Config,
      new RegistrationSideEffects(access as unknown as AccessService),
    );
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

    // Plan 4.8: the networking projection no longer rides the created email,
    // so a registration created without it is projected too.
    it("enqueues the networking projection even when no created email is sent", async () => {
      await service.createAdminRegistration(
        "ev1",
        { email: "quiet@example.com", firstName: "Q", lastName: "R", formData: {}, accessSelections: [], sendEmail: false } as never,
        "admin1",
      );
      expect(db.enqueueTriggeredEmailOutbox).not.toHaveBeenCalled();
      expect(db.enqueueNetworkingRegistrationCreatedSync).toHaveBeenCalledWith(expect.anything(), {
        registrationId: "reg1",
        eventId: "ev1",
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
      // Plan 4.8: an outbox row in the create transaction, never the sync itself.
      expect(db.enqueueNetworkingRegistrationCreatedSync).toHaveBeenCalledTimes(1);
      expect(db.enqueueNetworkingRegistrationCreatedSync).toHaveBeenCalledWith(expect.anything(), {
        registrationId: "reg1",
        eventId: "ev1",
      });
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

  // ---- 0.5: response shapes (no credentials / internal fields) -------------
  describe("response shapes", () => {
    it("admin create responses never carry editToken", async () => {
      db.getRegistrationByIdRow.mockResolvedValue(internalRow());
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
  });
});
