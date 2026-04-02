import { randomUUID } from "crypto";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { logger } from "@shared/utils/logger.js";
import { auditLog } from "@shared/utils/audit.js";
import { queueTriggeredEmail } from "@email";
import { getStorageProvider } from "@shared/services/storage/index.js";
import { compressFile } from "@shared/services/storage/compress.js";
import { fileTypeFromBuffer } from "file-type";
import { enrichWithAccessSelections } from "./registration-enrichment.js";
import type { RegistrationWithRelations } from "./registration-enrichment.js";
import type { UpdatePaymentInput } from "./registrations.schema.js";

// ============================================================================
// Payment Status State Machine
// ============================================================================

const PAYMENT_STATUS_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["VERIFYING", "PAID", "WAIVED", "REFUNDED"],
  VERIFYING: ["PAID", "PENDING", "REFUNDED"], // Can confirm, reject (back to PENDING), or refund
  PAID: ["REFUNDED"],
  WAIVED: ["REFUNDED"],
  REFUNDED: [], // Terminal state
};

/**
 * Validate payment status transition.
 * Throws if transition is not allowed.
 */
export function validatePaymentTransition(
  currentStatus: string,
  newStatus: string,
): void {
  if (currentStatus === newStatus) return; // No transition

  const allowed = PAYMENT_STATUS_TRANSITIONS[currentStatus] ?? [];
  if (!allowed.includes(newStatus)) {
    throw new AppError(
      `Cannot transition payment from ${currentStatus} to ${newStatus}`,
      400,
      ErrorCodes.INVALID_PAYMENT_TRANSITION,
    );
  }
}

// ============================================================================
// Confirm Payment (Admin)
// ============================================================================

export async function confirmPayment(
  id: string,
  input: UpdatePaymentInput,
  performedBy?: string,
  ipAddress?: string,
): Promise<RegistrationWithRelations> {
  // Capture pre-tx state for email queuing (email runs outside tx)
  let prevStatus: string | null = null;
  let eventId: string | null = null;
  let email: string | null = null;
  let firstName: string | null = null;
  let lastName: string | null = null;

  await prisma.$transaction(async (tx) => {
    const oldRegistration = await tx.registration.findUnique({
      where: { id },
      select: {
        eventId: true,
        email: true,
        firstName: true,
        lastName: true,
        paymentStatus: true,
        paidAmount: true,
        paymentMethod: true,
        paymentReference: true,
        paymentProofUrl: true,
        totalAmount: true,
      },
    });

    if (!oldRegistration) {
      throw new AppError(
        "Registration not found",
        404,
        ErrorCodes.REGISTRATION_NOT_FOUND,
      );
    }

    // Validate payment status transition
    validatePaymentTransition(
      oldRegistration.paymentStatus,
      input.paymentStatus,
    );

    // Warn if paid amount differs from total amount
    const effectivePaidAmount = input.paidAmount ?? oldRegistration.totalAmount;
    if (effectivePaidAmount !== oldRegistration.totalAmount) {
      logger.warn(
        { registrationId: id, paidAmount: effectivePaidAmount, totalAmount: oldRegistration.totalAmount },
        "Payment confirmation amount differs from total amount",
      );
    }

    // Update registration
    const newStatus = input.paymentStatus;
    const updated = await tx.registration.update({
      where: { id },
      data: {
        paymentStatus: newStatus,
        paidAmount: input.paidAmount ?? oldRegistration.totalAmount,
        paymentMethod: input.paymentMethod ?? oldRegistration.paymentMethod,
        paymentReference:
          input.paymentReference ?? oldRegistration.paymentReference,
        paymentProofUrl:
          input.paymentProofUrl ?? oldRegistration.paymentProofUrl,
        ...(newStatus === "PAID" || newStatus === "WAIVED"
          ? { paidAt: new Date() }
          : {}),
      },
    });

    // Create audit log for payment confirmation
    await auditLog(tx, {
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
      performedBy: performedBy ?? undefined,
      ipAddress: ipAddress ?? undefined,
    });

    // Capture values for post-tx email
    prevStatus = oldRegistration.paymentStatus;
    eventId = oldRegistration.eventId;
    email = oldRegistration.email;
    firstName = oldRegistration.firstName;
    lastName = oldRegistration.lastName;
  });

  // Queue PAYMENT_CONFIRMED email if status changed to PAID
  if (input.paymentStatus === "PAID" && prevStatus !== "PAID" && eventId) {
    queueTriggeredEmail("PAYMENT_CONFIRMED", eventId, {
      id,
      email: email!,
      firstName,
      lastName,
    }).catch((err) => {
      logger.error(
        { err, registrationId: id },
        "Failed to queue PAYMENT_CONFIRMED email",
      );
    });
  }

  // Fetch and return updated registration with relations
  const registration = await prisma.registration.findUnique({
    where: { id },
    include: {
      form: { select: { id: true, name: true } },
      event: { select: { id: true, name: true, slug: true, clientId: true } },
    },
  });
  if (!registration) {
    throw new AppError(
      "Registration not found after update",
      404,
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );
  }
  return enrichWithAccessSelections(registration);
}

// ============================================================================
// Payment Proof Upload
// ============================================================================

const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
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

/**
 * Upload payment proof for a registration.
 * Compresses images to WebP, uploads to storage provider,
 * updates registration, and queues notification email.
 */
export async function uploadPaymentProof(
  registrationId: string,
  file: { buffer: Buffer; filename: string; mimetype: string },
): Promise<PaymentProofResponse> {
  // Validate file type (fast first-pass: header string)
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new AppError(
      "Invalid file type. Allowed: PNG, JPG, WebP, PDF",
      400,
      ErrorCodes.INVALID_FILE_TYPE,
    );
  }

  // Validate actual file content (magic bytes) — don't trust mimetype header
  const detectedType = await fileTypeFromBuffer(file.buffer);

  if (!detectedType) {
    throw new AppError(
      "Unable to determine file type. Please upload a valid PNG, JPG, or PDF.",
      400,
      ErrorCodes.INVALID_FILE_TYPE,
    );
  }

  if (!ALLOWED_MIME_TYPES.includes(detectedType.mime)) {
    throw new AppError(
      "File content does not match allowed types. Allowed: PNG, JPG, WebP, PDF",
      400,
      ErrorCodes.INVALID_FILE_TYPE,
    );
  }

  // Validate file size
  if (file.buffer.length > MAX_FILE_SIZE) {
    throw new AppError(
      "File too large. Maximum: 10MB",
      400,
      ErrorCodes.FILE_TOO_LARGE,
    );
  }

  // Get registration with event info and current status
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
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );
  }

  // Validate that transitioning to VERIFYING is allowed from current status
  validatePaymentTransition(registration.paymentStatus, "VERIFYING");

  // Compress file (images → WebP, PDFs → passthrough)
  // Use the magic-byte-detected type, not the user-supplied header
  const compressed = await compressFile(file.buffer, detectedType.mime);

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
      { contentDisposition: "attachment" },
    );
  } catch (error) {
    logger.error(
      { err: error, registrationId, key },
      "Failed to upload payment proof",
    );
    throw new AppError(
      "Failed to upload file. Please try again.",
      500,
      ErrorCodes.INTERNAL_ERROR,
    );
  }

  // Update registration with payment proof URL, set status to VERIFYING, and create audit log
  await prisma.$transaction(async (tx) => {
    const currentReg = await tx.registration.findUnique({
      where: { id: registrationId },
      select: { paymentStatus: true },
    });
    if (!currentReg)
      throw new AppError("Registration not found", 404, ErrorCodes.NOT_FOUND);
    validatePaymentTransition(currentReg.paymentStatus, "VERIFYING");

    await tx.registration.update({
      where: { id: registrationId },
      data: {
        paymentProofUrl: fileUrl,
        paymentStatus: "VERIFYING",
        paymentMethod: "BANK_TRANSFER",
      },
    });

    // Create audit log for payment proof upload
    await auditLog(tx, {
      entityType: "Registration",
      entityId: registrationId,
      action: "PAYMENT_PROOF_UPLOADED",
      changes: {
        paymentStatus: { old: registration.paymentStatus, new: "VERIFYING" },
        paymentProofUrl: { old: registration.paymentProofUrl, new: fileUrl },
      },
      performedBy: "PUBLIC",
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
      return decodeURIComponent(parts.slice(1).join("/"));
    }
    // R2 public URL or custom domain: https://cdn.example.com/path/to/file
    // Just return everything after the first /
    return decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    return null;
  }
}

// ============================================================================
// Select Payment Method (Public - from payment page)
// ============================================================================

export async function selectPaymentMethod(
  registrationId: string,
  input: { paymentMethod: "CASH" | "LAB_SPONSORSHIP"; labName?: string },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const registration = await tx.registration.findUnique({
      where: { id: registrationId },
    });

    if (!registration) {
      throw new AppError("Registration not found", 404, ErrorCodes.NOT_FOUND);
    }

    if (registration.paymentStatus !== "PENDING") {
      throw new AppError(
        "Payment method can only be selected for pending registrations",
        400,
        ErrorCodes.REGISTRATION_INVALID_STATUS,
      );
    }

    const nextPaymentStatus =
      input.paymentMethod === "LAB_SPONSORSHIP" ? "WAIVED" : "PENDING";

    validatePaymentTransition(registration.paymentStatus, nextPaymentStatus);

    const changes: Record<string, { old: unknown; new: unknown }> = {
      paymentMethod: {
        old: registration.paymentMethod,
        new: input.paymentMethod,
      },
    };

    if (nextPaymentStatus !== registration.paymentStatus) {
      changes.paymentStatus = {
        old: registration.paymentStatus,
        new: nextPaymentStatus,
      };
    }

    const nextLabName =
      input.paymentMethod === "LAB_SPONSORSHIP"
        ? (input.labName ?? null)
        : null;
    if (nextLabName !== registration.labName) {
      changes.labName = {
        old: registration.labName,
        new: nextLabName,
      };
    }

    await tx.registration.update({
      where: { id: registrationId },
      data: {
        paymentMethod: input.paymentMethod,
        paymentStatus: nextPaymentStatus,
        labName: nextLabName,
        ...(nextPaymentStatus === "WAIVED" && !registration.paidAt
          ? { paidAt: new Date() }
          : {}),
      },
    });

    await auditLog(tx, {
      entityType: "Registration",
      entityId: registrationId,
      action: "PAYMENT_METHOD_SELECTED",
      changes,
      performedBy: "PUBLIC",
    });
  });
}
