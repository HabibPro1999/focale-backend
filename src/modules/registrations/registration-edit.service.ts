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
import type { RegistrationWithRelations } from "./registration-enrichment.service.js";
import {
  calculateDiscountAmount,
  parsePriceBreakdown,
  reconstructAccessSelections,
  toPersistablePriceBreakdown,
} from "./registration-enrichment.service.js";
import { getRegistrationById } from "./registration-crud.service.js";
import { Prisma } from "@/generated/prisma/client.js";

// ============================================================================
// Types
// ============================================================================

type TransactionClient = Parameters<
  Parameters<typeof prisma.$transaction>[0]
>[0];

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
 * - REFUNDED -> block everything
 * - Event not OPEN -> block everything
 * - VERIFYING -> block access edits (personal info stays editable)
 * - PAID or paidAmount > 0 -> cannot remove access (can still add)
 * - WAIVED -> block all access edits
 * - Fully sponsored -> block all access edits
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

  if (registration.paymentStatus === "REFUNDED") {
    canEdit = false;
    canEditPersonalInfo = false;
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    editRestrictions.push("Registration has been refunded");
  }

  if (registration.event.status !== "OPEN") {
    canEdit = false;
    canEditPersonalInfo = false;
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    editRestrictions.push("Event is not accepting changes");
  }

  if (registration.paymentStatus === "VERIFYING") {
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    editRestrictions.push("Payment proof is under review");
  }

  const isPaid =
    registration.paymentStatus === "PAID" || registration.paidAmount > 0;
  if (isPaid) {
    canRemoveAccess = false;
    editRestrictions.push("Cannot remove access items (payment received)");
  }

  if (registration.paymentStatus === "WAIVED") {
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    editRestrictions.push(
      "Waived registrations cannot modify access selections",
    );
  }

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

  if (registration.editTokenExpiry < new Date()) {
    return false;
  }

  try {
    const isValid = timingSafeEqual(
      Buffer.from(registration.editToken, "utf8"),
      Buffer.from(token, "utf8"),
    );
    return isValid;
  } catch {
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

  const priceBreakdown = parsePriceBreakdown(registration.priceBreakdown);
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

  const accessSelections =
    priceBreakdown.accessItems.length > 0
      ? reconstructAccessSelections(priceBreakdown, accessMap, registration.id)
      : [];

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

// ============================================================================
// Private Helpers for editRegistrationPublic
// ============================================================================

type AccessItem = { accessId: string; quantity: number };
type AccessSelection = { accessId: string; quantity: number };
type AccessDiffResult = {
  accessToAdd: AccessSelection[];
  accessToRemove: AccessItem[];
  quantityDeltas: Array<{ accessId: string; delta: number }>;
};

function validateEditPermissions(
  registration: {
    paymentStatus: string;
    sponsorshipAmount: number;
    totalAmount: number;
    event: { status: string };
  },
  newAccessSelections: AccessSelection[] | undefined,
): void {
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
  if (registration.paymentStatus === "VERIFYING" && newAccessSelections) {
    throw new AppError(
      "Cannot modify access while payment is under review",
      400,
      true,
      ErrorCodes.REGISTRATION_VERIFYING_BLOCKED,
    );
  }
  if (registration.paymentStatus === "WAIVED" && newAccessSelections) {
    throw new AppError(
      "Waived registrations cannot modify access selections",
      400,
      true,
      ErrorCodes.REGISTRATION_WAIVED_ACCESS_BLOCKED,
    );
  }
  if (
    registration.sponsorshipAmount >= registration.totalAmount &&
    registration.totalAmount > 0 &&
    newAccessSelections
  ) {
    throw new AppError(
      "Fully sponsored registrations cannot modify access selections",
      400,
      true,
      ErrorCodes.REGISTRATION_FULLY_SPONSORED_BLOCKED,
    );
  }
}

function validateFormDataChanges(
  schema: unknown,
  newFormData: Record<string, unknown>,
  inputFormData: Record<string, unknown> | undefined,
): void {
  if (!inputFormData) return;
  const validationResult = validateFormData(
    schema as unknown as FormSchema,
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

function computeAccessDiff(
  currentAccessItems: AccessItem[],
  newAccessSelections: AccessSelection[],
): AccessDiffResult {
  const currentAccessIds = new Set(
    currentAccessItems.map((item) => item.accessId),
  );
  const newAccessIds = new Set(newAccessSelections.map((s) => s.accessId));

  const accessToAdd = newAccessSelections.filter(
    (s) => !currentAccessIds.has(s.accessId),
  );
  const accessToRemove = currentAccessItems.filter(
    (item) => !newAccessIds.has(item.accessId),
  );

  const quantityDeltas: Array<{ accessId: string; delta: number }> = [];
  for (const newSel of newAccessSelections) {
    if (currentAccessIds.has(newSel.accessId)) {
      const currentItem = currentAccessItems.find(
        (item) => item.accessId === newSel.accessId,
      );
      const delta = newSel.quantity - (currentItem?.quantity ?? 1);
      if (delta !== 0) {
        quantityDeltas.push({ accessId: newSel.accessId, delta });
      }
    }
  }

  return { accessToAdd, accessToRemove, quantityDeltas };
}

function enforceAccessRemovalRule(
  isPaid: boolean,
  accessToRemove: AccessItem[],
): void {
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
}

function deriveNewAccessSelections(
  inputAccessSelections: AccessSelection[] | undefined,
  currentAccessItems: AccessItem[],
): AccessSelection[] {
  return (
    inputAccessSelections ??
    currentAccessItems.map((item) => ({
      accessId: item.accessId,
      quantity: item.quantity,
    }))
  );
}

async function validateNewAccessSelections(
  eventId: string,
  accessToAdd: AccessSelection[],
  newFormData: Record<string, unknown>,
  inputAccessSelections: AccessSelection[] | undefined,
): Promise<void> {
  if (!inputAccessSelections || accessToAdd.length === 0) return;
  const validation = await validateAccessSelections(
    eventId,
    accessToAdd,
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

async function calculateNewPricing(
  eventId: string,
  newAccessSelections: AccessSelection[],
  newFormData: Record<string, unknown>,
  sponsorshipCode: string | null,
): Promise<PriceBreakdown> {
  const selectedExtras = newAccessSelections.map((s) => ({
    extraId: s.accessId,
    quantity: s.quantity,
  }));
  const calculatedPrice = await calculatePrice(eventId, {
    formData: newFormData,
    selectedExtras,
    sponsorshipCodes: sponsorshipCode ? [sponsorshipCode] : [],
  });
  return toPersistablePriceBreakdown(calculatedPrice);
}

async function executeEditTransaction(
  tx: TransactionClient,
  registrationId: string,
  registration: {
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    totalAmount: number;
  },
  newFormData: Record<string, unknown>,
  personalInfo: { firstName?: string; lastName?: string; phone?: string },
  newPriceBreakdown: PriceBreakdown,
  isPaid: boolean,
  newAccessSelections: AccessSelection[],
  accessToAdd: AccessSelection[],
  accessToRemove: AccessItem[],
  quantityDeltas: Array<{ accessId: string; delta: number }>,
  currentFormData: Record<string, unknown>,
  inputFormData: Record<string, unknown> | undefined,
): Promise<void> {
  await manageAccessSpots(tx, accessToAdd, accessToRemove, quantityDeltas, isPaid);

  await tx.registration.update({
    where: { id: registrationId },
    data: buildRegistrationUpdate(
      registration,
      newFormData,
      personalInfo,
      newPriceBreakdown,
      isPaid,
      newAccessSelections,
    ),
  });

  const auditChanges = buildAuditChanges(
    registration,
    newFormData,
    personalInfo,
    accessToAdd,
    accessToRemove,
    currentFormData,
    inputFormData,
  );
  if (auditChanges) {
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
}

async function manageAccessSpots(
  tx: TransactionClient,
  accessToAdd: AccessSelection[],
  accessToRemove: AccessItem[],
  quantityDeltas: Array<{ accessId: string; delta: number }>,
  isPaid: boolean,
): Promise<void> {
  for (const selection of accessToAdd) {
    await reserveAccessSpot(selection.accessId, selection.quantity, tx);
  }
  if (!isPaid) {
    for (const item of accessToRemove) {
      await releaseAccessSpot(item.accessId, item.quantity, tx);
    }
  }
  for (const { accessId, delta } of quantityDeltas) {
    if (delta > 0) {
      await reserveAccessSpot(accessId, delta, tx);
    } else {
      await releaseAccessSpot(accessId, Math.abs(delta), tx);
    }
  }
}

function buildRegistrationUpdate(
  registration: {
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    totalAmount: number;
  },
  newFormData: Record<string, unknown>,
  personalInfo: { firstName?: string; lastName?: string; phone?: string },
  newPriceBreakdown: PriceBreakdown,
  isPaid: boolean,
  newAccessSelections: AccessSelection[],
): Prisma.RegistrationUpdateInput {
  const newTotalAmount = isPaid
    ? Math.max(registration.totalAmount, newPriceBreakdown.total)
    : newPriceBreakdown.total;

  return {
    formData: newFormData as Prisma.InputJsonValue,
    firstName: personalInfo.firstName ?? registration.firstName,
    lastName: personalInfo.lastName ?? registration.lastName,
    phone: personalInfo.phone ?? registration.phone,
    totalAmount: newTotalAmount,
    priceBreakdown: newPriceBreakdown as unknown as Prisma.InputJsonValue,
    baseAmount: newPriceBreakdown.calculatedBasePrice,
    accessAmount: newPriceBreakdown.accessTotal,
    discountAmount: calculateDiscountAmount(newPriceBreakdown.appliedRules),
    sponsorshipAmount: newPriceBreakdown.sponsorshipTotal,
    accessTypeIds: newAccessSelections.map((s) => s.accessId),
    lastEditedAt: new Date(),
  };
}

function buildAuditChanges(
  oldRegistration: {
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
  },
  newFormData: Record<string, unknown>,
  personalInfo: { firstName?: string; lastName?: string; phone?: string },
  accessToAdd: AccessSelection[],
  accessToRemove: AccessItem[],
  currentFormData: Record<string, unknown>,
  inputFormData: Record<string, unknown> | undefined,
): Record<string, { old: unknown; new: unknown }> | null {
  const auditChanges: Record<string, { old: unknown; new: unknown }> = {};

  if (inputFormData) {
    const oldFields: Record<string, unknown> = {};
    const newFields: Record<string, unknown> = {};
    for (const key of Object.keys(newFormData)) {
      if (newFormData[key] !== currentFormData[key]) {
        oldFields[key] = currentFormData[key];
        newFields[key] = newFormData[key];
      }
    }
    if (Object.keys(newFields).length > 0) {
      auditChanges.formData = { old: oldFields, new: newFields };
    }
  }

  if (
    personalInfo.firstName &&
    personalInfo.firstName !== oldRegistration.firstName
  ) {
    auditChanges.firstName = {
      old: oldRegistration.firstName,
      new: personalInfo.firstName,
    };
  }
  if (
    personalInfo.lastName &&
    personalInfo.lastName !== oldRegistration.lastName
  ) {
    auditChanges.lastName = {
      old: oldRegistration.lastName,
      new: personalInfo.lastName,
    };
  }
  if (personalInfo.phone && personalInfo.phone !== oldRegistration.phone) {
    auditChanges.phone = { old: oldRegistration.phone, new: personalInfo.phone };
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

  return Object.keys(auditChanges).length > 0 ? auditChanges : null;
}

// ============================================================================
// Public Edit Orchestrator
// ============================================================================

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
  const registration = await prisma.registration.findUnique({
    where: { id: registrationId },
    include: {
      form: { select: { id: true, eventId: true, schema: true } },
      event: { select: { id: true, status: true } },
    },
  });
  if (!registration) throw new AppError("Registration not found", 404, true, ErrorCodes.REGISTRATION_NOT_FOUND);

  validateEditPermissions(registration, input.accessSelections);

  const isPaid = registration.paymentStatus === "PAID" || registration.paidAmount > 0;
  const currentFormData = registration.formData as Record<string, unknown>;
  const newFormData = input.formData
    ? { ...currentFormData, ...input.formData }
    : currentFormData;

  validateFormDataChanges(registration.form.schema, newFormData, input.formData);

  const currentAccessItems =
    parsePriceBreakdown(registration.priceBreakdown).accessItems ?? [];
  const newAccessSelections = deriveNewAccessSelections(
    input.accessSelections,
    currentAccessItems,
  );

  const { accessToAdd, accessToRemove, quantityDeltas } = computeAccessDiff(
    currentAccessItems,
    newAccessSelections,
  );

  enforceAccessRemovalRule(isPaid, accessToRemove);

  await validateNewAccessSelections(
    registration.eventId,
    accessToAdd,
    newFormData,
    input.accessSelections,
  );

  const newPriceBreakdown = await calculateNewPricing(
    registration.eventId,
    newAccessSelections,
    newFormData,
    registration.sponsorshipCode,
  );

  const personalInfo = { firstName: input.firstName, lastName: input.lastName, phone: input.phone };

  await prisma.$transaction((tx) =>
    executeEditTransaction(
      tx,
      registrationId,
      registration,
      newFormData,
      personalInfo,
      newPriceBreakdown,
      isPaid,
      newAccessSelections,
      accessToAdd,
      accessToRemove,
      quantityDeltas,
      currentFormData,
      input.formData,
    ),
  );

  const updatedRegistration = await getRegistrationById(registrationId);
  return {
    registration: updatedRegistration!,
    priceBreakdown: newPriceBreakdown,
  };
}
