import { ErrorCodes } from "@app/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyRegistrationSettlementInput } from "@app/db";

vi.mock("@app/db", async (importOriginal) =>
  (await import("./__testing__/service-mocks.js")).mockDbModule(importOriginal),
);

import { calculateSettlement } from "@app/shared";
import {
  ANSWER_SCHEMA,
  FUTURE,
  PUBLIC_KEYS,
  activeClient,
  db,
  emptyBreakdown,
  installServiceMocks,
  internalRow,
  makeRegRow,
  sponsoredBreakdown,
  withoutSentinels,
  writtenPatch,
  type AccessMock,
  type PricingMock,
} from "./__testing__/service-mocks";
import { validateSelections } from "../access/access-validation";
import { RegistrationRepricer } from "./registrations.repricer";
import { RegistrationSideEffects } from "./registrations.side-effects";
import { AppException } from "../../core/app-exception";
import type { AccessService } from "../access/access.service";
import type { PricingService } from "../pricing/pricing.service";

describe("RegistrationRepricer", () => {
  let service: RegistrationRepricer;
  let access: AccessMock;
  let pricing: PricingMock;

  beforeEach(() => {
    ({ access, pricing } = installServiceMocks());

    service = new RegistrationRepricer(
      access as unknown as AccessService,
      pricing as unknown as PricingService,
      new RegistrationSideEffects(access as unknown as AccessService),
    );
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

    it("400 CHK_17004 for a registration of another event (as at check-in), before any write", async () => {
      db.findRegistrationForMutation.mockResolvedValue(adminRow({ eventId: "ev-other" }));
      await expect(
        service.adminEditRegistration("ev1", "reg1", { note: "n" } as never, "admin1"),
      ).rejects.toMatchObject({
        code: ErrorCodes.CHECKIN_EVENT_MISMATCH,
        message: "Registration does not belong to this event",
        statusCode: 400,
      });
      expect(db.applyRegistrationSettlement).not.toHaveBeenCalled();
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
      const counts = db.enqueueRealtimeOutboxEvent.mock.calls
        .map((call) => call[1])
        .find((event) => event.type === "eventAccess.countsChanged");
      expect(counts?.payload.accessIds).toEqual(["acc-a", "acc-b", "acc-d"]);
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

  // ---- 0.5: response shapes (no credentials / internal fields) -------------
  describe("response shapes", () => {
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
  });
});
