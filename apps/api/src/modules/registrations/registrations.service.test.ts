import { ErrorCodes } from "@app/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/db", async (importOriginal) =>
  (await import("./__testing__/service-mocks.js")).mockDbModule(importOriginal),
);
vi.mock("@app/integrations", async (importOriginal) =>
  (await import("./__testing__/service-mocks.js")).mockIntegrationsModule(importOriginal),
);
vi.mock("file-type", async () => (await import("./__testing__/service-mocks.js")).ft);

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
  type StorageMock,
} from "./__testing__/service-mocks";
import { RegistrationsService } from "./registrations.service";
import { RegistrationSideEffects } from "./registrations.side-effects";
import type { AccessService } from "../access/access.service";

describe("RegistrationsService", () => {
  let service: RegistrationsService;
  let access: AccessMock;
  let storage: StorageMock;

  beforeEach(() => {
    ({ access, storage } = installServiceMocks());

    service = new RegistrationsService(
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
