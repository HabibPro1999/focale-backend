import { ErrorCodes } from "@app/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/db", async (importOriginal) =>
  (await import("./__testing__/service-mocks.js")).mockDbModule(importOriginal),
);

import {
  FUTURE,
  activeClient,
  db,
  emptyBreakdown,
  installServiceMocks,
  internalRow,
  makeRegRow,
  sponsoredBreakdown,
  writtenPatch,
  type AccessMock,
} from "./__testing__/service-mocks";
import { RegistrationPaymentsService } from "./registrations.payments.service";
import { RegistrationSideEffects } from "./registrations.side-effects";
import type { AccessService } from "../access/access.service";

describe("RegistrationPaymentsService", () => {
  let service: RegistrationPaymentsService;
  let access: AccessMock;

  beforeEach(() => {
    ({ access } = installServiceMocks());

    service = new RegistrationPaymentsService(
      access as unknown as AccessService,
      new RegistrationSideEffects(access as unknown as AccessService),
    );
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

    it("404 REG_8001 when the registration is gone (no row to lock)", async () => {
      db.lockRegistrationForUpdate.mockResolvedValue(false);
      await expect(
        service.selectPaymentMethod("reg1", { paymentMethod: "CASH" } as never),
      ).rejects.toMatchObject({ code: "REG_8001", message: "Registration not found", statusCode: 404 });
      expect(db.applyRegistrationSettlement).not.toHaveBeenCalled();
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

  // ---- 0.5: response shapes (no credentials / internal fields) -------------
  describe("response shapes", () => {
    it("admin update responses never carry editToken", async () => {
      db.getRegistrationByIdRow.mockResolvedValue(internalRow());
      db.findRegistrationForMutation.mockResolvedValue(
        internalRow({ event: { clientId: "c1", status: "OPEN", client: activeClient() } }),
      );
      const updated = await service.updateRegistration("reg1", { note: "x" } as never, "admin1");
      expect(updated).not.toHaveProperty("editToken");
      expect(updated).not.toHaveProperty("idempotencyKey");
    });
  });
});
