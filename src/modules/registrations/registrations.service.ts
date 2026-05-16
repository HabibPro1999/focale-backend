import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import { UserRole } from "@shared/constants/roles.js";
import { auditLog } from "@shared/utils/audit.js";
import {
  assertEventAcceptsPublicActions,
  assertEventWritable,
  incrementRegisteredCountTx,
  decrementRegisteredCountTx,
} from "@events";
import { assertModuleEnabledForClient } from "@clients";
import {
  validateAccessSelections,
  incrementAccessRegisteredCountTx,
  decrementAccessRegisteredCountTx,
  incrementPaidCount,
  decrementPaidCount,
  handleCapacityReached,
} from "@access";
import { calculatePrice, type PriceBreakdown } from "@pricing";
import { validateFormData, sanitizeFormData, type FormSchema } from "@forms";
import type {
  CreateRegistrationInput,
  AdminCreateRegistrationInput,
  AdminEditRegistrationInput,
  UpdateRegistrationInput,
  PublicEditRegistrationInput,
} from "./registrations.schema.js";
import type { Prisma } from "@/generated/prisma/client.js";

// Imports from extracted sub-modules
import { generateEditToken } from "./edit-token.js";
import {
  enrichWithAccessSelections,
  calculateDiscountAmount,
  type RegistrationWithRelations,
} from "./registration-enrichment.js";
import { validatePaymentTransition } from "./registration-payment.js";
import { getRegistrationById } from "./registration-reads.js";
import { calculateSettlement } from "@shared/utils/settlement.js";
import { calculateApplicableAmount } from "@shared/utils/sponsorship-math.js";
import {
  emitRegistrationPostCommitEvents,
  queueRegistrationCreatedEmail,
  type RegistrationPostCommitEvent,
} from "./registration-side-effects.js";

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
export {
  getRegistrationById,
  getRegistrationByIdempotencyKey,
  listRegistrations,
  getRegistrationClientId,
  buildRegistrationWhere,
} from "./registration-reads.js";

// ============================================================================
// Capacity — Paid Count Sync
// ============================================================================

const FULLY_SETTLED_STATUSES = ["PAID", "SPONSORED", "WAIVED"];

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function assertLabSponsorshipAllowed(
  client: { enabledModules: string[] },
  paymentMethod: string | null | undefined,
): void {
  if (
    paymentMethod === "LAB_SPONSORSHIP" &&
    client.enabledModules.includes("sponsorships")
  ) {
    throw new AppError(
      "Lab sponsorship payment method is only available when sponsorships are disabled",
      400,
      ErrorCodes.BAD_REQUEST,
    );
  }
}

/**
 * Sync paidCount on access items when a registration's payment status changes.
 * Only handles transitions to/from FULLY settled states (PAID/SPONSORED/WAIVED).
 * PARTIAL is handled separately in sponsorship linking (per covered access item).
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
  const wasSettled = FULLY_SETTLED_STATUSES.includes(oldStatus);
  const isSettled = FULLY_SETTLED_STATUSES.includes(newStatus);
  if (wasSettled === isSettled) return; // No change in settled state

  const breakdown = registration.priceBreakdown as PriceBreakdown;
  const accessItems = breakdown.accessItems ?? [];
  if (accessItems.length === 0) return;

  if (!wasSettled && isSettled) {
    // Becoming fully settled: increment paidCount for all access items
    await Promise.all(
      accessItems.map(({ accessId, quantity }) =>
        incrementPaidCount(accessId, quantity, tx),
      ),
    );
    const accessIds = accessItems.map((a) => a.accessId);
    await handleCapacityReached(registration.eventId, accessIds, tx);
  } else {
    // Losing settled status (e.g. refund): decrement paidCount
    await Promise.all(
      accessItems.map(({ accessId, quantity }) =>
        decrementPaidCount(accessId, quantity, tx),
      ),
    );
  }
}

function paidAccessQuantities(
  status: string,
  priceBreakdown: unknown,
  coveredAccessIds = new Set<string>(),
): Map<string, number> {
  const quantities = new Map<string, number>();
  if (!FULLY_SETTLED_STATUSES.includes(status) && status !== "PARTIAL") {
    return quantities;
  }

  const breakdown = priceBreakdown as PriceBreakdown;
  for (const item of breakdown.accessItems ?? []) {
    if (
      FULLY_SETTLED_STATUSES.includes(status) ||
      coveredAccessIds.has(item.accessId)
    ) {
      quantities.set(
        item.accessId,
        (quantities.get(item.accessId) ?? 0) + item.quantity,
      );
    }
  }
  return quantities;
}

async function syncPaidCountForAccessEdit(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  eventId: string,
  oldStatus: string,
  oldBreakdown: unknown,
  newStatus: string,
  newBreakdown: unknown,
  coveredAccessIds: Set<string>,
): Promise<void> {
  const oldPaid = paidAccessQuantities(
    oldStatus,
    oldBreakdown,
    coveredAccessIds,
  );
  const newPaid = paidAccessQuantities(
    newStatus,
    newBreakdown,
    coveredAccessIds,
  );
  const accessIds = new Set([...oldPaid.keys(), ...newPaid.keys()]);
  const incremented: string[] = [];

  for (const accessId of accessIds) {
    const delta = (newPaid.get(accessId) ?? 0) - (oldPaid.get(accessId) ?? 0);
    if (delta > 0) {
      await incrementPaidCount(accessId, delta, tx);
      incremented.push(accessId);
    } else if (delta < 0) {
      await decrementPaidCount(accessId, Math.abs(delta), tx);
    }
  }

  if (incremented.length > 0) {
    await handleCapacityReached(eventId, incremented, tx);
  }
}

async function recalculateLinkedSponsorshipSettlement(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  registration: {
    id: string;
    paymentStatus: string;
    paidAt: Date | null;
  },
  priceBreakdown: PriceBreakdown,
): Promise<{
  priceBreakdown: PriceBreakdown;
  sponsorshipAmount: number;
  paymentStatus?: "PENDING" | "PARTIAL" | "SPONSORED";
  paidAt?: Date | null;
  coveredAccessIds: Set<string>;
}> {
  const usages = await tx.sponsorshipUsage.findMany({
    where: { registrationId: registration.id },
    select: {
      id: true,
      amountApplied: true,
      sponsorship: {
        select: {
          coversBasePrice: true,
          coveredAccessIds: true,
          totalAmount: true,
        },
      },
    },
  });

  const accessTypeIds = priceBreakdown.accessItems.map((item) => item.accessId);
  const coveredAccessIds = new Set<string>();
  let sponsorshipAmount = 0;

  if (usages.length === 0) {
    sponsorshipAmount = priceBreakdown.sponsorshipTotal;
    return {
      priceBreakdown,
      sponsorshipAmount,
      coveredAccessIds,
    };
  }

  for (const usage of usages) {
    for (const accessId of usage.sponsorship.coveredAccessIds) {
      coveredAccessIds.add(accessId);
    }
    const amountApplied = calculateApplicableAmount(
      usage.sponsorship,
      {
        totalAmount: priceBreakdown.subtotal,
        baseAmount: priceBreakdown.calculatedBasePrice,
        accessTypeIds,
        priceBreakdown,
      },
    );
    sponsorshipAmount += amountApplied;
    if (amountApplied !== usage.amountApplied) {
      await tx.sponsorshipUsage.update({
        where: { id: usage.id },
        data: { amountApplied },
      });
    }
  }

  sponsorshipAmount = Math.min(sponsorshipAmount, priceBreakdown.subtotal);
  const updatedBreakdown = {
    ...priceBreakdown,
    sponsorshipTotal: sponsorshipAmount,
    total: Math.max(0, priceBreakdown.subtotal - sponsorshipAmount),
  };

  const result: {
    priceBreakdown: PriceBreakdown;
    sponsorshipAmount: number;
    paymentStatus?: "PENDING" | "PARTIAL" | "SPONSORED";
    paidAt?: Date | null;
    coveredAccessIds: Set<string>;
  } = {
    priceBreakdown: updatedBreakdown,
    sponsorshipAmount,
    coveredAccessIds,
  };

  if (
    registration.paymentStatus === "PAID" ||
    registration.paymentStatus === "WAIVED" ||
    registration.paymentStatus === "REFUNDED"
  ) {
    return result;
  }

  if (
    sponsorshipAmount >= priceBreakdown.subtotal &&
    priceBreakdown.subtotal > 0
  ) {
    result.paymentStatus = "SPONSORED";
    result.paidAt = registration.paidAt ?? new Date();
  } else if (sponsorshipAmount > 0) {
    result.paymentStatus = "PARTIAL";
    result.paidAt = null;
  } else if (
    registration.paymentStatus === "SPONSORED" ||
    registration.paymentStatus === "PARTIAL"
  ) {
    result.paymentStatus = "PENDING";
    result.paidAt = null;
  }

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a human-readable sequential reference number.
 * Format: {YY}-{SLUG}-{SEQ} (e.g. 26-AMGLS-001)
 * Must be called inside a transaction to avoid race conditions.
 */
async function generateReferenceNumber(
  eventId: string,
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
): Promise<string> {
  const event = await tx.event.findUnique({
    where: { id: eventId },
    select: { slug: true, startDate: true },
  });
  if (!event) return `REG-${Date.now().toString(36).toUpperCase()}`;

  const year = event.startDate.getFullYear().toString().slice(-2);
  // Use slug directly — replace dots/underscores with dashes, uppercase, truncate
  const code = event.slug.replace(/[._]/g, "-").toUpperCase().slice(0, 12);
  const prefix = `${year}-${code}-`;

  // Lock matching rows first, then compute MAX in a subquery.
  // CockroachDB disallows FOR UPDATE with aggregate functions,
  // so we split it: lock rows, then aggregate.
  const result = await tx.$queryRawUnsafe<[{ max_ref: string | null }]>(
    `SELECT MAX("reference_number") as max_ref FROM (SELECT "reference_number" FROM "registrations" WHERE "event_id" = $1 AND "reference_number" LIKE $2 FOR UPDATE) locked`,
    eventId,
    `${prefix}%`,
  );

  let nextSeq = 1;
  const maxRef = result[0]?.max_ref;
  if (maxRef) {
    const lastSeq = parseInt(maxRef.slice(prefix.length), 10);
    if (!isNaN(lastSeq)) nextSeq = lastSeq + 1;
  }

  return `${prefix}${String(nextSeq).padStart(3, "0")}`;
}

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
    email: rawEmail,
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
  const email = normalizeEmail(rawEmail);

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
  const existingRegistration = await prisma.registration.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, formId },
  });
  if (existingRegistration) {
    throw new AppError(
      "A registration with this email already exists for this form",
      409,
      ErrorCodes.REGISTRATION_ALREADY_EXISTS,
    );
  }

  // Advisory check only — settlement-time incrementPaidCount inside the tx is the authoritative capacity gate
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
  const pending: RegistrationPostCommitEvent[] = [];
  const result = await prisma.$transaction(async (tx) => {
    // Re-check event status inside transaction to prevent TOCTOU race condition
    // Event might have been closed between initial check and transaction start
    const event = await tx.event.findUnique({
      where: { id: eventId },
      select: {
        status: true,
        endDate: true,
        maxCapacity: true,
        registeredCount: true,
        client: { select: { enabledModules: true } },
      },
    });

    if (!event) {
      throw new AppError(
        "Event is not accepting registrations",
        400,
        ErrorCodes.EVENT_NOT_OPEN,
      );
    }
    assertEventAcceptsPublicActions(event);
    assertModuleEnabledForClient(event.client, "registrations");
    assertLabSponsorshipAllowed(event.client, paymentMethod);

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
        referenceNumber: await generateReferenceNumber(eventId, tx),
        paymentStatus: "PENDING",
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
      await Promise.all(
        accessSelections.map((s) =>
          incrementAccessRegisteredCountTx(s.accessId, s.quantity, tx),
        ),
      );
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

    const clientId = createdReg.event?.clientId;
    if (clientId) {
      pending.push({
        type: "registration.created",
        clientId,
        eventId,
        payload: {
          id: createdReg.id,
          email: createdReg.email,
          paymentStatus: createdReg.paymentStatus,
        },
        ts: Date.now(),
      });
      if (accessSelections && accessSelections.length > 0) {
        pending.push({
          type: "eventAccess.countsChanged",
          clientId,
          eventId,
          payload: {
            id: eventId,
            accessIds: accessSelections.map((s) => s.accessId),
          },
          ts: Date.now(),
        });
      }
    }

    await emitRegistrationPostCommitEvents(tx, pending);
    await queueRegistrationCreatedEmail(tx, {
      eventId,
      registration: {
        id: createdReg.id,
        email,
        firstName,
        lastName,
      },
      failureMessage: "Failed to queue confirmation email",
    });

    return enrichWithAccessSelections(createdReg);
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
    email: rawEmail,
    firstName,
    lastName,
    phone,
    formData,
    role,
    accessSelections,
    paymentMethod,
    paymentStatus,
    labName,
    sendEmail,
  } = input;
  const email = normalizeEmail(rawEmail);

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
  const existing = await prisma.registration.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, formId: form.id },
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

  const eventForPricing = await prisma.event.findUnique({
    where: { id: eventId },
    select: { client: { select: { enabledModules: true } } },
  });
  if (!eventForPricing) {
    throw new AppError("Event not found", 404, ErrorCodes.NOT_FOUND);
  }
  assertModuleEnabledForClient(eventForPricing.client, "pricing");

  const calculatedPrice = await calculatePrice(eventId, {
    formData,
    selectedAccessItems,
    sponsorshipCodes: [],
  });

  // calculatePrice already returns PriceBreakdown with the exact stored shape
  const priceBreakdown: PriceBreakdown = calculatedPrice;

  const result = await prisma.$transaction(async (tx) => {
    // Re-check event status and capacity inside the transaction to prevent TOCTOU races.
    // Admin-created registrations still respect capacity limits.
    const event = await tx.event.findUnique({
      where: { id: eventId },
      select: {
        status: true,
        maxCapacity: true,
        registeredCount: true,
        client: { select: { enabledModules: true } },
      },
    });

    if (!event) {
      throw new AppError("Event not found", 404, ErrorCodes.NOT_FOUND);
    }
    // Admin-created registrations are allowed during setup/testing, but never
    // after the event is archived or when the registrations module is disabled.
    assertEventWritable(event);
    assertModuleEnabledForClient(event.client, "registrations");
    assertLabSponsorshipAllowed(event.client, paymentMethod);

    if (
      event.maxCapacity !== null &&
      event.registeredCount >= event.maxCapacity
    ) {
      throw new AppError("Event is at capacity", 409, ErrorCodes.EVENT_FULL);
    }

    // Determine payment status: explicit override > PENDING
    // LAB_SPONSORSHIP no longer auto-sets WAIVED; admin can explicitly set WAIVED for true waivers
    const resolvedPaymentStatus = paymentStatus ?? "PENDING";

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
        referenceNumber: await generateReferenceNumber(eventId, tx),
        role,
        paymentStatus: resolvedPaymentStatus,
        paidAt: FULLY_SETTLED_STATUSES.includes(resolvedPaymentStatus)
          ? new Date()
          : null,
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
      await Promise.all(
        accessSelections.map((s) =>
          incrementAccessRegisteredCountTx(s.accessId, s.quantity, tx),
        ),
      );
    }

    // Sync paid count if admin created with a settled payment status
    if (FULLY_SETTLED_STATUSES.includes(resolvedPaymentStatus)) {
      await syncPaidCount(
        tx,
        {
          eventId,
          accessTypeIds: accessSelections?.map((s) => s.accessId) ?? [],
          priceBreakdown: priceBreakdown as unknown,
        },
        "PENDING",
        resolvedPaymentStatus,
      );
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

    if (sendEmail) {
      await queueRegistrationCreatedEmail(tx, {
        eventId,
        registration: {
          id: createdReg.id,
          email,
          firstName,
          lastName,
        },
        failureMessage: "Failed to queue admin registration confirmation email",
      });
    }

    return enrichWithAccessSelections(createdReg);
  });

  return result;
}

// ============================================================================
// Update Registration (Admin)
// ============================================================================

export async function updateRegistration(
  id: string,
  input: UpdateRegistrationInput,
  performedBy?: string,
): Promise<RegistrationWithRelations> {
  const pending: RegistrationPostCommitEvent[] = [];
  await prisma.$transaction(async (tx) => {
    const registration = await tx.registration.findUnique({
      where: { id },
      include: {
        event: {
          select: {
            clientId: true,
            status: true,
            client: { select: { enabledModules: true } },
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
    assertEventWritable(registration.event);
    assertModuleEnabledForClient(registration.event.client, "registrations");

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
        (input.paymentStatus === "PAID" ||
          input.paymentStatus === "SPONSORED" ||
          input.paymentStatus === "WAIVED") &&
        !registration.paidAt
      ) {
        updateData.paidAt = new Date();
      }
    }
    if (input.paidAmount !== undefined) {
      if (input.paidAmount > registration.totalAmount) {
        throw new AppError(
          "Paid amount cannot exceed registration total",
          400,
          ErrorCodes.BAD_REQUEST,
        );
      }
      updateData.paidAmount = input.paidAmount;
    }
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

    // Sync paid count if payment status changed
    if (
      input.paymentStatus !== undefined &&
      input.paymentStatus !== registration.paymentStatus
    ) {
      await syncPaidCount(
        tx,
        registration,
        registration.paymentStatus,
        input.paymentStatus,
      );
    }

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

    // Accumulate realtime events (emitted post-commit)
    const clientId = registration.event?.clientId;
    const eventId = registration.eventId;
    const statusChanged =
      input.paymentStatus !== undefined &&
      input.paymentStatus !== registration.paymentStatus;
    const becameSettled =
      statusChanged &&
      (input.paymentStatus === "PAID" ||
        input.paymentStatus === "SPONSORED" ||
        input.paymentStatus === "WAIVED") &&
      !FULLY_SETTLED_STATUSES.includes(registration.paymentStatus);
    if (clientId) {
      pending.push({
        type: becameSettled
          ? "registration.paymentConfirmed"
          : "registration.updated",
        clientId,
        eventId,
        payload: {
          id,
          paymentStatus: input.paymentStatus ?? registration.paymentStatus,
        },
        ts: Date.now(),
      });
      if (statusChanged) {
        pending.push({
          type: "eventAccess.countsChanged",
          clientId,
          eventId,
          payload: { id: eventId, accessIds: [] },
          ts: Date.now(),
        });
      }
    }
    await emitRegistrationPostCommitEvents(tx, pending);
  });

  const updated = await getRegistrationById(id);
  if (!updated) {
    throw new AppError(
      "Registration not found after update",
      404,
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );
  }
  return updated;
}

// ============================================================================
// Admin Edit Registration (Full override — no restrictions)
// ============================================================================

export async function adminEditRegistration(
  eventId: string,
  id: string,
  input: AdminEditRegistrationInput,
  adminUserId: string,
): Promise<RegistrationWithRelations> {
  const pending: RegistrationPostCommitEvent[] = [];
  await prisma.$transaction(async (tx) => {
    const registration = await tx.registration.findUnique({
      where: { id },
      include: {
        event: {
          select: {
            clientId: true,
            status: true,
            client: { select: { enabledModules: true } },
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
    if (registration.eventId !== eventId) {
      throw new AppError(
        "Registration does not belong to this event",
        400,
        ErrorCodes.BAD_REQUEST,
      );
    }
    assertEventWritable(registration.event);
    assertModuleEnabledForClient(registration.event.client, "registrations");

    const updateData: Prisma.RegistrationUpdateInput = {};
    const changes: Record<string, { old: unknown; new: unknown }> = {};

    // ── Personal info ──────────────────────────────────────────
    const inputEmail =
      input.email !== undefined ? normalizeEmail(input.email) : undefined;
    if (inputEmail !== undefined && inputEmail !== registration.email) {
      const duplicate = await tx.registration.findFirst({
        where: {
          email: { equals: inputEmail, mode: "insensitive" },
          formId: registration.formId,
          id: { not: id },
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new AppError(
          "A registration with this email already exists for this form",
          409,
          ErrorCodes.REGISTRATION_ALREADY_EXISTS,
        );
      }
      updateData.email = inputEmail;
      changes.email = { old: registration.email, new: inputEmail };
    }
    if (
      input.firstName !== undefined &&
      input.firstName !== registration.firstName
    ) {
      updateData.firstName = input.firstName;
      changes.firstName = { old: registration.firstName, new: input.firstName };
    }
    if (
      input.lastName !== undefined &&
      input.lastName !== registration.lastName
    ) {
      updateData.lastName = input.lastName;
      changes.lastName = { old: registration.lastName, new: input.lastName };
    }
    if (input.phone !== undefined && input.phone !== registration.phone) {
      updateData.phone = input.phone;
      changes.phone = { old: registration.phone, new: input.phone };
    }

    // ── Form data ──────────────────────────────────────────────
    if (input.formData !== undefined) {
      updateData.formData = input.formData as Prisma.InputJsonValue;
      changes.formData = { old: "(previous)", new: "(updated)" };
    }

    // ── Role ───────────────────────────────────────────────────
    if (input.role !== undefined && input.role !== registration.role) {
      updateData.role = input.role;
      changes.role = { old: registration.role, new: input.role };
    }

    // ── Note ───────────────────────────────────────────────────
    if (input.note !== undefined && input.note !== registration.note) {
      updateData.note = input.note;
      changes.note = { old: registration.note, new: input.note };
    }

    // ── Payment fields ─────────────────────────────────────────
    if (
      input.paymentStatus !== undefined &&
      input.paymentStatus !== registration.paymentStatus
    ) {
      // No transition validation — admin override
      updateData.paymentStatus = input.paymentStatus;
      changes.paymentStatus = {
        old: registration.paymentStatus,
        new: input.paymentStatus,
      };
      if (
        (input.paymentStatus === "PAID" ||
          input.paymentStatus === "SPONSORED" ||
          input.paymentStatus === "WAIVED") &&
        !registration.paidAt
      ) {
        updateData.paidAt = new Date();
      }
    }
    if (
      input.paidAmount !== undefined &&
      input.paidAmount !== registration.paidAmount
    ) {
      if (input.paidAmount > registration.totalAmount) {
        throw new AppError(
          "Paid amount cannot exceed registration total",
          400,
          ErrorCodes.BAD_REQUEST,
        );
      }
      updateData.paidAmount = input.paidAmount;
      changes.paidAmount = {
        old: registration.paidAmount,
        new: input.paidAmount,
      };
    }
    if (
      input.paymentMethod !== undefined &&
      input.paymentMethod !== registration.paymentMethod
    ) {
      updateData.paymentMethod = input.paymentMethod;
      changes.paymentMethod = {
        old: registration.paymentMethod,
        new: input.paymentMethod,
      };
    }
    if (input.paymentReference !== undefined) {
      updateData.paymentReference = input.paymentReference;
    }
    if (input.paymentProofUrl !== undefined) {
      updateData.paymentProofUrl = input.paymentProofUrl;
    }
    if (input.labName !== undefined) {
      updateData.labName = input.labName;
    }

    // ── Price-affecting edits (form data and/or access selections) ────────
    if (input.accessSelections !== undefined || input.formData !== undefined) {
      assertModuleEnabledForClient(registration.event.client, "pricing");
      const effectiveFormData =
        input.formData ??
        (registration.formData as Record<string, unknown>) ??
        {};
      const oldBreakdown = registration.priceBreakdown as Record<
        string,
        unknown
      > | null;
      const oldAccessItems = (oldBreakdown?.accessItems ?? []) as Array<{
        accessId: string;
        quantity: number;
      }>;
      const effectiveAccessSelections =
        input.accessSelections ??
        oldAccessItems.map((item) => ({
          accessId: item.accessId,
          quantity: item.quantity,
        }));
      const selectedAccessItems = effectiveAccessSelections.map((s) => ({
        accessId: s.accessId,
        quantity: s.quantity,
      }));

      // Grandfather already-attached accesses past capacity / active / date-window
      // checks — admin edits keep paid items even if they're now full or disabled
      const existingAccessIds = new Set(
        (registration.accessTypeIds as string[]) ?? [],
      );

      if (
        input.accessSelections !== undefined &&
        effectiveAccessSelections.length > 0
      ) {
        const validation = await validateAccessSelections(
          eventId,
          effectiveAccessSelections,
          effectiveFormData,
          existingAccessIds,
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

      // Recalculate pricing
      const existingSponsorshipCodes: string[] = registration.sponsorshipCode
        ? [registration.sponsorshipCode]
        : [];
      let priceBreakdown = await calculatePrice(eventId, {
        formData: effectiveFormData,
        selectedAccessItems,
        sponsorshipCodes: existingSponsorshipCodes,
      });

      // Release old access spots
      const oldAccessTypeIds = (registration.accessTypeIds as string[]) ?? [];
      if (input.accessSelections !== undefined) {
        await Promise.all(
          oldAccessItems.map((old) =>
            decrementAccessRegisteredCountTx(old.accessId, old.quantity, tx),
          ),
        );

        // Reserve new access spots
        await Promise.all(
          effectiveAccessSelections
            .filter((sel) => sel.quantity > 0)
            .map((sel) =>
              incrementAccessRegisteredCountTx(sel.accessId, sel.quantity, tx),
            ),
        );
      }

      const settlement = await recalculateLinkedSponsorshipSettlement(
        tx,
        registration,
        priceBreakdown,
      );
      priceBreakdown = settlement.priceBreakdown;

      const nextPaymentStatus =
        input.paymentStatus ?? settlement.paymentStatus ?? registration.paymentStatus;
      const nextPaidAmount = input.paidAmount ?? registration.paidAmount;
      if (nextPaidAmount > priceBreakdown.total) {
        throw new AppError(
          "Paid amount cannot exceed registration total",
          400,
          ErrorCodes.BAD_REQUEST,
        );
      }

      // Update denormalized price fields
      updateData.totalAmount = priceBreakdown.total;
      updateData.baseAmount = priceBreakdown.calculatedBasePrice;
      updateData.accessAmount = priceBreakdown.accessTotal;
      updateData.discountAmount = calculateDiscountAmount(
        priceBreakdown.appliedRules,
      );
      updateData.sponsorshipAmount = settlement.sponsorshipAmount;
      updateData.accessTypeIds = effectiveAccessSelections.map(
        (s) => s.accessId,
      );
      updateData.priceBreakdown =
        priceBreakdown as unknown as Prisma.InputJsonValue;
      if (
        input.paymentStatus === undefined &&
        settlement.paymentStatus !== undefined &&
        settlement.paymentStatus !== registration.paymentStatus
      ) {
        updateData.paymentStatus = settlement.paymentStatus;
        changes.paymentStatus = {
          old: registration.paymentStatus,
          new: settlement.paymentStatus,
        };
      }
      if (input.paymentStatus === undefined && settlement.paidAt !== undefined) {
        updateData.paidAt = settlement.paidAt;
      }

      if (input.accessSelections !== undefined) {
        changes.accessSelections = {
          old: oldAccessTypeIds,
          new: effectiveAccessSelections.map((s) => s.accessId),
        };
      }
      changes.totalAmount = {
        old: registration.totalAmount,
        new: priceBreakdown.total,
      };

      if (
        input.accessSelections !== undefined ||
        nextPaymentStatus !== registration.paymentStatus
      ) {
        await syncPaidCountForAccessEdit(
          tx,
          eventId,
          registration.paymentStatus,
          registration.priceBreakdown,
          nextPaymentStatus,
          priceBreakdown,
          settlement.coveredAccessIds,
        );
      }
    }

    updateData.lastEditedAt = new Date();

    await tx.registration.update({ where: { id }, data: updateData });

    // Sync paid count if payment status changed (admin override)
    // Use updated values if access selections were changed in this edit
    if (
      input.paymentStatus !== undefined &&
      input.paymentStatus !== registration.paymentStatus &&
      input.accessSelections === undefined &&
      input.formData === undefined
    ) {
      const effectiveAccessTypeIds =
        (updateData.accessTypeIds as string[] | undefined) ??
        registration.accessTypeIds;
      const effectivePriceBreakdown =
        (updateData.priceBreakdown as unknown) ?? registration.priceBreakdown;

      await syncPaidCount(
        tx,
        {
          eventId,
          accessTypeIds: effectiveAccessTypeIds,
          priceBreakdown: effectivePriceBreakdown,
        },
        registration.paymentStatus,
        input.paymentStatus,
      );
    }

    if (Object.keys(changes).length > 0) {
      await auditLog(tx, {
        entityType: "Registration",
        entityId: id,
        action: "UPDATE",
        changes,
        performedBy: adminUserId,
      });
    }

    // Accumulate realtime events
    const clientId = registration.event?.clientId;
    const statusChanged =
      input.paymentStatus !== undefined &&
      input.paymentStatus !== registration.paymentStatus;
    const becameSettled =
      statusChanged &&
      (input.paymentStatus === "PAID" ||
        input.paymentStatus === "SPONSORED" ||
        input.paymentStatus === "WAIVED") &&
      !FULLY_SETTLED_STATUSES.includes(registration.paymentStatus);
    if (clientId) {
      pending.push({
        type: becameSettled
          ? "registration.paymentConfirmed"
          : "registration.updated",
        clientId,
        eventId,
        payload: {
          id,
          paymentStatus: input.paymentStatus ?? registration.paymentStatus,
        },
        ts: Date.now(),
      });
      if (
        statusChanged ||
        (input.accessSelections && input.accessSelections.length > 0)
      ) {
        pending.push({
          type: "eventAccess.countsChanged",
          clientId,
          eventId,
          payload: { id: eventId, accessIds: [] },
          ts: Date.now(),
        });
      }
    }
    await emitRegistrationPostCommitEvents(tx, pending);
  });

  const updated = await getRegistrationById(id);
  if (!updated) {
    throw new AppError(
      "Registration not found after update",
      404,
      ErrorCodes.REGISTRATION_NOT_FOUND,
    );
  }
  return updated;
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
  // Force-delete requires admin role (fast check before DB access)
  if (
    force &&
    requestingUserRole !== UserRole.CLIENT_ADMIN &&
    requestingUserRole !== UserRole.SUPER_ADMIN
  ) {
    throw new AppError(
      "Only admins can force-delete registrations",
      403,
      ErrorCodes.FORBIDDEN,
    );
  }

  const pending: RegistrationPostCommitEvent[] = [];
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
        event: {
          select: {
            clientId: true,
            status: true,
            client: { select: { enabledModules: true } },
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
    assertEventWritable(registration.event);
    assertModuleEnabledForClient(registration.event.client, "registrations");

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

    // Clean up sponsorship usages linked to this registration
    const usages = await tx.sponsorshipUsage.findMany({
      where: { registrationId: id },
      select: { id: true, sponsorshipId: true },
    });

    if (usages.length > 0) {
      // Delete all usages for this registration
      await tx.sponsorshipUsage.deleteMany({
        where: { registrationId: id },
      });

      // Recalculate status for each affected sponsorship
      const sponsorshipIds = [...new Set(usages.map((u) => u.sponsorshipId))];
      for (const sponsorshipId of sponsorshipIds) {
        const remainingCount = await tx.sponsorshipUsage.count({
          where: { sponsorshipId },
        });
        await tx.sponsorship.update({
          where: { id: sponsorshipId },
          data: { status: remainingCount > 0 ? "USED" : "PENDING" },
        });
      }
    }

    // Release access spots (get from priceBreakdown)
    // Pass tx so release is rolled back if the transaction fails
    const priceBreakdown = registration.priceBreakdown as PriceBreakdown;
    if (priceBreakdown.accessItems) {
      await Promise.all(
        priceBreakdown.accessItems.map((item) =>
          decrementAccessRegisteredCountTx(item.accessId, item.quantity, tx),
        ),
      );
    }

    // Decrement paid count if registration was settled
    if (FULLY_SETTLED_STATUSES.includes(registration.paymentStatus)) {
      if (priceBreakdown.accessItems) {
        for (const item of priceBreakdown.accessItems) {
          await decrementPaidCount(item.accessId, item.quantity, tx);
        }
      }
    }

    // Decrement event registered count (atomic SQL within transaction)
    await decrementRegisteredCountTx(tx, registration.eventId);

    // Delete the registration
    await tx.registration.delete({ where: { id } });

    const clientId = registration.event?.clientId;
    const accessIds = priceBreakdown.accessItems?.map((a) => a.accessId) ?? [];
    if (clientId) {
      pending.push({
        type: "registration.deleted",
        clientId,
        eventId: registration.eventId,
        payload: { id: registration.id, email: registration.email },
        ts: Date.now(),
      });
      pending.push({
        type: "eventAccess.countsChanged",
        clientId,
        eventId: registration.eventId,
        payload: { id: registration.eventId, accessIds },
        ts: Date.now(),
      });
    }
    await emitRegistrationPostCommitEvents(tx, pending);
  });
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
    endDate: Date;
  };
};

export type GetRegistrationForEditResult = {
  registration: RegistrationForEdit;
  expectedUpdatedAt: string;
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
          endDate: true,
          client: { select: { enabledModules: true } },
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
  if (
    registration.event.status !== "OPEN" ||
    registration.event.endDate < new Date()
  ) {
    canEdit = false;
    canEditPersonalInfo = false;
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    restrictions.push("Event is not accepting changes");
  }

  if (!registration.event.client.enabledModules.includes("registrations")) {
    canEdit = false;
    canEditPersonalInfo = false;
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    restrictions.push("Registrations are disabled for this event");
  }

  if (!registration.event.client.enabledModules.includes("pricing")) {
    canEdit = false;
    canEditPersonalInfo = false;
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    restrictions.push("Pricing is disabled for this event");
  }

  // VERIFYING → block access edits only (personal info stays editable)
  if (registration.paymentStatus === "VERIFYING") {
    canEditAccess = false;
    canAddAccess = false;
    canRemoveAccess = false;
    restrictions.push("Payment proof is under review");
  }

  // PAID/SPONSORED or paidAmount > 0 → cannot remove access (can still add)
  const isPaid =
    registration.paymentStatus === "PAID" ||
    registration.paymentStatus === "SPONSORED" ||
    registration.paidAmount > 0;
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

  // Compute amount due (includes both paidAmount and sponsorshipAmount)
  const { amountDue } = calculateSettlement({
    totalAmount: registration.totalAmount,
    paidAmount: registration.paidAmount,
    sponsorshipAmount: registration.sponsorshipAmount,
  });
  const publicEvent = {
    id: registration.event.id,
    name: registration.event.name,
    slug: registration.event.slug,
    clientId: registration.event.clientId,
    status: registration.event.status,
    endDate: registration.event.endDate,
  };
  const enrichedRegistration = {
    ...registration,
    event: publicEvent,
    accessSelections,
  };

  return {
    registration: enrichedRegistration as RegistrationForEdit,
    expectedUpdatedAt: registration.updatedAt.toISOString(),
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
  const expectedUpdatedAt = new Date(input.expectedUpdatedAt);
  if (Number.isNaN(expectedUpdatedAt.getTime())) {
    throw new AppError(
      "Invalid expectedUpdatedAt precondition",
      400,
      ErrorCodes.VALIDATION_ERROR,
    );
  }

  let newPriceBreakdown!: PriceBreakdown;

  await prisma.$transaction(async (tx) => {
    const currentRegistration = await tx.registration.findUnique({
      where: { id: registrationId },
      select: {
        id: true,
        eventId: true,
        formData: true,
        priceBreakdown: true,
        accessTypeIds: true,
        paymentStatus: true,
        paidAmount: true,
        totalAmount: true,
        sponsorshipAmount: true,
        sponsorshipCode: true,
        firstName: true,
        lastName: true,
        phone: true,
        updatedAt: true,
        form: { select: { id: true, eventId: true, schema: true } },
        event: {
          select: {
            id: true,
            status: true,
            endDate: true,
            client: { select: { enabledModules: true } },
          },
        },
      },
    });

    if (!currentRegistration) {
      throw new AppError(
        "Registration not found",
        404,
        ErrorCodes.REGISTRATION_NOT_FOUND,
      );
    }

    if (currentRegistration.paymentStatus === "REFUNDED") {
      throw new AppError(
        "Refunded registrations cannot be edited",
        400,
        ErrorCodes.REGISTRATION_REFUNDED,
      );
    }

    try {
      assertEventAcceptsPublicActions(currentRegistration.event);
    } catch {
      throw new AppError(
        "Event is not accepting changes",
        400,
        ErrorCodes.REGISTRATION_EDIT_FORBIDDEN,
      );
    }

    assertModuleEnabledForClient(
      currentRegistration.event.client,
      "registrations",
    );
    assertModuleEnabledForClient(currentRegistration.event.client, "pricing");

    const isAccessEdit = input.accessSelections !== undefined;

    if (currentRegistration.paymentStatus === "VERIFYING" && isAccessEdit) {
      throw new AppError(
        "Cannot modify access while payment is under review",
        400,
        ErrorCodes.REGISTRATION_VERIFYING_BLOCKED,
      );
    }

    if (currentRegistration.paymentStatus === "WAIVED" && isAccessEdit) {
      throw new AppError(
        "Waived registrations cannot modify access selections",
        400,
        ErrorCodes.REGISTRATION_WAIVED_ACCESS_BLOCKED,
      );
    }

    if (
      currentRegistration.sponsorshipAmount >=
        currentRegistration.totalAmount &&
      currentRegistration.totalAmount > 0 &&
      isAccessEdit
    ) {
      throw new AppError(
        "Fully sponsored registrations cannot modify access selections",
        400,
        ErrorCodes.REGISTRATION_FULLY_SPONSORED_BLOCKED,
      );
    }

    const currentFormData =
      (currentRegistration.formData as Record<string, unknown> | null) ?? {};
    let newFormData = input.formData
      ? { ...currentFormData, ...input.formData }
      : currentFormData;

    if (input.formData) {
      const formSchema = currentRegistration.form
        .schema as unknown as FormSchema;
      const validationResult = validateFormData(formSchema, newFormData);
      if (!validationResult.valid) {
        throw new AppError(
          "Form validation failed",
          400,
          ErrorCodes.FORM_VALIDATION_ERROR,
          { fieldErrors: validationResult.errors },
        );
      }
      newFormData = sanitizeFormData(formSchema, newFormData);
    }

    const currentPriceBreakdown =
      (currentRegistration.priceBreakdown as PriceBreakdown | null) ??
      ({ accessItems: [] } as unknown as PriceBreakdown);
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

    const toQuantityMap = (
      items: Array<{ accessId: string; quantity: number }>,
    ) => {
      const quantities = new Map<string, number>();
      for (const item of items) {
        quantities.set(
          item.accessId,
          (quantities.get(item.accessId) ?? 0) + item.quantity,
        );
      }
      return quantities;
    };

    const oldQuantities = toQuantityMap(currentAccessItems);
    const newQuantities = toQuantityMap(newAccessSelections);
    const accessDeltas = Array.from(
      new Set([...oldQuantities.keys(), ...newQuantities.keys()]),
    )
      .map((accessId) => ({
        accessId,
        oldQuantity: oldQuantities.get(accessId) ?? 0,
        newQuantity: newQuantities.get(accessId) ?? 0,
        delta:
          (newQuantities.get(accessId) ?? 0) -
          (oldQuantities.get(accessId) ?? 0),
      }))
      .filter((change) => change.delta !== 0);

    const currentIsPaid =
      currentRegistration.paymentStatus === "PAID" ||
      currentRegistration.paymentStatus === "SPONSORED" ||
      currentRegistration.paidAmount > 0;
    const negativeDeltas = accessDeltas.filter((change) => change.delta < 0);
    if (currentIsPaid && negativeDeltas.length > 0) {
      throw new AppError(
        "Cannot remove access items from a paid registration",
        400,
        ErrorCodes.REGISTRATION_ACCESS_REMOVAL_BLOCKED,
        {
          message: "Paid registrations can only add new access items",
          attemptedRemovals: negativeDeltas.map((change) => change.accessId),
        },
      );
    }

    if (isAccessEdit && accessDeltas.some((change) => change.delta > 0)) {
      const validation = await validateAccessSelections(
        currentRegistration.eventId,
        newAccessSelections,
        newFormData,
        currentAccessIds,
        tx,
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

    newPriceBreakdown = await calculatePrice(
      currentRegistration.eventId,
      {
        formData: newFormData,
        selectedAccessItems: newAccessSelections.map((selection) => ({
          accessId: selection.accessId,
          quantity: selection.quantity,
        })),
        sponsorshipCodes: currentRegistration.sponsorshipCode
          ? [currentRegistration.sponsorshipCode]
          : [],
      },
      tx,
    );

    await Promise.all(
      accessDeltas
        .filter((change) => change.delta > 0)
        .map((change) =>
          incrementAccessRegisteredCountTx(change.accessId, change.delta, tx),
        ),
    );

    if (!currentIsPaid) {
      await Promise.all(
        accessDeltas
          .filter((change) => change.delta < 0)
          .map((change) =>
            decrementAccessRegisteredCountTx(
              change.accessId,
              Math.abs(change.delta),
              tx,
            ),
          ),
      );
    }

    const newTotalAmount = currentIsPaid
      ? Math.max(currentRegistration.totalAmount, newPriceBreakdown.total)
      : newPriceBreakdown.total;

    const updateResult = await tx.registration.updateMany({
      where: { id: registrationId, updatedAt: expectedUpdatedAt },
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
        accessTypeIds: newAccessSelections.map(
          (selection) => selection.accessId,
        ),
        lastEditedAt: new Date(),
      },
    });

    if (updateResult.count === 0) {
      throw new AppError(
        "Registration changed. Refresh and try again.",
        409,
        ErrorCodes.CONCURRENT_MODIFICATION,
      );
    }

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
    if (isAccessEdit && accessDeltas.length > 0) {
      auditChanges.accessSelections = {
        old: currentAccessItems.map((item) => ({
          accessId: item.accessId,
          quantity: item.quantity,
        })),
        new: newAccessSelections.map((selection) => ({
          accessId: selection.accessId,
          quantity: selection.quantity,
        })),
      };
    }

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

  const updatedRegistration = await getRegistrationById(registrationId);

  return {
    registration: updatedRegistration!,
    priceBreakdown: newPriceBreakdown,
  };
}
