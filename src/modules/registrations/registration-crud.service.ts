import { randomBytes } from "crypto";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { findOrThrow } from "@shared/utils/db.js";
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
} from "@access";
import { queueTriggeredEmail } from "@email";
import { cleanupSponsorshipsForRegistration } from "@sponsorships";
import type {
  CreateRegistrationInput,
  UpdateRegistrationInput,
  ListRegistrationsQuery,
  ListAllRegistrationsQuery,
  PriceBreakdown,
} from "./registrations.schema.js";
import type { Registration } from "@/generated/prisma/client.js";
import { Prisma } from "@/generated/prisma/client.js";
import type { PriceBreakdown as PricingPriceBreakdown } from "@pricing";

// ============================================================================
// Edit Token Configuration
// ============================================================================

const EDIT_TOKEN_LENGTH = 32; // 64 hex characters
const EDIT_TOKEN_EXPIRY_HOURS = 24;

// ============================================================================
// Types
// ============================================================================

export type RegistrationWithRelations = Registration & {
  accessSelections: Array<{
    id: string;
    accessId: string;
    unitPrice: number;
    quantity: number;
    subtotal: number;
    access: {
      id: string;
      name: string | Record<string, string>;
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
export function calculateDiscountAmount(
  appliedRules: PriceBreakdown["appliedRules"],
): number {
  return Math.abs(
    appliedRules
      .filter((rule) => rule.effect < 0)
      .reduce((sum, rule) => sum + rule.effect, 0),
  );
}

/**
 * Transform pricing module PriceBreakdown to registration storage format.
 * Maps 'extras'/'extrasTotal' to 'accessItems'/'accessTotal' and ensures
 * consistent JSONB shape across create and edit paths.
 */
export function toPersistablePriceBreakdown(
  pricingResult: PricingPriceBreakdown,
): PriceBreakdown {
  return {
    basePrice: pricingResult.basePrice,
    appliedRules: pricingResult.appliedRules,
    calculatedBasePrice: pricingResult.calculatedBasePrice,
    accessItems: pricingResult.extras.map((extra) => ({
      accessId: extra.extraId,
      name: extra.name,
      unitPrice: extra.unitPrice,
      quantity: extra.quantity,
      subtotal: extra.subtotal,
    })),
    accessTotal: pricingResult.extrasTotal,
    subtotal: pricingResult.subtotal,
    sponsorships: pricingResult.sponsorships,
    sponsorshipTotal: pricingResult.sponsorshipTotal,
    total: pricingResult.total,
    currency: pricingResult.currency,
  };
}

/**
 * Enrich a registration with accessSelections derived from priceBreakdown.
 * Fetches access details from EventAccess table and reconstructs the shape
 * that was previously provided by the RegistrationAccess relation.
 */
export async function enrichWithAccessSelections(
  registration: Registration & {
    form: { id: string; name: string };
    event: { id: string; name: string; slug: string; clientId: string };
  },
): Promise<RegistrationWithRelations> {
  const priceBreakdown = registration.priceBreakdown as PriceBreakdown;

  // If no access items, return empty array
  if (!priceBreakdown.accessItems || priceBreakdown.accessItems.length === 0) {
    return { ...registration, accessSelections: [] };
  }

  // Fetch access details for display
  const accessIds = priceBreakdown.accessItems.map((item) => item.accessId);
  const accessDetails = await prisma.eventAccess.findMany({
    where: { id: { in: accessIds } },
    select: { id: true, name: true, type: true, startsAt: true, endsAt: true },
  });

  const accessMap = new Map(accessDetails.map((a) => [a.id, a]));

  // Reconstruct accessSelections from priceBreakdown
  const accessSelections = priceBreakdown.accessItems.map((item) => ({
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

  return { ...registration, accessSelections };
}

/**
 * Enrich multiple registrations with accessSelections in a single batch.
 * More efficient than calling enrichWithAccessSelections for each one.
 */
export async function enrichManyWithAccessSelections(
  registrations: Array<
    Registration & {
      form: { id: string; name: string };
      event: { id: string; name: string; slug: string; clientId: string };
    }
  >,
): Promise<RegistrationWithRelations[]> {
  // Collect all unique access IDs across all registrations
  const allAccessIds = new Set<string>();
  for (const reg of registrations) {
    const priceBreakdown = reg.priceBreakdown as PriceBreakdown;
    if (priceBreakdown.accessItems) {
      for (const item of priceBreakdown.accessItems) {
        allAccessIds.add(item.accessId);
      }
    }
  }

  // Fetch all access details in one query
  const accessDetails = await prisma.eventAccess.findMany({
    where: { id: { in: Array.from(allAccessIds) } },
    select: { id: true, name: true, type: true, startsAt: true, endsAt: true },
  });

  const accessMap = new Map(accessDetails.map((a) => [a.id, a]));

  // Enrich each registration
  return registrations.map((registration) => {
    const priceBreakdown = registration.priceBreakdown as PriceBreakdown;

    if (
      !priceBreakdown.accessItems ||
      priceBreakdown.accessItems.length === 0
    ) {
      return { ...registration, accessSelections: [] };
    }

    const accessSelections = priceBreakdown.accessItems.map((item) => ({
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

    return { ...registration, accessSelections };
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
    idempotencyKey,
    linkBaseUrl,
  } = input;

  // Get form and event info (including schemaVersion)
  const form = await findOrThrow(
    () =>
      prisma.form.findUnique({
        where: { id: formId },
        select: { id: true, eventId: true, schemaVersion: true },
      }),
    { message: "Form not found", code: ErrorCodes.NOT_FOUND },
  );

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
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
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
      const editToken = randomBytes(EDIT_TOKEN_LENGTH).toString("hex");
      const editTokenExpiry = new Date(
        Date.now() + EDIT_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000,
      );

      // Determine initial payment status (auto-waive zero-amount registrations)
      const initialPaymentStatus =
        priceBreakdown.total === 0 ? "WAIVED" : "PENDING";

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
          paymentStatus: initialPaymentStatus,
          paidAt: initialPaymentStatus === "WAIVED" ? new Date() : null,
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
      if (accessSelections && accessSelections.length > 0) {
        for (const selection of accessSelections) {
          await reserveAccessSpot(selection.accessId, selection.quantity, tx);
        }
      }

      // Increment event registered count (atomic SQL within transaction)
      await incrementRegisteredCountTx(tx, eventId);

      // Return full registration with derived accessSelections
      const createdReg = await tx.registration.findUnique({
        where: { id: registration.id },
        include: {
          form: { select: { id: true, name: true } },
          event: {
            select: { id: true, name: true, slug: true, clientId: true },
          },
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
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new AppError(
        "A registration with this email already exists for this form",
        409,
        true,
        ErrorCodes.REGISTRATION_ALREADY_EXISTS,
      );
    }
    throw err;
  }

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
  const registration = await findOrThrow(
    () => prisma.registration.findUnique({ where: { id } }),
    {
      message: "Registration not found",
      code: ErrorCodes.REGISTRATION_NOT_FOUND,
    },
  );

  const updateData: Prisma.RegistrationUpdateInput = {};

  if (input.paymentStatus !== undefined) {
    // Validate payment status transition
    validatePaymentTransitionInternal(
      registration.paymentStatus,
      input.paymentStatus,
    );

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
  if (
    input.paymentStatus !== undefined &&
    input.paymentStatus !== registration.paymentStatus
  ) {
    changes.paymentStatus = {
      old: registration.paymentStatus,
      new: input.paymentStatus,
    };
  }
  if (
    input.paidAmount !== undefined &&
    input.paidAmount !== registration.paidAmount
  ) {
    changes.paidAmount = {
      old: registration.paidAmount,
      new: input.paidAmount,
    };
  }
  if (
    input.paymentMethod !== undefined &&
    input.paymentMethod !== registration.paymentMethod
  ) {
    changes.paymentMethod = {
      old: registration.paymentMethod,
      new: input.paymentMethod,
    };
  }
  if (
    input.paymentReference !== undefined &&
    input.paymentReference !== registration.paymentReference
  ) {
    changes.paymentReference = {
      old: registration.paymentReference,
      new: input.paymentReference,
    };
  }
  if (input.note !== undefined && input.note !== registration.note) {
    changes.note = { old: registration.note, new: input.note };
  }

  await prisma.$transaction(async (tx) => {
    await tx.registration.update({ where: { id }, data: updateData });

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
 * Delete a registration (only allowed for unpaid registrations).
 * For paid registrations, use refund flow instead.
 */
export async function deleteRegistration(
  id: string,
  performedBy?: string,
): Promise<void> {
  const registration = await findOrThrow(
    () =>
      prisma.registration.findUnique({
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
      }),
    {
      message: "Registration not found",
      code: ErrorCodes.REGISTRATION_NOT_FOUND,
    },
  );

  // Only allow deletion of unpaid registrations
  const blockedStatuses = ["PAID", "WAIVED", "VERIFYING"];
  if (blockedStatuses.includes(registration.paymentStatus)) {
    throw new AppError(
      `Cannot delete a ${registration.paymentStatus.toLowerCase()} registration.`,
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
        },
        performedBy: performedBy ?? null,
      },
    });

    // Release access spots (get from priceBreakdown)
    const priceBreakdown = registration.priceBreakdown as PriceBreakdown;
    if (priceBreakdown.accessItems) {
      for (const item of priceBreakdown.accessItems) {
        await releaseAccessSpot(item.accessId, item.quantity, tx);
      }
    }

    // Decrement event registered count (atomic SQL within transaction)
    await decrementRegisteredCountTx(tx, registration.eventId);

    // Clean up sponsorship usages before deletion
    await cleanupSponsorshipsForRegistration(tx, id);

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

export async function listAllRegistrations(
  query: ListAllRegistrationsQuery,
): Promise<PaginatedResult<RegistrationWithRelations>> {
  const { page, limit, paymentStatus, search, eventId } = query;

  const where: Prisma.RegistrationWhereInput = {};

  if (eventId) where.eventId = eventId;
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

export async function getRegistrationClientId(
  id: string,
): Promise<string | null> {
  const registration = await prisma.registration.findUnique({
    where: { id },
    include: { event: { select: { clientId: true } } },
  });
  return registration?.event.clientId ?? null;
}

// ============================================================================
// Internal helper exported for use by payment service
// ============================================================================

/**
 * Validate payment status transition.
 * Throws if transition is not allowed.
 * Exported so payment service can reuse it.
 */
export const PAYMENT_STATUS_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["VERIFYING", "PAID", "WAIVED", "REFUNDED"],
  VERIFYING: ["PAID", "PENDING", "REFUNDED"],
  PAID: ["REFUNDED"],
  WAIVED: ["REFUNDED"],
  REFUNDED: [],
};

export function validatePaymentTransitionInternal(
  currentStatus: string,
  newStatus: string,
): void {
  if (currentStatus === newStatus) return;

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
