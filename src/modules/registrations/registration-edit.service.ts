import { timingSafeEqual } from "crypto";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";
import {
  validateAccessSelections,
  reserveAccessSpot,
  releaseAccessSpot,
} from "@access";
import { calculatePrice } from "@pricing";
import { validateFormData, type FormSchema } from "./form-data-validator.js";
import type {
  PriceBreakdown,
  PublicEditRegistrationInput,
} from "./registrations.schema.js";
import type { RegistrationWithRelations } from "./registration-crud.service.js";
import {
  calculateDiscountAmount,
  getRegistrationById,
  toPersistablePriceBreakdown,
} from "./registration-crud.service.js";
import { Prisma } from "@/generated/prisma/client.js";

// ============================================================================
// Types
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

export type EditPermissions = {
  canEdit: boolean;
  canEditPersonalInfo: boolean;
  canEditAccess: boolean;
  canAddAccess: boolean;
  canRemoveAccess: boolean;
  isFullySponsored: boolean;
  editRestrictions: string[];
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

export type EditRegistrationPublicResult = {
  registration: RegistrationWithRelations;
  priceBreakdown: PriceBreakdown;
};

// ============================================================================
// Edit Permission Computation
// ============================================================================

/**
 * Compute all edit permission flags for a registration in a single pass.
 *
 * Rules (applied in priority order):
 * - REFUNDED → block everything
 * - Event not OPEN → block everything
 * - VERIFYING → block access edits (personal info stays editable)
 * - PAID or paidAmount > 0 → cannot remove access (can still add)
 * - WAIVED → block all access edits
 * - Fully sponsored → block all access edits
 */
function computeEditPermissions(registration: {
  paymentStatus: string;
  paidAmount: number;
  sponsorshipAmount: number;
  totalAmount: number;
  event: { status: string };
}): EditPermissions {
  let canEdit = true;
  let canEditPersonalInfo = true;
  let canEditAccess = true;
  let canAddAccess = true;
  let canRemoveAccess = true;
  let isFullySponsored = false;
  const editRestrictions: string[] = [];

  // REFUNDED → block everything
  if (registration.paymentStatus === "REFUNDED") {
    canEdit = false;
    canEditPersonalInfo = false;
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    editRestrictions.push("Registration has been refunded");
  }

  // Event not OPEN → block everything
  if (registration.event.status !== "OPEN") {
    canEdit = false;
    canEditPersonalInfo = false;
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    editRestrictions.push("Event is not accepting changes");
  }

  // VERIFYING → block access edits only (personal info stays editable)
  if (registration.paymentStatus === "VERIFYING") {
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    editRestrictions.push("Payment proof is under review");
  }

  // PAID or paidAmount > 0 → cannot remove access (can still add)
  const isPaid =
    registration.paymentStatus === "PAID" || registration.paidAmount > 0;
  if (isPaid) {
    canRemoveAccess = false;
    editRestrictions.push("Cannot remove access items (payment received)");
  }

  // WAIVED → block all access edits
  if (registration.paymentStatus === "WAIVED") {
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    editRestrictions.push(
      "Waived registrations cannot modify access selections",
    );
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
    editRestrictions.push(
      "Fully sponsored registration cannot modify access selections",
    );
  }

  return {
    canEdit,
    canEditPersonalInfo,
    canEditAccess,
    canAddAccess,
    canRemoveAccess,
    isFullySponsored,
    editRestrictions,
  };
}

// ============================================================================
// Edit Token Verification
// ============================================================================

/**
 * Verify an edit token for a registration.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export async function verifyEditToken(
  registrationId: string,
  token: string,
): Promise<boolean> {
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    select: { editToken: true, editTokenExpiry: true },
  });

  if (!registration?.editToken || !registration.editTokenExpiry) {
    return false;
  }

  // Check expiry first
  if (registration.editTokenExpiry < new Date()) {
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
// Public Self-Service Editing
// ============================================================================

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
  if (!registration)
    throw new AppError(
      "Registration not found",
      404,
      true,
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );

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

  const permissions = computeEditPermissions(registration);

  const amountDue = Math.max(
    0,
    registration.totalAmount - registration.paidAmount,
  );

  return {
    registration: enrichedRegistration as RegistrationForEdit,
    ...permissions,
    amountDue,
  };
}

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
  if (!registration)
    throw new AppError(
      "Registration not found",
      404,
      true,
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );

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
  const newFormData = input.formData
    ? { ...currentFormData, ...input.formData }
    : currentFormData;

  // 5. Validate new form data against form schema
  if (input.formData) {
    const validationResult = validateFormData(
      registration.form.schema as unknown as FormSchema,
      newFormData,
    );
    if (!validationResult.valid) {
      throw new AppError(
        "Form validation failed",
        400,
        true,
        ErrorCodes.FORM_VALIDATION_ERROR,
        { fieldErrors: validationResult.errors },
      );
    }
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

  // Transform to registration format using shared helper
  const newPriceBreakdown = toPersistablePriceBreakdown(calculatedPrice);

  // 10. Execute transaction
  await prisma.$transaction(async (tx) => {
    // Reserve new access spots
    for (const selection of accessToAdd) {
      await reserveAccessSpot(selection.accessId, selection.quantity, tx);
    }

    // Release removed access spots (only if not paid)
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
