import { randomUUID } from "crypto";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";
import { logger } from "@shared/utils/logger.js";
import { queueTriggeredEmail } from "@email";
import { getStorageProvider } from "@shared/services/storage/index.js";
import { compressFile } from "@shared/services/storage/compress.js";
import type { UpdatePaymentInput } from "./registrations.schema.js";
import type { RegistrationWithRelations } from "./registration-crud.service.js";
import {
  getRegistrationById,
  validatePaymentTransitionInternal,
} from "./registration-crud.service.js";

// ============================================================================
// Payment Proof Upload
// ============================================================================

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "application/pdf"];
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

type OldRegistrationSnapshot = {
  eventId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  paymentStatus: string;
  paidAmount: number;
  paymentMethod: string | null;
  totalAmount: number;
};

async function executeConfirmPaymentTransaction(
  id: string,
  input: UpdatePaymentInput,
  performedBy: string | undefined,
  ipAddress: string | undefined,
): Promise<OldRegistrationSnapshot> {
  return prisma.$transaction(async (tx) => {
    const old = await tx.registration.findUnique({
      where: { id },
      select: {
        eventId: true,
        email: true,
        firstName: true,
        lastName: true,
        paymentStatus: true,
        paidAmount: true,
        paymentMethod: true,
        totalAmount: true,
      },
    });
    if (!old) {
      throw new AppError(
        "Registration not found",
        404,
        true,
        ErrorCodes.REGISTRATION_NOT_FOUND,
      );
    }

    validatePaymentTransitionInternal(old.paymentStatus, input.paymentStatus);

    const updated = await tx.registration.update({
      where: { id },
      data: {
        paymentStatus: input.paymentStatus,
        paidAmount: input.paidAmount ?? old.totalAmount,
        paymentMethod: input.paymentMethod ?? null,
        paymentReference: input.paymentReference ?? null,
        paymentProofUrl: input.paymentProofUrl ?? null,
        paidAt:
          input.paymentStatus === "PAID" || input.paymentStatus === "WAIVED"
            ? new Date()
            : undefined,
      },
    });

    await tx.auditLog.create({
      data: {
        entityType: "Registration",
        entityId: id,
        action: "PAYMENT_CONFIRMED",
        changes: {
          paymentStatus: { old: old.paymentStatus, new: updated.paymentStatus },
          paidAmount: { old: old.paidAmount, new: updated.paidAmount },
          paymentMethod: { old: old.paymentMethod, new: updated.paymentMethod },
        },
        performedBy: performedBy ?? null,
        ipAddress: ipAddress ?? null,
      },
    });

    return old;
  });
}

export async function confirmPayment(
  id: string,
  input: UpdatePaymentInput,
  performedBy?: string,
  ipAddress?: string,
): Promise<RegistrationWithRelations> {
  const old = await executeConfirmPaymentTransaction(
    id,
    input,
    performedBy,
    ipAddress,
  );

  if (input.paymentStatus === "PAID" && old.paymentStatus !== "PAID") {
    queueTriggeredEmail("PAYMENT_CONFIRMED", old.eventId, {
      id,
      email: old.email,
      firstName: old.firstName,
      lastName: old.lastName,
    }).catch((err) => {
      logger.error(
        { err, registrationId: id },
        "Failed to queue PAYMENT_CONFIRMED email",
      );
    });
  }

  const updated = await getRegistrationById(id);
  if (!updated) {
    throw new AppError(
      "Registration not found after update",
      500,
      true,
      ErrorCodes.INTERNAL_ERROR,
    );
  }
  return updated;
}

function validatePaymentFile(file: {
  buffer: Buffer;
  mimetype: string;
}): void {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new AppError(
      "Invalid file type. Allowed: PNG, JPG, PDF",
      400,
      true,
      ErrorCodes.INVALID_FILE_TYPE,
    );
  }

  if (file.buffer.length > MAX_FILE_SIZE) {
    throw new AppError(
      "File too large. Maximum: 10MB",
      400,
      true,
      ErrorCodes.FILE_TOO_LARGE,
    );
  }
}

async function handleProofStorage(
  file: { buffer: Buffer; mimetype: string },
  registration: { eventId: string; paymentProofUrl: string | null },
  registrationId: string,
): Promise<{
  fileUrl: string;
  compressed: { ext: string; contentType: string; buffer: Buffer };
}> {
  const compressed = await compressFile(file.buffer, file.mimetype);
  const key = `${registration.eventId}/${registrationId}/proof.${compressed.ext}`;
  const storage = getStorageProvider();

  if (registration.paymentProofUrl) {
    try {
      const oldKey = extractKeyFromUrl(registration.paymentProofUrl);
      if (oldKey) {
        await storage.delete(oldKey);
      }
    } catch (err) {
      logger.warn({ err, registrationId }, "Failed to delete old payment proof");
    }
  }

  let fileUrl: string;
  try {
    fileUrl = await storage.upload(
      compressed.buffer,
      key,
      compressed.contentType,
    );
  } catch (error) {
    logger.error(
      { err: error, registrationId, key },
      "Failed to upload payment proof",
    );
    throw new AppError(
      "Failed to upload file. Please try again.",
      500,
      true,
      ErrorCodes.INTERNAL_ERROR,
    );
  }

  return { fileUrl, compressed };
}

async function saveProofAndAudit(
  registrationId: string,
  fileUrl: string,
  oldStatus: string,
  oldProofUrl: string | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.registration.update({
      where: { id: registrationId },
      data: {
        paymentProofUrl: fileUrl,
        paymentStatus: "VERIFYING",
        paymentMethod: "BANK_TRANSFER",
      },
    });

    await tx.auditLog.create({
      data: {
        entityType: "Registration",
        entityId: registrationId,
        action: "PAYMENT_PROOF_UPLOADED",
        changes: {
          paymentStatus: { old: oldStatus, new: "VERIFYING" },
          paymentProofUrl: { old: oldProofUrl, new: fileUrl },
        },
        performedBy: "PUBLIC",
      },
    });
  });
}

/**
 * Upload payment proof for a registration.
 * Compresses images to WebP, uploads to storage provider,
 * updates registration, and queues notification email.
 */
export async function uploadPaymentProof(
  registrationId: string,
  file: { buffer: Buffer; filename: string; mimetype: string },
): Promise<PaymentProofResponse> {
  validatePaymentFile(file);

  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    select: {
      eventId: true,
      email: true,
      firstName: true,
      lastName: true,
      paymentStatus: true,
      paymentProofUrl: true,
    },
  });
  if (!registration) {
    throw new AppError(
      "Registration not found",
      404,
      true,
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );
  }

  // Only allow proof upload from PENDING or VERIFYING status
  validatePaymentTransitionInternal(registration.paymentStatus, "VERIFYING");

  const { fileUrl, compressed } = await handleProofStorage(
    file,
    registration,
    registrationId,
  );

  await saveProofAndAudit(
    registrationId,
    fileUrl,
    registration.paymentStatus,
    registration.paymentProofUrl,
  );

  // Queue email notification to admin
  await queueTriggeredEmail("PAYMENT_PROOF_SUBMITTED", registration.eventId, {
    id: registrationId,
    email: registration.email,
    firstName: registration.firstName,
    lastName: registration.lastName,
  }).catch((err) => {
    logger.error(
      { err, registrationId },
      "Failed to queue PAYMENT_PROOF_SUBMITTED email",
    );
  });

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

/**
 * Extract storage key from a full URL.
 * Handles both Firebase and R2 URL formats.
 */
export function extractKeyFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    // Firebase: https://storage.googleapis.com/bucket-name/path/to/file
    if (parsed.hostname === "storage.googleapis.com") {
      // Path is /bucket-name/path/to/file — strip the bucket name
      const parts = parsed.pathname.split("/").filter(Boolean);
      return parts.slice(1).join("/");
    }
    // R2 public URL or custom domain: https://cdn.example.com/path/to/file
    // Just return everything after the first /
    return parsed.pathname.slice(1);
  } catch {
    return null;
  }
}
