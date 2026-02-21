import { randomUUID } from "crypto";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { findOrThrow } from "@shared/utils/db.js";
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

export async function confirmPayment(
  id: string,
  input: UpdatePaymentInput,
  performedBy?: string,
  ipAddress?: string,
): Promise<RegistrationWithRelations> {
  // Update registration in a transaction with audit logging
  const result = await prisma.$transaction(async (tx) => {
    const oldRegistration = await findOrThrow(
      () =>
        tx.registration.findUnique({
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
        }),
      {
        message: "Registration not found",
        code: ErrorCodes.REGISTRATION_NOT_FOUND,
      },
    );

    // Validate payment status transition
    validatePaymentTransitionInternal(
      oldRegistration.paymentStatus,
      input.paymentStatus,
    );

    // Update registration
    const updated = await tx.registration.update({
      where: { id },
      data: {
        paymentStatus: input.paymentStatus,
        paidAmount: input.paidAmount ?? oldRegistration.totalAmount,
        paymentMethod: input.paymentMethod ?? null,
        paymentReference: input.paymentReference ?? null,
        paymentProofUrl: input.paymentProofUrl ?? null,
        paidAt:
          input.paymentStatus === "PAID" || input.paymentStatus === "WAIVED"
            ? new Date()
            : undefined,
      },
    });

    // Create audit log for payment confirmation
    await tx.auditLog.create({
      data: {
        entityType: "Registration",
        entityId: id,
        action: "PAYMENT_CONFIRMED",
        changes: {
          paymentStatus: {
            old: oldRegistration.paymentStatus,
            new: updated.paymentStatus,
          },
          paidAmount: {
            old: oldRegistration.paidAmount,
            new: updated.paidAmount,
          },
          paymentMethod: {
            old: oldRegistration.paymentMethod,
            new: updated.paymentMethod,
          },
        },
        performedBy: performedBy ?? null,
        ipAddress: ipAddress ?? null,
      },
    });

    return oldRegistration;
  });

  // Queue PAYMENT_CONFIRMED email if status changed to PAID
  if (input.paymentStatus === "PAID" && result.paymentStatus !== "PAID") {
    queueTriggeredEmail("PAYMENT_CONFIRMED", result.eventId, {
      id,
      email: result.email,
      firstName: result.firstName,
      lastName: result.lastName,
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

/**
 * Upload payment proof for a registration.
 * Compresses images to WebP, uploads to storage provider,
 * updates registration, and queues notification email.
 */
export async function uploadPaymentProof(
  registrationId: string,
  file: { buffer: Buffer; filename: string; mimetype: string },
): Promise<PaymentProofResponse> {
  // Validate file type
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new AppError(
      "Invalid file type. Allowed: PNG, JPG, PDF",
      400,
      true,
      ErrorCodes.INVALID_FILE_TYPE,
    );
  }

  // Validate file size
  if (file.buffer.length > MAX_FILE_SIZE) {
    throw new AppError(
      "File too large. Maximum: 10MB",
      400,
      true,
      ErrorCodes.FILE_TOO_LARGE,
    );
  }

  // Get registration with event info and current status
  const registration = await findOrThrow(
    () =>
      prisma.registration.findUnique({
        where: { id: registrationId },
        select: {
          eventId: true,
          email: true,
          firstName: true,
          lastName: true,
          paymentStatus: true,
          paymentProofUrl: true,
        },
      }),
    {
      message: "Registration not found",
      code: ErrorCodes.REGISTRATION_NOT_FOUND,
    },
  );

  // Only allow proof upload from PENDING or VERIFYING status
  validatePaymentTransitionInternal(registration.paymentStatus, "VERIFYING");

  // Compress file (images → WebP, PDFs → passthrough)
  const compressed = await compressFile(file.buffer, file.mimetype);

  // Generate storage key
  const key = `${registration.eventId}/${registrationId}/proof.${compressed.ext}`;

  const storage = getStorageProvider();

  // Delete old proof if exists
  if (registration.paymentProofUrl) {
    try {
      const oldKey = extractKeyFromUrl(registration.paymentProofUrl);
      if (oldKey) {
        await storage.delete(oldKey);
      }
    } catch (err) {
      logger.warn(
        { err, registrationId },
        "Failed to delete old payment proof",
      );
    }
  }

  // Upload compressed file
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

  // Update registration with payment proof URL, set status to VERIFYING, and create audit log
  await prisma.$transaction(async (tx) => {
    await tx.registration.update({
      where: { id: registrationId },
      data: {
        paymentProofUrl: fileUrl,
        paymentStatus: "VERIFYING",
        paymentMethod: "BANK_TRANSFER",
      },
    });

    // Create audit log for payment proof upload
    await tx.auditLog.create({
      data: {
        entityType: "Registration",
        entityId: registrationId,
        action: "PAYMENT_PROOF_UPLOADED",
        changes: {
          paymentStatus: { old: registration.paymentStatus, new: "VERIFYING" },
          paymentProofUrl: { old: registration.paymentProofUrl, new: fileUrl },
        },
        performedBy: "PUBLIC",
      },
    });
  });

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
