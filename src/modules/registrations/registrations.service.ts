import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { logger } from "@shared/utils/logger.js";
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";
import {
  incrementRegisteredCountTx,
  decrementRegisteredCountTx,
} from "@events";
import {
  validateAccessSelections,
  reserveAccessSpot,
  releaseAccessSpot,
  incrementPaidCount,
  decrementPaidCount,
  handleCapacityReached,
} from "@access";
import { calculatePrice } from "@pricing";
import { queueTriggeredEmail } from "@email";
import {
  validateFormData,
  sanitizeFormData,
  type FormSchema,
} from "@shared/utils/form-data-validator.js";
import { getStorageProvider } from "@shared/services/storage/index.js";
import { compressFile } from "@shared/services/storage/compress.js";
import { fileTypeFromBuffer } from "file-type";
import type {
  CreateRegistrationInput,
  UpdateRegistrationInput,
  UpdatePaymentInput,
  ListRegistrationsQuery,
  PriceBreakdown,
  PublicEditRegistrationInput,
  ListRegistrationAuditLogsQuery,
  RegistrationAuditLog,
  ListRegistrationEmailLogsQuery,
  RegistrationEmailLog,
  SearchRegistrantsQuery,
  RegistrantSearchResult,
} from "./registrations.schema.js";
import type { Registration, Prisma } from "@/generated/prisma/client.js";

// ============================================================================
// Edit Token Configuration
// ============================================================================

const EDIT_TOKEN_LENGTH = 32; // 64 hex characters
const EDIT_TOKEN_EXPIRY_HOURS = 24;

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
function validatePaymentTransition(
  currentStatus: string,
  newStatus: string,
): void {
  if (currentStatus === newStatus) return; // No transition

  const allowed = PAYMENT_STATUS_TRANSITIONS[currentStatus] ?? [];
  if (!allowed.includes(newStatus)) {
    throw new AppError(
      `Cannot transition payment from ${currentStatus} to ${newStatus}`,
      400,
      true,
      ErrorCodes.INVALID_PAYMENT_TRANSITION,
    );
  }
}

const PAID_STATUSES = ["PAID", "WAIVED"];

/**
 * Sync paidCount on access items when a registration's payment status changes.
 * Increments when becoming paid (PAID/WAIVED), decrements on refund.
 * Triggers capacity-reached handling when access items fill up.
 */
async function syncPaidCount(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  registration: {
    eventId: string;
    accessTypeIds: string[];
    priceBreakdown: unknown;
  },
  oldStatus: string,
  newStatus: string,
): Promise<void> {
  const wasPaid = PAID_STATUSES.includes(oldStatus);
  const isPaid = PAID_STATUSES.includes(newStatus);
  if (wasPaid === isPaid) return; // No change in paid state

  const breakdown = registration.priceBreakdown as PriceBreakdown;
  const accessItems = breakdown.accessItems ?? [];
  if (accessItems.length === 0) return;

  if (!wasPaid && isPaid) {
    // Becoming paid: increment paidCount and check capacity
    for (const item of accessItems) {
      await incrementPaidCount(item.accessId, item.quantity, tx);
    }
    const accessIds = accessItems.map((a) => a.accessId);
    await handleCapacityReached(registration.eventId, accessIds, tx);
  } else {
    // Becoming unpaid (refund): decrement paidCount
    for (const item of accessItems) {
      await decrementPaidCount(item.accessId, item.quantity, tx);
    }
  }
}

/**
 * Generate a secure random edit token.
 */
function generateEditToken(): string {
  return randomBytes(EDIT_TOKEN_LENGTH).toString("hex");
}

/**
 * Calculate edit token expiry date.
 */
function getEditTokenExpiry(): Date {
  return new Date(Date.now() + EDIT_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);
}

/**
 * Verify an edit token for a registration.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param checkExpiry - If true, rejects expired tokens (for edit operations).
 *                      If false, only validates the token value (for read/payment access).
 */
export async function verifyEditToken(
  registrationId: string,
  token: string,
  { checkExpiry = true }: { checkExpiry?: boolean } = {},
): Promise<boolean> {
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    select: { editToken: true, editTokenExpiry: true },
  });

  if (!registration?.editToken || !registration.editTokenExpiry) {
    return false;
  }

  // Check expiry only for edit operations — payment/read links stay valid
  if (checkExpiry && registration.editTokenExpiry < new Date()) {
    return false;
  }

  // Timing-safe comparison
  try {
    const isValid = timingSafeEqual(
      Buffer.from(registration.editToken, "utf8"),
      Buffer.from(token, "utf8"),
    );
    return isValid;
  } catch {
    // Buffer length mismatch or other error
    return false;
  }
}

// ============================================================================
// Types
// ============================================================================

type RegistrationWithRelations = Registration & {
  accessSelections: Array<{
    id: string;
    accessId: string;
    unitPrice: number;
    quantity: number;
    subtotal: number;
    access: {
      id: string;
      name: string;
      type: string;
      startsAt: Date | null;
      endsAt: Date | null;
    };
  }>;
  droppedAccessSelections?: Array<{
    id: string;
    accessId: string;
    unitPrice: number;
    quantity: number;
    subtotal: number;
    reason: string;
    access: {
      id: string;
      name: string;
      type: string;
      startsAt: Date | null;
      endsAt: Date | null;
    };
  }>;
  form: {
    id: string;
    name: string;
  };
  event: {
    id: string;
    name: string;
    slug: string;
    clientId: string;
  };
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate total discount amount from applied pricing rules.
 * Returns absolute value of sum of negative effects.
 */
function calculateDiscountAmount(
  appliedRules: PriceBreakdown["appliedRules"],
): number {
  return Math.abs(
    appliedRules
      .filter((rule) => rule.effect < 0)
      .reduce((sum, rule) => sum + rule.effect, 0),
  );
}

/**
 * Enrich a registration with accessSelections derived from priceBreakdown.
 * Fetches access details from EventAccess table and reconstructs the shape
 * that was previously provided by the RegistrationAccess relation.
 */
async function enrichWithAccessSelections(
  registration: Registration & {
    form: { id: string; name: string };
    event: { id: string; name: string; slug: string; clientId: string };
  },
): Promise<RegistrationWithRelations> {
  const priceBreakdown = registration.priceBreakdown as PriceBreakdown;

  const droppedItems = priceBreakdown.droppedAccessItems ?? [];
  const hasActive = priceBreakdown.accessItems && priceBreakdown.accessItems.length > 0;
  const hasDropped = droppedItems.length > 0;

  // If no access items at all, return empty arrays
  if (!hasActive && !hasDropped) {
    return { ...registration, accessSelections: [], droppedAccessSelections: [] };
  }

  // Fetch access details for both active and dropped items
  const allAccessIds = [
    ...(priceBreakdown.accessItems?.map((item) => item.accessId) ?? []),
    ...droppedItems.map((item) => item.accessId),
  ];
  const accessDetails = await prisma.eventAccess.findMany({
    where: { id: { in: allAccessIds } },
    select: {
      id: true,
      name: true,
      type: true,
      startsAt: true,
      endsAt: true,
      price: true,
      companionPrice: true,
      allowCompanion: true,
    },
  });

  const accessMap = new Map(accessDetails.map((a) => [a.id, a]));

  const fallbackAccess = (item: { accessId: string; name: string }) => ({
    id: item.accessId,
    name: item.name,
    type: "OTHER" as const,
    startsAt: null,
    endsAt: null,
    price: 0,
    companionPrice: 0,
    allowCompanion: false,
  });

  // Reconstruct accessSelections from priceBreakdown
  const accessSelections = (priceBreakdown.accessItems ?? []).map((item) => ({
    id: `${registration.id}-${item.accessId}`,
    accessId: item.accessId,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    subtotal: item.subtotal,
    access: accessMap.get(item.accessId) ?? fallbackAccess(item),
  }));

  // Reconstruct droppedAccessSelections
  const droppedAccessSelections = droppedItems.map((item) => ({
    id: `${registration.id}-dropped-${item.accessId}`,
    accessId: item.accessId,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    subtotal: item.subtotal,
    reason: item.reason,
    access: accessMap.get(item.accessId) ?? fallbackAccess(item),
  }));

  return { ...registration, accessSelections, droppedAccessSelections };
}

/**
 * Enrich multiple registrations with accessSelections in a single batch.
 * More efficient than calling enrichWithAccessSelections for each one.
 */
async function enrichManyWithAccessSelections(
  registrations: Array<
    Registration & {
      form: { id: string; name: string };
      event: { id: string; name: string; slug: string; clientId: string };
    }
  >,
): Promise<RegistrationWithRelations[]> {
  // Collect all unique access IDs across all registrations (active + dropped)
  const allAccessIds = new Set<string>();
  for (const reg of registrations) {
    const priceBreakdown = reg.priceBreakdown as PriceBreakdown;
    if (priceBreakdown.accessItems) {
      for (const item of priceBreakdown.accessItems) {
        allAccessIds.add(item.accessId);
      }
    }
    if (priceBreakdown.droppedAccessItems) {
      for (const item of priceBreakdown.droppedAccessItems) {
        allAccessIds.add(item.accessId);
      }
    }
  }

  // Fetch all access details in one query
  const accessDetails = await prisma.eventAccess.findMany({
    where: { id: { in: Array.from(allAccessIds) } },
    select: {
      id: true,
      name: true,
      type: true,
      startsAt: true,
      endsAt: true,
      price: true,
      companionPrice: true,
      allowCompanion: true,
    },
  });

  const accessMap = new Map(accessDetails.map((a) => [a.id, a]));

  const fallbackAccess = (item: { accessId: string; name: string }) => ({
    id: item.accessId,
    name: item.name,
    type: "OTHER" as const,
    startsAt: null,
    endsAt: null,
    price: 0,
    companionPrice: 0,
    allowCompanion: false,
  });

  // Enrich each registration
  return registrations.map((registration) => {
    const priceBreakdown = registration.priceBreakdown as PriceBreakdown;
    const droppedItems = priceBreakdown.droppedAccessItems ?? [];
    const hasActive = priceBreakdown.accessItems && priceBreakdown.accessItems.length > 0;
    const hasDropped = droppedItems.length > 0;

    if (!hasActive && !hasDropped) {
      return { ...registration, accessSelections: [], droppedAccessSelections: [] };
    }

    const accessSelections = (priceBreakdown.accessItems ?? []).map((item) => ({
      id: `${registration.id}-${item.accessId}`,
      accessId: item.accessId,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      subtotal: item.subtotal,
      access: accessMap.get(item.accessId) ?? fallbackAccess(item),
    }));

    const droppedAccessSelections = droppedItems.map((item) => ({
      id: `${registration.id}-dropped-${item.accessId}`,
      accessId: item.accessId,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      subtotal: item.subtotal,
      reason: item.reason,
      access: accessMap.get(item.accessId) ?? fallbackAccess(item),
    }));

    return { ...registration, accessSelections, droppedAccessSelections };
  });
}

// ============================================================================
// CRUD Operations
// ============================================================================

export async function createRegistration(
  input: CreateRegistrationInput,
  priceBreakdown: PriceBreakdown,
): Promise<RegistrationWithRelations> {
  const {
    formId,
    formData,
    email,
    firstName,
    lastName,
    phone,
    accessSelections,
    sponsorshipCode,
    paymentMethod,
    labName,
    idempotencyKey,
    linkBaseUrl,
  } = input;

  // Get form and event info (including schemaVersion)
  const form = await prisma.form.findUnique({
    where: { id: formId },
    select: { id: true, eventId: true, schemaVersion: true },
  });
  if (!form) {
    throw new AppError("Form not found", 404, true, ErrorCodes.NOT_FOUND);
  }

  const eventId = form.eventId;

  // Check for duplicate registration (unique per email + form)
  const existingRegistration = await prisma.registration.findUnique({
    where: { email_formId: { email, formId } },
  });
  if (existingRegistration) {
    throw new AppError(
      "A registration with this email already exists for this form",
      409,
      true,
      ErrorCodes.REGISTRATION_ALREADY_EXISTS,
    );
  }

  // Validate access selections
  if (accessSelections && accessSelections.length > 0) {
    const validation = await validateAccessSelections(
      eventId,
      accessSelections,
      formData,
    );
    if (!validation.valid) {
      throw new AppError(
        `Invalid access selections: ${validation.errors.join(", ")}`,
        400,
        true,
        ErrorCodes.BAD_REQUEST,
        { errors: validation.errors },
      );
    }
  }

  // Create registration with access selections in a transaction
  const result = await prisma.$transaction(async (tx) => {
    // Re-check event status inside transaction to prevent TOCTOU race condition
    // Event might have been closed between initial check and transaction start
    const event = await tx.event.findUnique({
      where: { id: eventId },
      select: { status: true, maxCapacity: true, registeredCount: true },
    });

    if (!event || event.status !== "OPEN") {
      throw new AppError(
        "Event is not accepting registrations",
        400,
        true,
        ErrorCodes.EVENT_NOT_OPEN,
      );
    }

    // Check event capacity
    if (
      event.maxCapacity !== null &&
      event.registeredCount >= event.maxCapacity
    ) {
      throw new AppError(
        "Event is at capacity",
        409,
        true,
        ErrorCodes.EVENT_FULL,
      );
    }

    // Generate edit token for secure self-service editing
    const editToken = generateEditToken();
    const editTokenExpiry = getEditTokenExpiry();

    // Create registration
    const registration = await tx.registration.create({
      data: {
        formId,
        eventId,
        formData: formData as Prisma.InputJsonValue,
        formSchemaVersion: form.schemaVersion,
        email,
        firstName: firstName ?? null,
        lastName: lastName ?? null,
        phone: phone ?? null,
        paymentStatus:
          paymentMethod === "LAB_SPONSORSHIP" ? "WAIVED" : "PENDING",
        paymentMethod: paymentMethod ?? null,
        labName: paymentMethod === "LAB_SPONSORSHIP" ? (labName ?? null) : null,
        totalAmount: priceBreakdown.total,
        currency: priceBreakdown.currency,
        priceBreakdown: priceBreakdown as unknown as Prisma.InputJsonValue,
        // Denormalized financial columns for reporting
        baseAmount: priceBreakdown.calculatedBasePrice,
        discountAmount: calculateDiscountAmount(priceBreakdown.appliedRules),
        accessAmount: priceBreakdown.accessTotal,
        sponsorshipCode: sponsorshipCode ?? null,
        sponsorshipAmount: priceBreakdown.sponsorshipTotal,
        // Access type IDs for querying
        accessTypeIds: accessSelections?.map((s) => s.accessId) ?? [],
        // Edit token for secure public access
        editToken,
        editTokenExpiry,
        // Browser origin URL for email links
        linkBaseUrl: linkBaseUrl ?? null,
        // Idempotency key for safe retries
        idempotencyKey: idempotencyKey ?? null,
      },
    });

    // Reserve access spots (capacity tracking)
    // Pass tx so reservation is rolled back if the transaction fails
    if (accessSelections && accessSelections.length > 0) {
      for (const selection of accessSelections) {
        await reserveAccessSpot(selection.accessId, selection.quantity, tx);
      }
    }

    // Increment event registered count (atomic SQL within transaction)
    await incrementRegisteredCountTx(tx, eventId);

    // If auto-WAIVED (LAB_SPONSORSHIP), sync paid count immediately
    if (paymentMethod === "LAB_SPONSORSHIP" && accessSelections && accessSelections.length > 0) {
      await syncPaidCount(
        tx,
        { eventId, accessTypeIds: accessSelections.map((s) => s.accessId), priceBreakdown },
        "PENDING",
        "WAIVED",
      );
    }

    // Return full registration with derived accessSelections
    const createdReg = await tx.registration.findUnique({
      where: { id: registration.id },
      include: {
        form: { select: { id: true, name: true } },
        event: { select: { id: true, name: true, slug: true, clientId: true } },
      },
    });

    if (!createdReg) {
      throw new AppError(
        "Registration creation failed",
        500,
        true,
        ErrorCodes.INTERNAL_ERROR,
      );
    }

    // Create audit log for registration creation
    await tx.auditLog.create({
      data: {
        entityType: "Registration",
        entityId: registration.id,
        action: "CREATE",
        changes: {
          email: { old: null, new: email },
          firstName: { old: null, new: firstName ?? null },
          lastName: { old: null, new: lastName ?? null },
          totalAmount: { old: null, new: priceBreakdown.total },
        },
        performedBy: "PUBLIC",
      },
    });

    return enrichWithAccessSelections(createdReg);
  });

  // Queue confirmation email (fire and forget - don't block registration response)
  queueTriggeredEmail("REGISTRATION_CREATED", eventId, {
    id: result.id,
    email,
    firstName,
    lastName,
  }).catch((err) => {
    logger.error(
      { err, registrationId: result.id },
      "Failed to queue confirmation email",
    );
  });

  return result;
}

export async function getRegistrationById(
  id: string,
): Promise<RegistrationWithRelations | null> {
  const registration = await prisma.registration.findUnique({
    where: { id },
    include: {
      form: { select: { id: true, name: true } },
      event: { select: { id: true, name: true, slug: true, clientId: true } },
    },
  });

  if (!registration) return null;

  return enrichWithAccessSelections(registration);
}

/**
 * Get registration by idempotency key.
 * Used for idempotent registration creation.
 */
export async function getRegistrationByIdempotencyKey(
  idempotencyKey: string,
): Promise<RegistrationWithRelations | null> {
  const registration = await prisma.registration.findUnique({
    where: { idempotencyKey },
    include: {
      form: { select: { id: true, name: true } },
      event: { select: { id: true, name: true, slug: true, clientId: true } },
    },
  });

  if (!registration) return null;

  return enrichWithAccessSelections(registration);
}

export async function updateRegistration(
  id: string,
  input: UpdateRegistrationInput,
  performedBy?: string,
): Promise<RegistrationWithRelations> {
  const registration = await prisma.registration.findUnique({ where: { id } });
  if (!registration) {
    throw new AppError(
      "Registration not found",
      404,
      true,
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );
  }

  const updateData: Prisma.RegistrationUpdateInput = {};

  if (input.paymentStatus !== undefined) {
    // Validate payment status transition
    validatePaymentTransition(registration.paymentStatus, input.paymentStatus);

    updateData.paymentStatus = input.paymentStatus;
    // Set paidAt when payment is confirmed
    if (
      (input.paymentStatus === "PAID" || input.paymentStatus === "WAIVED") &&
      !registration.paidAt
    ) {
      updateData.paidAt = new Date();
    }
  }
  if (input.paidAmount !== undefined) updateData.paidAmount = input.paidAmount;
  if (input.paymentMethod !== undefined)
    updateData.paymentMethod = input.paymentMethod;
  if (input.paymentReference !== undefined)
    updateData.paymentReference = input.paymentReference;
  if (input.paymentProofUrl !== undefined)
    updateData.paymentProofUrl = input.paymentProofUrl;
  if (input.note !== undefined) updateData.note = input.note;

  // Build changes object for audit log
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  if (input.note !== undefined && input.note !== registration.note) {
    changes.note = { old: registration.note, new: input.note };
  }

  await prisma.$transaction(async (tx) => {
    await tx.registration.update({ where: { id }, data: updateData });

    // Sync paid count if payment status changed
    if (input.paymentStatus !== undefined && input.paymentStatus !== registration.paymentStatus) {
      await syncPaidCount(
        tx,
        registration,
        registration.paymentStatus,
        input.paymentStatus,
      );
    }

    // Create audit log if there are changes
    if (Object.keys(changes).length > 0) {
      await tx.auditLog.create({
        data: {
          entityType: "Registration",
          entityId: id,
          action: "UPDATE",
          changes: changes as Prisma.InputJsonValue,
          performedBy: performedBy ?? null,
        },
      });
    }
  });

  return getRegistrationById(id) as Promise<RegistrationWithRelations>;
}

export async function confirmPayment(
  id: string,
  input: UpdatePaymentInput,
  performedBy?: string,
  ipAddress?: string,
): Promise<RegistrationWithRelations> {
  const oldRegistration = await prisma.registration.findUnique({
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
      accessTypeIds: true,
      priceBreakdown: true,
    },
  });

  if (!oldRegistration) {
    throw new AppError(
      "Registration not found",
      404,
      true,
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );
  }

  // Validate payment status transition
  validatePaymentTransition(oldRegistration.paymentStatus, input.paymentStatus);

  // Update registration in a transaction with audit logging
  await prisma.$transaction(async (tx) => {
    // Update registration
    const updated = await tx.registration.update({
      where: { id },
      data: {
        paymentStatus: input.paymentStatus,
        paidAmount: input.paidAmount ?? oldRegistration.totalAmount,
        paymentMethod: input.paymentMethod ?? null,
        paymentReference: input.paymentReference ?? null,
        paymentProofUrl: input.paymentProofUrl ?? null,
        paidAt: new Date(),
      },
    });

    // Sync paid count on access items (increment/decrement based on status change)
    await syncPaidCount(
      tx,
      oldRegistration,
      oldRegistration.paymentStatus,
      input.paymentStatus,
    );

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
  });

  // Queue PAYMENT_CONFIRMED email if status changed to PAID
  if (
    input.paymentStatus === "PAID" &&
    oldRegistration.paymentStatus !== "PAID"
  ) {
    queueTriggeredEmail("PAYMENT_CONFIRMED", oldRegistration.eventId, {
      id,
      email: oldRegistration.email,
      firstName: oldRegistration.firstName,
      lastName: oldRegistration.lastName,
    }).catch((err) => {
      logger.error(
        { err, registrationId: id },
        "Failed to queue PAYMENT_CONFIRMED email",
      );
    });
  }

  return getRegistrationById(id) as Promise<RegistrationWithRelations>;
}

/**
 * Delete a registration. Blocks deletion of PAID registrations unless force=true.
 * Force-delete is logged in the audit trail with forceDelete flag.
 */
export async function deleteRegistration(
  id: string,
  performedBy?: string,
  force?: boolean,
): Promise<void> {
  const registration = await prisma.registration.findUnique({
    where: { id },
    select: {
      id: true,
      eventId: true,
      email: true,
      firstName: true,
      lastName: true,
      paymentStatus: true,
      priceBreakdown: true,
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

  // Only allow deletion of unpaid registrations (unless force=true)
  if (registration.paymentStatus === "PAID" && !force) {
    throw new AppError(
      "Cannot delete a paid registration. Use refund instead.",
      400,
      true,
      ErrorCodes.REGISTRATION_DELETE_BLOCKED,
    );
  }

  await prisma.$transaction(async (tx) => {
    // Create audit log before deletion
    await tx.auditLog.create({
      data: {
        entityType: "Registration",
        entityId: id,
        action: "DELETE",
        changes: {
          email: { old: registration.email, new: null },
          firstName: { old: registration.firstName, new: null },
          lastName: { old: registration.lastName, new: null },
          paymentStatus: { old: registration.paymentStatus, new: null },
          ...(force ? { forceDelete: { old: null, new: true } } : {}),
        },
        performedBy: performedBy ?? null,
      },
    });

    // Release access spots (get from priceBreakdown)
    // Pass tx so release is rolled back if the transaction fails
    const priceBreakdown = registration.priceBreakdown as PriceBreakdown;
    if (priceBreakdown.accessItems) {
      for (const item of priceBreakdown.accessItems) {
        await releaseAccessSpot(item.accessId, item.quantity, tx);
      }
    }

    // Decrement paid count if registration was PAID or WAIVED
    if (PAID_STATUSES.includes(registration.paymentStatus) && priceBreakdown.accessItems) {
      for (const item of priceBreakdown.accessItems) {
        await decrementPaidCount(item.accessId, item.quantity, tx);
      }
    }

    // Decrement event registered count (atomic SQL within transaction)
    await decrementRegisteredCountTx(tx, registration.eventId);

    // Delete the registration
    await tx.registration.delete({ where: { id } });
  });
}

export async function listRegistrations(
  eventId: string,
  query: ListRegistrationsQuery,
): Promise<PaginatedResult<RegistrationWithRelations>> {
  const { page, limit, paymentStatus, search } = query;

  const where: Prisma.RegistrationWhereInput = { eventId };

  if (paymentStatus) where.paymentStatus = paymentStatus;
  if (search) {
    where.OR = [
      { email: { contains: search, mode: "insensitive" } },
      { firstName: { contains: search, mode: "insensitive" } },
      { lastName: { contains: search, mode: "insensitive" } },
      { phone: { contains: search, mode: "insensitive" } },
    ];
  }

  const skip = getSkip({ page, limit });

  const [data, total] = await Promise.all([
    prisma.registration.findMany({
      where,
      skip,
      take: limit,
      include: {
        form: { select: { id: true, name: true } },
        event: { select: { id: true, name: true, slug: true, clientId: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.registration.count({ where }),
  ]);

  // Enrich with accessSelections derived from priceBreakdown
  const enrichedData = await enrichManyWithAccessSelections(data);

  return paginate(enrichedData, total, { page, limit });
}

// ============================================================================
// Table Columns (for dynamic table rendering)
// ============================================================================

type FieldCondition = {
  fieldId: string;
  operator: string;
  value?: string | number | boolean;
};

type FormField = {
  id: string;
  type: string;
  label?: string;
  options?: Array<{ id: string; label: string; value?: string }>;
  conditions?: FieldCondition[];
};

type FormSchemaSteps = {
  steps: Array<{ fields: FormField[] }>;
};

export type RegistrationTableColumns = {
  formColumns: Array<{
    id: string;
    label: string;
    type: string;
    options?: Array<{ id: string; label: string }>;
    mergeWith?: {
      fieldId: string;
      triggerValue: string;
    };
  }>;
  fixedColumns: Array<{
    id: string;
    label: string;
    type: string;
  }>;
};

// ============================================================================
// Smart Merge Helpers
// ============================================================================

const SPECIFY_OTHER_TRIGGER_VALUES = ["other", "autre", "other_diet"];

/**
 * Find a "specify other" child field for a given parent field.
 * Returns the child field that:
 * - Has conditions referencing the parent field
 * - Uses 'equals' operator with an "other" value
 */
function findSpecifyOtherChild(
  parentField: FormField,
  allFields: FormField[],
): FormField | null {
  // Only for selection fields
  if (!["dropdown", "radio"].includes(parentField.type)) return null;

  // Check if parent has an "other" option (by option.id)
  const hasOtherOption = parentField.options?.some((opt) =>
    SPECIFY_OTHER_TRIGGER_VALUES.includes(opt.id.toLowerCase()),
  );
  if (!hasOtherOption) return null;

  // Find child field that depends on this parent with equals/other condition
  return (
    allFields.find((child) =>
      child.conditions?.some(
        (cond) =>
          cond.fieldId === parentField.id &&
          cond.operator === "equals" &&
          SPECIFY_OTHER_TRIGGER_VALUES.includes(
            String(cond.value ?? "").toLowerCase(),
          ),
      ),
    ) ?? null
  );
}

/**
 * Get default fixed columns when no form exists.
 */
function getDefaultFixedColumns() {
  return [
    { id: "email", label: "Email", type: "email" },
    { id: "firstName", label: "First Name", type: "text" },
    { id: "lastName", label: "Last Name", type: "text" },
    { id: "phone", label: "Phone", type: "phone" },
    { id: "paymentStatus", label: "Payment", type: "payment" },
    { id: "totalAmount", label: "Amount", type: "currency" },
    { id: "createdAt", label: "Registered", type: "datetime" },
  ];
}

/**
 * Get table column definitions for a registration table.
 * Returns dynamic columns from form schema + fixed columns from registration model.
 * Fixed column labels are derived from the form's first step fields.
 * Conditional "specify other" fields are merged with their parent columns.
 */
export async function getRegistrationTableColumns(
  eventId: string,
): Promise<RegistrationTableColumns> {
  const form = await prisma.form.findFirst({
    where: { eventId, type: "REGISTRATION" },
    select: { schema: true },
  });

  if (!form?.schema) {
    return { formColumns: [], fixedColumns: getDefaultFixedColumns() };
  }

  const schema = form.schema as FormSchemaSteps;
  const allFields = schema.steps.flatMap((s) => s.fields);
  const firstStep = schema.steps[0];
  const firstStepFields = firstStep?.fields ?? [];

  // Extract contact field labels from first step by type
  const emailField = firstStepFields.find((f) => f.type === "email");
  const textFields = firstStepFields.filter((f) => f.type === "text");
  const phoneField = firstStepFields.find((f) => f.type === "phone");

  const emailLabel = emailField?.label ?? "Email";
  const firstNameLabel = textFields[0]?.label ?? "First Name";
  const lastNameLabel = textFields[1]?.label ?? "Last Name";
  const phoneLabel = phoneField?.label ?? "Phone";

  // Track contact field IDs to exclude from formColumns (avoid duplicates)
  const contactFieldIds = new Set<string>(
    [
      emailField?.id,
      textFields[0]?.id,
      textFields[1]?.id,
      phoneField?.id,
    ].filter((id): id is string => Boolean(id)),
  );

  // Track which fields should be merged (excluded as standalone columns)
  const mergedChildFieldIds = new Set<string>();

  // First pass: identify all merged child fields
  for (const field of allFields) {
    const specifyOtherChild = findSpecifyOtherChild(field, allFields);
    if (specifyOtherChild) {
      mergedChildFieldIds.add(specifyOtherChild.id);
    }
  }

  // Build form columns with merge metadata
  const formColumns = schema.steps.flatMap((step, stepIndex) =>
    step.fields
      .filter((f) => !["heading", "paragraph"].includes(f.type))
      .filter((f) => !(stepIndex === 0 && contactFieldIds.has(f.id)))
      .filter((f) => !mergedChildFieldIds.has(f.id)) // Exclude merged children
      .map((field) => {
        const specifyOtherChild = findSpecifyOtherChild(field, allFields);

        if (specifyOtherChild) {
          // Find the trigger value from the child's condition
          const triggerCondition = specifyOtherChild.conditions?.find(
            (c) => c.fieldId === field.id && c.operator === "equals",
          );

          return {
            id: field.id,
            label: field.label ?? field.id,
            type: field.type,
            options: field.options?.map((opt) => ({
              id: opt.id,
              label: opt.label,
            })),
            mergeWith: {
              fieldId: specifyOtherChild.id,
              triggerValue: String(triggerCondition?.value ?? "other"),
            },
          };
        }

        return {
          id: field.id,
          label: field.label ?? field.id,
          type: field.type,
          options: field.options?.map((opt) => ({
            id: opt.id,
            label: opt.label,
          })),
        };
      }),
  );

  // Fixed columns with labels from form schema
  const fixedColumns = [
    { id: "email", label: emailLabel, type: "email" },
    { id: "firstName", label: firstNameLabel, type: "text" },
    { id: "lastName", label: lastNameLabel, type: "text" },
    { id: "phone", label: phoneLabel, type: "phone" },
    { id: "paymentStatus", label: "Payment", type: "payment" },
    { id: "totalAmount", label: "Amount", type: "currency" },
    { id: "createdAt", label: "Registered", type: "datetime" },
  ];

  return { formColumns, fixedColumns };
}

// ============================================================================
// Helpers
// ============================================================================

export async function getRegistrationClientId(
  id: string,
): Promise<string | null> {
  const registration = await prisma.registration.findUnique({
    where: { id },
    include: { event: { select: { clientId: true } } },
  });
  return registration?.event.clientId ?? null;
}

export async function registrationExists(id: string): Promise<boolean> {
  const count = await prisma.registration.count({ where: { id } });
  return count > 0;
}

// ============================================================================
// Public Self-Service Editing
// ============================================================================

type RegistrationForEdit = RegistrationWithRelations & {
  form: {
    id: string;
    name: string;
    schema: unknown;
  };
  event: {
    id: string;
    name: string;
    slug: string;
    clientId: string;
    status: string;
  };
};

export type GetRegistrationForEditResult = {
  registration: RegistrationForEdit;
  canEdit: boolean;
  canEditPersonalInfo: boolean;
  canEditAccess: boolean;
  canAddAccess: boolean;
  canRemoveAccess: boolean;
  isFullySponsored: boolean;
  amountDue: number;
  editRestrictions: string[];
};

/**
 * Get registration for public self-service editing.
 * Returns registration data with edit permissions info.
 */
export async function getRegistrationForEdit(
  registrationId: string,
): Promise<GetRegistrationForEditResult> {
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    include: {
      form: { select: { id: true, name: true, schema: true } },
      event: {
        select: {
          id: true,
          name: true,
          slug: true,
          clientId: true,
          status: true,
        },
      },
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

  // Enrich with accessSelections derived from priceBreakdown
  const priceBreakdown = registration.priceBreakdown as PriceBreakdown;
  const accessIds =
    priceBreakdown.accessItems?.map((item) => item.accessId) ?? [];
  const accessDetails =
    accessIds.length > 0
      ? await prisma.eventAccess.findMany({
          where: { id: { in: accessIds } },
          select: {
            id: true,
            name: true,
            type: true,
            startsAt: true,
            endsAt: true,
          },
        })
      : [];

  const accessMap = new Map(accessDetails.map((a) => [a.id, a]));

  const accessSelections = (priceBreakdown.accessItems ?? []).map((item) => ({
    id: `${registration.id}-${item.accessId}`,
    accessId: item.accessId,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    subtotal: item.subtotal,
    access: accessMap.get(item.accessId) ?? {
      id: item.accessId,
      name: item.name,
      type: "OTHER",
      startsAt: null,
      endsAt: null,
    },
  }));

  const enrichedRegistration = { ...registration, accessSelections };

  // Start with all permissions enabled
  const restrictions: string[] = [];
  let canEdit = true;
  let canEditPersonalInfo = true;
  let canEditAccess = true;
  let canAddAccess = true;
  let canRemoveAccess = true;
  let isFullySponsored = false;

  // REFUNDED → block everything
  if (registration.paymentStatus === "REFUNDED") {
    canEdit = false;
    canEditPersonalInfo = false;
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    restrictions.push("Registration has been refunded");
  }

  // Event not OPEN → block everything
  if (registration.event.status !== "OPEN") {
    canEdit = false;
    canEditPersonalInfo = false;
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    restrictions.push("Event is not accepting changes");
  }

  // VERIFYING → block access edits only (personal info stays editable)
  if (registration.paymentStatus === "VERIFYING") {
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    restrictions.push("Payment proof is under review");
  }

  // PAID or paidAmount > 0 → cannot remove access (can still add)
  const isPaid =
    registration.paymentStatus === "PAID" || registration.paidAmount > 0;
  if (isPaid) {
    canRemoveAccess = false;
    restrictions.push("Cannot remove access items (payment received)");
  }

  // WAIVED → block all access edits
  if (registration.paymentStatus === "WAIVED") {
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    restrictions.push("Waived registrations cannot modify access selections");
  }

  // Fully sponsored → block all access edits
  if (
    registration.sponsorshipAmount >= registration.totalAmount &&
    registration.totalAmount > 0
  ) {
    isFullySponsored = true;
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    restrictions.push(
      "Fully sponsored registration cannot modify access selections",
    );
  }

  // Compute amount due
  const amountDue = Math.max(
    0,
    registration.totalAmount - registration.paidAmount,
  );

  return {
    registration: enrichedRegistration as RegistrationForEdit,
    canEdit,
    canEditPersonalInfo,
    canEditAccess,
    canAddAccess,
    canRemoveAccess,
    isFullySponsored,
    amountDue,
    editRestrictions: restrictions,
  };
}

export type EditRegistrationPublicResult = {
  registration: RegistrationWithRelations;
  priceBreakdown: PriceBreakdown;
};

/**
 * Edit registration (self-service, public endpoint).
 *
 * Rules:
 * - CANCELLED registrations cannot be edited
 * - Form data can always be edited
 * - If NOT paid: Can add/remove access items, recalculate totalAmount
 * - If PAID: Can only ADD access items, track additionalAmountDue
 */
export async function editRegistrationPublic(
  registrationId: string,
  input: PublicEditRegistrationInput,
): Promise<EditRegistrationPublicResult> {
  // 1. Get current registration
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    include: {
      form: { select: { id: true, eventId: true, schema: true } },
      event: { select: { id: true, status: true } },
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

  // 2. Validate registration can be edited
  if (registration.paymentStatus === "REFUNDED") {
    throw new AppError(
      "Refunded registrations cannot be edited",
      400,
      true,
      ErrorCodes.REGISTRATION_REFUNDED,
    );
  }

  if (registration.event.status !== "OPEN") {
    throw new AppError(
      "Event is not accepting changes",
      400,
      true,
      ErrorCodes.REGISTRATION_EDIT_FORBIDDEN,
    );
  }

  // 2b. Block access edits for VERIFYING registrations
  if (registration.paymentStatus === "VERIFYING" && input.accessSelections) {
    throw new AppError(
      "Cannot modify access while payment is under review",
      400,
      true,
      ErrorCodes.REGISTRATION_VERIFYING_BLOCKED,
    );
  }

  // 2c. Block access edits for WAIVED registrations
  if (registration.paymentStatus === "WAIVED" && input.accessSelections) {
    throw new AppError(
      "Waived registrations cannot modify access selections",
      400,
      true,
      ErrorCodes.REGISTRATION_WAIVED_ACCESS_BLOCKED,
    );
  }

  // 2d. Block access edits for fully sponsored registrations
  if (
    registration.sponsorshipAmount >= registration.totalAmount &&
    registration.totalAmount > 0 &&
    input.accessSelections
  ) {
    throw new AppError(
      "Fully sponsored registrations cannot modify access selections",
      400,
      true,
      ErrorCodes.REGISTRATION_FULLY_SPONSORED_BLOCKED,
    );
  }

  // 3. Determine if paid (affects what can be changed)
  const isPaid =
    registration.paymentStatus === "PAID" || registration.paidAmount > 0;

  // 4. Prepare form data changes
  const currentFormData = registration.formData as Record<string, unknown>;
  let newFormData = input.formData
    ? { ...currentFormData, ...input.formData }
    : currentFormData;

  // 5. Validate new form data against form schema
  if (input.formData) {
    const formSchema = registration.form.schema as unknown as FormSchema;
    const validationResult = validateFormData(formSchema, newFormData);
    if (!validationResult.valid) {
      throw new AppError(
        "Form validation failed",
        400,
        true,
        ErrorCodes.FORM_VALIDATION_ERROR,
        { fieldErrors: validationResult.errors },
      );
    }
    // Strip unknown keys — keep only field IDs from the form schema
    newFormData = sanitizeFormData(formSchema, newFormData);
  }

  // 6. Process access selection changes (derive current from priceBreakdown)
  const currentPriceBreakdown = registration.priceBreakdown as PriceBreakdown;
  const currentAccessItems = currentPriceBreakdown.accessItems ?? [];
  const currentAccessIds = new Set(
    currentAccessItems.map((item) => item.accessId),
  );

  const newAccessSelections =
    input.accessSelections ??
    currentAccessItems.map((item) => ({
      accessId: item.accessId,
      quantity: item.quantity,
    }));
  const newAccessIds = new Set(newAccessSelections.map((s) => s.accessId));

  const accessToAdd = newAccessSelections.filter(
    (s) => !currentAccessIds.has(s.accessId),
  );
  const accessToRemove = currentAccessItems.filter(
    (item) => !newAccessIds.has(item.accessId),
  );

  // 7. Enforce paid registration rules
  if (isPaid && accessToRemove.length > 0) {
    throw new AppError(
      "Cannot remove access items from a paid registration",
      400,
      true,
      ErrorCodes.REGISTRATION_ACCESS_REMOVAL_BLOCKED,
      {
        message: "Paid registrations can only add new access items",
        attemptedRemovals: accessToRemove.map((item) => item.accessId),
      },
    );
  }

  // 8. Validate new access selections if there are additions
  if (accessToAdd.length > 0) {
    const validation = await validateAccessSelections(
      registration.eventId,
      newAccessSelections,
      newFormData,
    );
    if (!validation.valid) {
      throw new AppError(
        `Invalid access selections: ${validation.errors.join(", ")}`,
        400,
        true,
        ErrorCodes.BAD_REQUEST,
        { errors: validation.errors },
      );
    }
  }

  // 9. Calculate new price breakdown
  const selectedExtras = newAccessSelections.map((s) => ({
    extraId: s.accessId,
    quantity: s.quantity,
  }));

  const calculatedPrice = await calculatePrice(registration.eventId, {
    formData: newFormData,
    selectedExtras,
    sponsorshipCodes: registration.sponsorshipCode
      ? [registration.sponsorshipCode]
      : [],
  });

  // Transform to registration format
  const newPriceBreakdown: PriceBreakdown = {
    basePrice: calculatedPrice.basePrice,
    appliedRules: calculatedPrice.appliedRules,
    calculatedBasePrice: calculatedPrice.calculatedBasePrice,
    accessItems: calculatedPrice.extras.map((extra) => ({
      accessId: extra.extraId,
      name: extra.name,
      unitPrice: extra.unitPrice,
      quantity: extra.quantity,
      subtotal: extra.subtotal,
    })),
    accessTotal: calculatedPrice.extrasTotal,
    subtotal: calculatedPrice.subtotal,
    sponsorships: calculatedPrice.sponsorships,
    sponsorshipTotal: calculatedPrice.sponsorshipTotal,
    total: calculatedPrice.total,
    currency: calculatedPrice.currency,
    // Remove re-added items from droppedAccessItems
    droppedAccessItems: (currentPriceBreakdown.droppedAccessItems ?? []).filter(
      (d) => !newAccessSelections.some((s) => s.accessId === d.accessId),
    ),
  };

  // Compute updated droppedAccessIds (remove any that were re-added)
  const newDroppedAccessIds = (registration.droppedAccessIds ?? []).filter(
    (id) => !newAccessSelections.some((s) => s.accessId === id),
  );

  // 10. Execute transaction
  await prisma.$transaction(async (tx) => {
    // Reserve new access spots
    // Pass tx so reservation is rolled back if the transaction fails
    for (const selection of accessToAdd) {
      await reserveAccessSpot(selection.accessId, selection.quantity, tx);
    }

    // Release removed access spots (only if not paid)
    // Pass tx so release is rolled back if the transaction fails
    if (!isPaid) {
      for (const item of accessToRemove) {
        await releaseAccessSpot(item.accessId, item.quantity, tx);
      }
    }

    // Calculate new total. For paid registrations, never decrease below
    // the original total — pricing rule changes via form data edits
    // should not reduce what was already owed.
    const newTotalAmount = isPaid
      ? Math.max(registration.totalAmount, newPriceBreakdown.total)
      : newPriceBreakdown.total;

    // Update registration
    await tx.registration.update({
      where: { id: registrationId },
      data: {
        formData: newFormData as Prisma.InputJsonValue,
        firstName: input.firstName ?? registration.firstName,
        lastName: input.lastName ?? registration.lastName,
        phone: input.phone ?? registration.phone,
        totalAmount: newTotalAmount,
        priceBreakdown: newPriceBreakdown as unknown as Prisma.InputJsonValue,
        baseAmount: newPriceBreakdown.calculatedBasePrice,
        accessAmount: newPriceBreakdown.accessTotal,
        discountAmount: calculateDiscountAmount(newPriceBreakdown.appliedRules),
        sponsorshipAmount: newPriceBreakdown.sponsorshipTotal,
        accessTypeIds: newAccessSelections.map((s) => s.accessId),
        droppedAccessIds: newDroppedAccessIds,
        lastEditedAt: new Date(),
      },
    });

    // Build changes for audit log
    const auditChanges: Record<string, { old: unknown; new: unknown }> = {};
    if (input.formData) {
      auditChanges.formData = { old: currentFormData, new: newFormData };
    }
    if (input.firstName && input.firstName !== registration.firstName) {
      auditChanges.firstName = {
        old: registration.firstName,
        new: input.firstName,
      };
    }
    if (input.lastName && input.lastName !== registration.lastName) {
      auditChanges.lastName = {
        old: registration.lastName,
        new: input.lastName,
      };
    }
    if (input.phone && input.phone !== registration.phone) {
      auditChanges.phone = { old: registration.phone, new: input.phone };
    }
    if (accessToAdd.length > 0) {
      auditChanges.accessAdded = {
        old: null,
        new: accessToAdd.map((a) => a.accessId),
      };
    }
    if (accessToRemove.length > 0) {
      auditChanges.accessRemoved = {
        old: accessToRemove.map((a) => a.accessId),
        new: null,
      };
    }

    // Create audit log for public edit
    if (Object.keys(auditChanges).length > 0) {
      await tx.auditLog.create({
        data: {
          entityType: "Registration",
          entityId: registrationId,
          action: "UPDATE",
          changes: auditChanges as Prisma.InputJsonValue,
          performedBy: "PUBLIC",
        },
      });
    }
  });

  // Fetch and return updated registration
  const updatedRegistration = await getRegistrationById(registrationId);

  return {
    registration: updatedRegistration!,
    priceBreakdown: newPriceBreakdown,
  };
}

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
      "Invalid file type. Allowed: PNG, JPG, PDF",
      400,
      true,
      ErrorCodes.INVALID_FILE_TYPE,
    );
  }

  // Validate actual file content (magic bytes) — don't trust mimetype header
  const detectedType = await fileTypeFromBuffer(file.buffer);

  if (!detectedType) {
    throw new AppError(
      "Unable to determine file type. Please upload a valid PNG, JPG, or PDF.",
      400,
      true,
      ErrorCodes.INVALID_FILE_TYPE,
    );
  }

  if (!ALLOWED_MIME_TYPES.includes(detectedType.mime)) {
    throw new AppError(
      "File content does not match allowed types. Allowed: PNG, JPG, PDF",
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

// ============================================================================
// Select Payment Method (Public - from payment page)
// ============================================================================

export async function selectPaymentMethod(
  registrationId: string,
  input: { paymentMethod: "CASH" | "LAB_SPONSORSHIP"; labName?: string },
): Promise<void> {
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
  });

  if (!registration) {
    throw new AppError(
      "Registration not found",
      404,
      true,
      ErrorCodes.NOT_FOUND,
    );
  }

  if (registration.paymentStatus !== "PENDING") {
    throw new AppError(
      "Payment method can only be selected for pending registrations",
      400,
      true,
      ErrorCodes.REGISTRATION_INVALID_STATUS,
    );
  }

  const updateData: Record<string, unknown> = {
    paymentMethod: input.paymentMethod,
  };

  if (input.paymentMethod === "LAB_SPONSORSHIP") {
    updateData.paymentStatus = "WAIVED";
    updateData.labName = input.labName ?? null;
    updateData.paidAt = new Date();
  }

  await prisma.registration.update({
    where: { id: registrationId },
    data: updateData,
  });
}

// ============================================================================
// Audit & Email Log Queries
// ============================================================================

/**
 * List audit logs for a registration.
 * Returns paginated results with resolved performer names.
 */
export async function listRegistrationAuditLogs(
  registrationId: string,
  query: ListRegistrationAuditLogsQuery,
): Promise<PaginatedResult<RegistrationAuditLog>> {
  const { page, limit } = query;
  const skip = getSkip({ page, limit });

  const where = { entityType: "Registration", entityId: registrationId };

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      skip,
      take: limit,
      orderBy: { performedAt: "desc" },
    }),
    prisma.auditLog.count({ where }),
  ]);

  // Collect user IDs to resolve names
  const userIds = logs
    .map((l) => l.performedBy)
    .filter(
      (id): id is string => id !== null && id !== "SYSTEM" && id !== "PUBLIC",
    );

  const uniqueUserIds = [...new Set(userIds)];

  const users =
    uniqueUserIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: uniqueUserIds } },
          select: { id: true, name: true },
        })
      : [];

  const userMap = new Map(users.map((u) => [u.id, u.name]));

  const enrichedLogs: RegistrationAuditLog[] = logs.map((log) => ({
    id: log.id,
    action: log.action as RegistrationAuditLog["action"],
    changes: log.changes as Record<
      string,
      { old: unknown; new: unknown }
    > | null,
    performedBy: log.performedBy,
    performedByName:
      log.performedBy === "SYSTEM"
        ? "System"
        : log.performedBy === "PUBLIC"
          ? "Registrant (Self-Edit)"
          : (userMap.get(log.performedBy!) ?? null),
    performedAt: log.performedAt.toISOString(),
    ipAddress: log.ipAddress,
  }));

  return paginate(enrichedLogs, total, { page, limit });
}

/**
 * List email logs for a registration.
 * Returns paginated results with template names.
 */
export async function listRegistrationEmailLogs(
  registrationId: string,
  query: ListRegistrationEmailLogsQuery,
): Promise<PaginatedResult<RegistrationEmailLog>> {
  const { page, limit } = query;
  const skip = getSkip({ page, limit });

  const where = { registrationId };

  const [logs, total] = await Promise.all([
    prisma.emailLog.findMany({
      where,
      skip,
      take: limit,
      include: {
        template: { select: { name: true } },
      },
      orderBy: { queuedAt: "desc" },
    }),
    prisma.emailLog.count({ where }),
  ]);

  const enrichedLogs: RegistrationEmailLog[] = logs.map((log) => ({
    id: log.id,
    subject: log.subject,
    status: log.status as RegistrationEmailLog["status"],
    trigger: log.trigger as RegistrationEmailLog["trigger"],
    templateName: log.template?.name ?? null,
    errorMessage: log.errorMessage,
    queuedAt: log.queuedAt.toISOString(),
    sentAt: log.sentAt?.toISOString() ?? null,
    deliveredAt: log.deliveredAt?.toISOString() ?? null,
    openedAt: log.openedAt?.toISOString() ?? null,
    clickedAt: log.clickedAt?.toISOString() ?? null,
    bouncedAt: log.bouncedAt?.toISOString() ?? null,
    failedAt: log.failedAt?.toISOString() ?? null,
  }));

  return paginate(enrichedLogs, total, { page, limit });
}

// ============================================================================
// Registrant Search (for Linked Account Sponsorship)
// ============================================================================

/**
 * Search registrants by name or email for sponsorship linking.
 * Used when sponsorship mode is LINKED_ACCOUNT.
 */
export async function searchRegistrantsForSponsorship(
  eventId: string,
  query: SearchRegistrantsQuery,
): Promise<RegistrantSearchResult[]> {
  const { query: searchQuery, unpaidOnly, limit } = query;

  const where: Prisma.RegistrationWhereInput = {
    eventId,
    OR: [
      { email: { contains: searchQuery, mode: "insensitive" } },
      { firstName: { contains: searchQuery, mode: "insensitive" } },
      { lastName: { contains: searchQuery, mode: "insensitive" } },
    ],
  };

  // Filter to unpaid only if requested
  if (unpaidOnly) {
    where.paymentStatus = { in: ["PENDING", "VERIFYING"] };
  }

  const registrations = await prisma.registration.findMany({
    where,
    take: limit,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      paymentStatus: true,
      totalAmount: true,
      baseAmount: true,
      accessAmount: true,
      sponsorshipAmount: true,
      accessTypeIds: true,
      phone: true,
      formData: true,
      sponsorshipUsages: {
        select: {
          sponsorship: {
            select: {
              status: true,
              coversBasePrice: true,
              coveredAccessIds: true,
            },
          },
        },
      },
    },
  });

  return registrations.map((r) => {
    // Aggregate coverage from USED sponsorships only
    const usedSponsorships = r.sponsorshipUsages
      .map((u) => u.sponsorship)
      .filter((s) => s.status === "USED");

    const isBasePriceCovered = usedSponsorships.some((s) => s.coversBasePrice);
    const coveredAccessIds = [
      ...new Set(usedSponsorships.flatMap((s) => s.coveredAccessIds)),
    ];

    return {
      id: r.id,
      email: r.email,
      firstName: r.firstName,
      lastName: r.lastName,
      paymentStatus: r.paymentStatus as RegistrantSearchResult["paymentStatus"],
      totalAmount: r.totalAmount,
      baseAmount: r.baseAmount,
      sponsorshipAmount: r.sponsorshipAmount,
      accessTypeIds: r.accessTypeIds,
      coveredAccessIds,
      isBasePriceCovered,
      phone: r.phone,
      formData: r.formData as Record<string, unknown> | null,
    };
  });
}
