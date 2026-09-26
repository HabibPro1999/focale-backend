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
  activeClient,
  db,
  ft,
  installServiceMocks,
  integ,
  makeRegRow,
  writtenPatch,
  type StorageMock,
} from "./__testing__/service-mocks";
import { PaymentProofService } from "./registrations.payment-proof.service";
import { RegistrationSideEffects } from "./registrations.side-effects";
import type { AccessService } from "../access/access.service";

describe("PaymentProofService", () => {
  let service: PaymentProofService;
  let storage: StorageMock;

  beforeEach(() => {
    const mocks = installServiceMocks();
    storage = mocks.storage;
    service = new PaymentProofService(
      new RegistrationSideEffects(mocks.access as unknown as AccessService),
    );
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

    it("404 REG_8001 when the registration is gone by the locked re-read, and the new object is removed", async () => {
      storage.uploadPrivate.mockImplementation(async (_buffer: Buffer, key: string) => key);
      db.findRegistrationWithFormEvent.mockResolvedValue(proofFetch());
      db.lockRegistrationForUpdate.mockResolvedValue(false);
      await expect(service.uploadPaymentProof("reg1", pdf())).rejects.toMatchObject({
        code: "REG_8001",
        message: "Registration not found",
        statusCode: 404,
      });
      expect(db.applyRegistrationSettlement).not.toHaveBeenCalled();
      expect(storage.delete).toHaveBeenCalledWith(storage.uploadPrivate.mock.calls[0]![1]);
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
});
