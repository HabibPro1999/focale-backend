import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { UserRole } from "@shared/constants/roles.js";
import { logger } from "@shared/utils/logger.js";
import { auditLog } from "@shared/utils/audit.js";
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
import { calculatePrice, type PriceBreakdown } from "@pricing";
import { queueTriggeredEmail } from "@email";
import { validateFormData, sanitizeFormData, type FormSchema } from "@forms";
import type {
  CreateRegistrationInput,
  AdminCreateRegistrationInput,
  UpdateRegistrationInput,
  ListRegistrationsQuery,
  PublicEditRegistrationInput,
} from "./registrations.schema.js";
import type { Prisma } from "@/generated/prisma/client.js";

// Imports from extracted sub-modules
import { generateEditToken } from "./edit-token.js";
import {
  enrichWithAccessSelections,
  enrichManyWithAccessSelections,
  calculateDiscountAmount,
  type RegistrationWithRelations,
} from "./registration-enrichment.js";
import { validatePaymentTransition } from "./registration-payment.js";

// ============================================================================
// Re-exports — routes and barrel consume these from this file
// ============================================================================

export { verifyEditToken } from "./edit-token.js";
export {
  confirmPayment,
  uploadPaymentProof,
  extractKeyFromUrl,
  selectPaymentMethod,
  type PaymentProofResponse,
} from "./registration-payment.js";
export {
  getRegistrationTableColumns,
  type RegistrationTableColumns,
} from "./table-columns.js";
export {
  listRegistrationAuditLogs,
  listRegistrationEmailLogs,
  searchRegistrantsForSponsorship,
} from "./registration-queries.js";

// ============================================================================
// Create Registration (Public)
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
    throw new AppError("Form not found", 404, ErrorCodes.NOT_FOUND);
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
      ErrorCodes.REGISTRATION_ALREADY_EXISTS,
    );
  }

  // Advisory check only — reserveAccessSpot inside the tx is the authoritative capacity gate
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
        ErrorCodes.EVENT_NOT_OPEN,
      );
    }

    // Check event capacity
    if (
      event.maxCapacity !== null &&
      event.registeredCount >= event.maxCapacity
    ) {
      throw new AppError("Event is at capacity", 409, ErrorCodes.EVENT_FULL);
    }

    // Generate edit token for secure self-service editing
    const editToken = generateEditToken();

    // Create registration with relations in a single query
    const createdReg = await tx.registration.create({
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
        // Browser origin URL for email links
        linkBaseUrl: linkBaseUrl ?? null,
        // Idempotency key for safe retries
        idempotencyKey: idempotencyKey ?? null,
      },
      include: {
        form: { select: { id: true, name: true } },
        event: { select: { id: true, name: true, slug: true, clientId: true } },
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

    // Create audit log for registration creation
    await auditLog(tx, {
      entityType: "Registration",
      entityId: createdReg.id,
      action: "CREATE",
      changes: {
        email: { old: null, new: email },
        firstName: { old: null, new: firstName ?? null },
        lastName: { old: null, new: lastName ?? null },
        totalAmount: { old: null, new: priceBreakdown.total },
      },
      performedBy: "PUBLIC",
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

// ============================================================================
// Admin Create Registration
// ============================================================================

export async function createAdminRegistration(
  eventId: string,
  input: AdminCreateRegistrationInput,
  adminUserId: string,
): Promise<RegistrationWithRelations> {
  const {
    email,
    firstName,
    lastName,
    phone,
    formData,
    role,
    accessSelections,
    paymentMethod,
    paymentStatus,
    labName,
  } = input;

  // Find the registration form for this event
  const form = await prisma.form.findFirst({
    where: { eventId, type: "REGISTRATION" },
    select: { id: true, schemaVersion: true },
  });
  if (!form) {
    throw new AppError(
      "No registration form found for this event",
      404,
      ErrorCodes.NOT_FOUND,
    );
  }

  // Check for duplicate registration (same unique constraint as public form)
  const existing = await prisma.registration.findUnique({
    where: { email_formId: { email, formId: form.id } },
  });
  if (existing) {
    throw new AppError(
      "A registration with this email already exists for this form",
      409,
      ErrorCodes.REGISTRATION_ALREADY_EXISTS,
    );
  }

  // Validate access selections if any
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
        ErrorCodes.BAD_REQUEST,
        { errors: validation.errors },
      );
    }
  }

  // Calculate price from access selections (no sponsorship for admin-created)
  const selectedAccessItems = (accessSelections ?? []).map((s) => ({
    accessId: s.accessId,
    quantity: s.quantity,
  }));

  const calculatedPrice = await calculatePrice(eventId, {
    formData,
    selectedAccessItems,
    sponsorshipCodes: [],
  });

  // Transform to registration PriceBreakdown format
  const priceBreakdown: PriceBreakdown = {
    basePrice: calculatedPrice.basePrice,
    appliedRules: calculatedPrice.appliedRules,
    calculatedBasePrice: calculatedPrice.calculatedBasePrice,
    accessItems: calculatedPrice.accessItems.map((item) => ({
      accessId: item.accessId,
      name: item.name,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      subtotal: item.subtotal,
    })),
    accessTotal: calculatedPrice.accessTotal,
    subtotal: calculatedPrice.subtotal,
    sponsorships: calculatedPrice.sponsorships,
    sponsorshipTotal: calculatedPrice.sponsorshipTotal,
    total: calculatedPrice.total,
    currency: calculatedPrice.currency,
  };

  const result = await prisma.$transaction(async (tx) => {
    // Re-check event status and capacity inside the transaction to prevent TOCTOU races.
    // Admin-created registrations still respect capacity limits.
    const event = await tx.event.findUnique({
      where: { id: eventId },
      select: { status: true, maxCapacity: true, registeredCount: true },
    });

    // Admins can create registrations for OPEN or CLOSED events.
    // ARCHIVED events are historical and no longer accept any registrations.
    if (!event || event.status === "ARCHIVED") {
      throw new AppError(
        "Cannot add registrations to an archived event",
        400,
        ErrorCodes.EVENT_NOT_OPEN,
      );
    }

    if (
      event.maxCapacity !== null &&
      event.registeredCount >= event.maxCapacity
    ) {
      throw new AppError("Event is at capacity", 409, ErrorCodes.EVENT_FULL);
    }

    // Determine payment status: explicit override > method-derived > PENDING
    const resolvedPaymentStatus =
      paymentStatus ??
      (paymentMethod === "LAB_SPONSORSHIP" ? "WAIVED" : "PENDING");

    const createdReg = await tx.registration.create({
      data: {
        formId: form.id,
        eventId,
        formData: formData as Prisma.InputJsonValue,
        formSchemaVersion: form.schemaVersion,
        email,
        firstName,
        lastName,
        phone: phone ?? null,
        role,
        paymentStatus: resolvedPaymentStatus,
        paymentMethod: paymentMethod ?? null,
        labName: paymentMethod === "LAB_SPONSORSHIP" ? (labName ?? null) : null,
        totalAmount: priceBreakdown.total,
        currency: priceBreakdown.currency,
        priceBreakdown: priceBreakdown as unknown as Prisma.InputJsonValue,
        baseAmount: priceBreakdown.calculatedBasePrice,
        discountAmount: calculateDiscountAmount(priceBreakdown.appliedRules),
        accessAmount: calculatedPrice.accessTotal,
        sponsorshipAmount: 0,
        accessTypeIds: accessSelections?.map((s) => s.accessId) ?? [],
        // Admin-created: no edit token, no idempotency key, no link base URL
        editToken: null,
        linkBaseUrl: null,
        idempotencyKey: null,
      },
      include: {
        form: { select: { id: true, name: true } },
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            clientId: true,
            startDate: true,
            location: true,
          },
        },
      },
    });

    // Reserve access spots
    if (accessSelections && accessSelections.length > 0) {
      for (const selection of accessSelections) {
        await reserveAccessSpot(selection.accessId, selection.quantity, tx);
      }
    }

    await incrementRegisteredCountTx(tx, eventId);

    await auditLog(tx, {
      entityType: "Registration",
      entityId: createdReg.id,
      action: "CREATE",
      changes: {
        email: { old: null, new: email },
        firstName: { old: null, new: firstName },
        lastName: { old: null, new: lastName },
        role: { old: null, new: role },
        totalAmount: { old: null, new: priceBreakdown.total },
      },
      performedBy: adminUserId,
    });

    return enrichWithAccessSelections(createdReg);
  });

  return result;
}

// ============================================================================
// Read Operations
// ============================================================================

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

  const enriched = await enrichWithAccessSelections(registration);
  // M23: strip editToken from admin responses
  const { editToken: _omitted, ...safeResult } = enriched;
  return safeResult as RegistrationWithRelations;
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

// ============================================================================
// Update Registration (Admin)
// ============================================================================

export async function updateRegistration(
  id: string,
  input: UpdateRegistrationInput,
  performedBy?: string,
): Promise<RegistrationWithRelations> {
  await prisma.$transaction(async (tx) => {
    const registration = await tx.registration.findUnique({ where: { id } });
    if (!registration) {
      throw new AppError(
        "Registration not found",
        404,
        ErrorCodes.REGISTRATION_NOT_FOUND,
      );
    }

    const updateData: Prisma.RegistrationUpdateInput = {};

    if (input.paymentStatus !== undefined) {
      // Validate payment status transition
      validatePaymentTransition(
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
    if (input.paidAmount !== undefined)
      updateData.paidAmount = input.paidAmount;
    if (input.paymentMethod !== undefined)
      updateData.paymentMethod = input.paymentMethod;
    if (input.paymentReference !== undefined)
      updateData.paymentReference = input.paymentReference;
    if (input.paymentProofUrl !== undefined)
      updateData.paymentProofUrl = input.paymentProofUrl;
    if (input.note !== undefined) updateData.note = input.note;
    if (input.role !== undefined) updateData.role = input.role;

    // Build changes object for audit log
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (input.note !== undefined && input.note !== registration.note) {
      changes.note = { old: registration.note, new: input.note };
    }
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
    if (input.role !== undefined && input.role !== registration.role) {
      changes.role = { old: registration.role, new: input.role };
    }

    await tx.registration.update({ where: { id }, data: updateData });

    // Create audit log if there are changes
    if (Object.keys(changes).length > 0) {
      await auditLog(tx, {
        entityType: "Registration",
        entityId: id,
        action: "UPDATE",
        changes,
        performedBy: performedBy ?? undefined,
      });
    }
  });

  return getRegistrationById(id) as Promise<RegistrationWithRelations>;
}

// ============================================================================
// Delete Registration
// ============================================================================

/**
 * Delete a registration. Blocks deletion of PAID registrations unless force=true.
 * Force-delete requires CLIENT_ADMIN role and is logged in the audit trail.
 */
export async function deleteRegistration(
  id: string,
  performedBy?: string,
  force?: boolean,
  requestingUserRole?: number,
): Promise<void> {
  // Force-delete requires CLIENT_ADMIN role (fast check before DB access)
  if (force && requestingUserRole !== UserRole.CLIENT_ADMIN) {
    throw new AppError(
      "Only client admins can force-delete registrations",
      403,
      ErrorCodes.FORBIDDEN,
    );
  }

  await prisma.$transaction(async (tx) => {
    const registration = await tx.registration.findUnique({
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
        ErrorCodes.REGISTRATION_NOT_FOUND,
      );
    }

    // Only allow deletion of unpaid registrations (unless force=true)
    if (registration.paymentStatus === "PAID" && !force) {
      throw new AppError(
        "Cannot delete a paid registration. Use refund instead.",
        400,
        ErrorCodes.REGISTRATION_DELETE_BLOCKED,
      );
    }

    // Create audit log before deletion
    await auditLog(tx, {
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
      performedBy: performedBy ?? undefined,
    });

    // Release access spots (get from priceBreakdown)
    // Pass tx so release is rolled back if the transaction fails
    const priceBreakdown = registration.priceBreakdown as PriceBreakdown;
    if (priceBreakdown.accessItems) {
      for (const item of priceBreakdown.accessItems) {
        await releaseAccessSpot(item.accessId, item.quantity, tx);
      }
    }

    // Decrement event registered count (atomic SQL within transaction)
    await decrementRegisteredCountTx(tx, registration.eventId);

    // Delete the registration
    await tx.registration.delete({ where: { id } });
  });
}

// ============================================================================
// List Registrations
// ============================================================================

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
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            clientId: true,
            startDate: true,
            location: true,
          },
        },
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
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );
  }

  // 2. Validate registration can be edited
  if (registration.paymentStatus === "REFUNDED") {
    throw new AppError(
      "Refunded registrations cannot be edited",
      400,
      ErrorCodes.REGISTRATION_REFUNDED,
    );
  }

  if (registration.event.status !== "OPEN") {
    throw new AppError(
      "Event is not accepting changes",
      400,
      ErrorCodes.REGISTRATION_EDIT_FORBIDDEN,
    );
  }

  // 2b. Block access edits for VERIFYING registrations
  if (registration.paymentStatus === "VERIFYING" && input.accessSelections) {
    throw new AppError(
      "Cannot modify access while payment is under review",
      400,
      ErrorCodes.REGISTRATION_VERIFYING_BLOCKED,
    );
  }

  // 2c. Block access edits for WAIVED registrations
  if (registration.paymentStatus === "WAIVED" && input.accessSelections) {
    throw new AppError(
      "Waived registrations cannot modify access selections",
      400,
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
        ErrorCodes.BAD_REQUEST,
        { errors: validation.errors },
      );
    }
  }

  // Price calculated before tx — stale pricing rules could affect this but the difference is bounded
  // 9. Calculate new price breakdown
  const selectedAccessItems = newAccessSelections.map((s) => ({
    accessId: s.accessId,
    quantity: s.quantity,
  }));

  const calculatedPrice = await calculatePrice(registration.eventId, {
    formData: newFormData,
    selectedAccessItems,
    sponsorshipCodes: registration.sponsorshipCode
      ? [registration.sponsorshipCode]
      : [],
  });

  // Transform to registration format
  const newPriceBreakdown: PriceBreakdown = {
    basePrice: calculatedPrice.basePrice,
    appliedRules: calculatedPrice.appliedRules,
    calculatedBasePrice: calculatedPrice.calculatedBasePrice,
    accessItems: calculatedPrice.accessItems.map((item) => ({
      accessId: item.accessId,
      name: item.name,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      subtotal: item.subtotal,
    })),
    accessTotal: calculatedPrice.accessTotal,
    subtotal: calculatedPrice.subtotal,
    sponsorships: calculatedPrice.sponsorships,
    sponsorshipTotal: calculatedPrice.sponsorshipTotal,
    total: calculatedPrice.total,
    currency: calculatedPrice.currency,
  };

  // 10. Execute transaction — registration re-read inside tx to prevent TOCTOU
  await prisma.$transaction(async (tx) => {
    // Re-read the registration inside the transaction to get consistent state
    const currentRegistration = await tx.registration.findUnique({
      where: { id: registrationId },
      select: {
        paymentStatus: true,
        paidAmount: true,
        totalAmount: true,
        sponsorshipAmount: true,
        firstName: true,
        lastName: true,
        phone: true,
      },
    });
    if (!currentRegistration) {
      throw new AppError(
        "Registration not found",
        404,
        ErrorCodes.REGISTRATION_NOT_FOUND,
      );
    }

    // Re-validate guards on current state (prevents TOCTOU on concurrent edits)
    if (currentRegistration.paymentStatus === "REFUNDED") {
      throw new AppError(
        "Refunded registrations cannot be edited",
        400,
        ErrorCodes.REGISTRATION_REFUNDED,
      );
    }
    const currentIsPaid =
      currentRegistration.paymentStatus === "PAID" ||
      currentRegistration.paidAmount > 0;
    if (currentIsPaid && accessToRemove.length > 0) {
      throw new AppError(
        "Cannot remove access items from a paid registration",
        400,
        ErrorCodes.REGISTRATION_ACCESS_REMOVAL_BLOCKED,
      );
    }

    // Reserve new access spots
    // Pass tx so reservation is rolled back if the transaction fails
    for (const selection of accessToAdd) {
      await reserveAccessSpot(selection.accessId, selection.quantity, tx);
    }

    // Release removed access spots (only if not paid)
    // Pass tx so release is rolled back if the transaction fails
    if (!currentIsPaid) {
      for (const item of accessToRemove) {
        await releaseAccessSpot(item.accessId, item.quantity, tx);
      }
    }

    // Calculate new total. For paid registrations, never decrease below
    // the original total — pricing rule changes via form data edits
    // should not reduce what was already owed.
    const newTotalAmount = currentIsPaid
      ? Math.max(currentRegistration.totalAmount, newPriceBreakdown.total)
      : newPriceBreakdown.total;

    // Update registration
    await tx.registration.update({
      where: { id: registrationId },
      data: {
        formData: newFormData as Prisma.InputJsonValue,
        firstName: input.firstName ?? currentRegistration.firstName,
        lastName: input.lastName ?? currentRegistration.lastName,
        phone: input.phone ?? currentRegistration.phone,
        totalAmount: newTotalAmount,
        priceBreakdown: newPriceBreakdown as unknown as Prisma.InputJsonValue,
        baseAmount: newPriceBreakdown.calculatedBasePrice,
        accessAmount: newPriceBreakdown.accessTotal,
        discountAmount: calculateDiscountAmount(newPriceBreakdown.appliedRules),
        sponsorshipAmount: newPriceBreakdown.sponsorshipTotal,
        accessTypeIds: newAccessSelections.map((s) => s.accessId),
        lastEditedAt: new Date(),
      },
    });

    // Build changes for audit log
    const auditChanges: Record<string, { old: unknown; new: unknown }> = {};
    if (input.formData) {
      auditChanges.formData = { old: currentFormData, new: newFormData };
    }
    if (
      input.firstName !== undefined &&
      input.firstName !== currentRegistration.firstName
    ) {
      auditChanges.firstName = {
        old: currentRegistration.firstName,
        new: input.firstName,
      };
    }
    if (
      input.lastName !== undefined &&
      input.lastName !== currentRegistration.lastName
    ) {
      auditChanges.lastName = {
        old: currentRegistration.lastName,
        new: input.lastName,
      };
    }
    if (
      input.phone !== undefined &&
      input.phone !== currentRegistration.phone
    ) {
      auditChanges.phone = { old: currentRegistration.phone, new: input.phone };
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
      await auditLog(tx, {
        entityType: "Registration",
        entityId: registrationId,
        action: "UPDATE",
        changes: auditChanges,
        performedBy: "PUBLIC",
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
