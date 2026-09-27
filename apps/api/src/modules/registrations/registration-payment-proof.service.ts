import { ErrorCodes } from "@app/contracts";
import { enqueueTriggeredEmailOutbox, updateRegistrationRow, withTxn } from "@app/db";
import { compressFile, getStorageProvider, ownedStorageKey } from "@app/integrations";
import { Injectable } from "@nestjs/common";
import { fileTypeFromBuffer } from "file-type";
import { randomUUID } from "node:crypto";
import { AppException, badRequest } from "../../core/app-exception";
import { logger } from "../../core/logger.service";
import { validatePaymentTransition } from "./payment-transitions";
import { requireRegistrationForPublicAction } from "./registrations.guards";
import { audit } from "./registrations.side-effects";

const ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export interface PaymentProofResponse {
  id: string;
  registrationId: string;
  fileUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: string;
}

@Injectable()
export class RegistrationPaymentProofService {
  // ==========================================================================
  // Payment-proof upload (public) — magic-byte gate, storage, re-validating txn
  // ==========================================================================

  async uploadPaymentProof(
    registrationId: string,
    file: { buffer: Buffer; filename: string; mimetype: string },
  ): Promise<PaymentProofResponse> {
    // 1. Header allowlist — fast reject on the client-supplied mimetype.
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw badRequest("Invalid file type. Allowed: PNG, JPG, WebP, PDF", { code: ErrorCodes.INVALID_FILE_TYPE });
    }
    // 2. Authoritative magic-byte detection.
    const detectedType = await fileTypeFromBuffer(file.buffer);
    if (!detectedType) {
      throw badRequest("Unable to determine file type. Please upload a valid PNG, JPG, or PDF.", { code: ErrorCodes.INVALID_FILE_TYPE });
    }
    if (!ALLOWED_MIME_TYPES.includes(detectedType.mime)) {
      throw badRequest("File content does not match allowed types. Allowed: PNG, JPG, WebP, PDF", { code: ErrorCodes.INVALID_FILE_TYPE });
    }
    // 3. Size.
    if (file.buffer.length > MAX_FILE_SIZE) {
      throw badRequest("File too large. Maximum: 10MB", { code: ErrorCodes.FILE_TOO_LARGE });
    }

    // 4. Pre-upload state check (outside tx).
    const registration = await requireRegistrationForPublicAction(registrationId, ErrorCodes.REGISTRATION_NOT_FOUND);
    validatePaymentTransition(registration.paymentStatus, "VERIFYING");

    // 5. Compress (images → WebP, PDFs passthrough) using the DETECTED type.
    const compressed = await compressFile(file.buffer, detectedType.mime);
    const ownedPrefix = `${registration.eventId}/${registrationId}`;
    // A fresh key per upload, so the proof the row points at is never overwritten.
    const key = `${ownedPrefix}/proof-${randomUUID()}.${compressed.ext}`;
    const storage = getStorageProvider();
    const deleteBestEffort = async (objectKey: string, message: string) => {
      try {
        await storage.delete(objectKey);
      } catch (err) {
        logger.warn({ err, key: objectKey, registrationId }, message);
      }
    };

    // 6. Private upload (signed-URL access only).
    let fileUrl: string;
    try {
      fileUrl = await storage.uploadPrivate(
        compressed.buffer,
        key,
        compressed.contentType,
        { contentDisposition: "attachment" },
      );
    } catch {
      throw new AppException(
        ErrorCodes.INTERNAL_ERROR,
        "Failed to upload file. Please try again.",
        500,
      );
    }

    // 7. Second txn — re-validate post-upload state, then persist. Resolves with
    //    the proof URL it replaced. On failure the row keeps the old proof and
    //    the new object is removed.
    const replacedUrl = await withTxn(async (tx) => {
      const currentReg = await requireRegistrationForPublicAction(registrationId, ErrorCodes.NOT_FOUND, tx);
      validatePaymentTransition(currentReg.paymentStatus, "VERIFYING");

      await updateRegistrationRow(
        registrationId,
        {
          paymentProofUrl: fileUrl,
          paymentStatus: "VERIFYING",
          paymentMethod: "BANK_TRANSFER",
        },
        tx,
      );

      await audit(tx, {
        entityId: registrationId,
        action: "PAYMENT_PROOF_UPLOADED",
        changes: {
          paymentStatus: { old: currentReg.paymentStatus, new: "VERIFYING" },
          paymentProofUrl: { old: currentReg.paymentProofUrl, new: fileUrl },
        },
        performedBy: "PUBLIC",
      });

      await enqueueTriggeredEmailOutbox(
        tx,
        {
          trigger: "PAYMENT_PROOF_SUBMITTED",
          eventId: registration.eventId,
          registration: {
            id: registrationId,
            email: registration.email,
            firstName: registration.firstName ?? null,
            lastName: registration.lastName ?? null,
          },
        },
        `email:triggered:PAYMENT_PROOF_SUBMITTED:${registrationId}`,
      );
      return currentReg.paymentProofUrl ?? null;
    }).catch(async (err: unknown): Promise<never> => {
      await deleteBestEffort(key, "Failed to delete unreferenced payment proof");
      throw err;
    });

    // 8. Best-effort delete of the proof this upload replaced — only when it is
    //    this registration's object (admin edits can store an arbitrary URL).
    if (replacedUrl && replacedUrl !== fileUrl) {
      const oldKey = ownedStorageKey(replacedUrl, ownedPrefix);
      if (oldKey) await deleteBestEffort(oldKey, "Failed to delete old payment proof");
    }

    return {
      id: randomUUID(),
      registrationId,
      fileUrl,
      fileName: `proof.${compressed.ext}`,
      fileSize: compressed.buffer.length,
      mimeType: compressed.contentType,
      uploadedAt: new Date().toISOString(),
    };
  }
}
