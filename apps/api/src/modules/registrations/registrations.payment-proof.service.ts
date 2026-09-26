import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { fileTypeFromBuffer } from "file-type";
import {
  getStorageProvider,
  compressFile,
  ownedStorageKey,
} from "@app/integrations";
import { ErrorCodes } from "@app/contracts";
import {
  withLockingTxn,
  lockRegistrationForUpdate,
  enqueueTriggeredEmailOutbox,
  applyRegistrationSettlement,
  findRegistrationWithFormEvent,
} from "@app/db";
import { assertEventAcceptsPublicActions } from "../events";
import {
  assertModuleEnabledForClient,
  type ClientModuleState,
} from "../clients/module-gates";
import { AppException } from "../../core/app-exception";
import { logger } from "../../core/logger.service";
import { validatePaymentTransition } from "./payment-transitions";
import { RegistrationSideEffects } from "./registrations.side-effects";

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

/** Public payment-proof upload for a registrant (edit-token route). */
@Injectable()
export class PaymentProofService {
  constructor(private readonly sideEffects: RegistrationSideEffects) {}

  // ==========================================================================
  // Payment-proof upload (public) — magic-byte gate, storage, re-validating txn
  // ==========================================================================

  async uploadPaymentProof(
    registrationId: string,
    file: { buffer: Buffer; filename: string; mimetype: string },
  ): Promise<PaymentProofResponse> {
    // 1. Header allowlist — fast reject on the client-supplied mimetype.
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new AppException(
        ErrorCodes.INVALID_FILE_TYPE,
        "Invalid file type. Allowed: PNG, JPG, WebP, PDF",
        400,
      );
    }
    // 2. Authoritative magic-byte detection.
    const detectedType = await fileTypeFromBuffer(file.buffer);
    if (!detectedType) {
      throw new AppException(
        ErrorCodes.INVALID_FILE_TYPE,
        "Unable to determine file type. Please upload a valid PNG, JPG, or PDF.",
        400,
      );
    }
    if (!ALLOWED_MIME_TYPES.includes(detectedType.mime)) {
      throw new AppException(
        ErrorCodes.INVALID_FILE_TYPE,
        "File content does not match allowed types. Allowed: PNG, JPG, WebP, PDF",
        400,
      );
    }
    // 3. Size.
    if (file.buffer.length > MAX_FILE_SIZE) {
      throw new AppException(
        ErrorCodes.FILE_TOO_LARGE,
        "File too large. Maximum: 10MB",
        400,
      );
    }

    // 4. Pre-upload state check (outside tx).
    const registration = await findRegistrationWithFormEvent(registrationId);
    if (!registration) {
      throw new AppException(
        ErrorCodes.REGISTRATION_NOT_FOUND,
        "Registration not found",
        404,
      );
    }
    assertEventAcceptsPublicActions(registration.event);
    assertModuleEnabledForClient(
      registration.event.client as ClientModuleState,
      "registrations",
    );
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

    // 7. Second txn — lock, re-read and re-validate the post-upload state, then
    //    persist. The lock makes a concurrent confirmation either wait for this
    //    write or be seen by the re-check (PAID → VERIFYING is refused), so a
    //    confirmation is never overwritten. Resolves with the proof URL it
    //    replaced. On failure the row keeps the old proof and the new object is
    //    removed.
    const replacedUrl = await withLockingTxn(async (tx) => {
      const locked = await lockRegistrationForUpdate(tx, registrationId);
      const currentReg = locked
        ? await findRegistrationWithFormEvent(registrationId, tx)
        : null;
      if (!currentReg) {
        throw new AppException(ErrorCodes.REGISTRATION_NOT_FOUND, "Registration not found", 404);
      }
      assertEventAcceptsPublicActions(currentReg.event);
      assertModuleEnabledForClient(
        currentReg.event.client as ClientModuleState,
        "registrations",
      );
      validatePaymentTransition(currentReg.paymentStatus, "VERIFYING");

      await applyRegistrationSettlement(tx, {
        registrationId,
        settlement: { paymentStatus: "VERIFYING" },
        fields: { paymentProofUrl: fileUrl, paymentMethod: "BANK_TRANSFER" },
      });

      await this.sideEffects.audit(tx, {
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
