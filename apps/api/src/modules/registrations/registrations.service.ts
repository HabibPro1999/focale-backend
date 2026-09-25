import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { fileTypeFromBuffer } from "file-type";
import {
  getStorageProvider,
  compressFile,
  ownedStorageKey,
  buildRegistrationSelfLinks,
} from "@app/integrations";
import { deleteNetworkingPhoto } from "../networking/networking.uploads.service";
import {
  ErrorCodes,
  UserRole,
  type AppEvent,
  type PriceBreakdown,
  type CreateRegistrationInput,
  type AdminCreateRegistrationInput,
  type AdminEditRegistrationInput,
  type UpdateRegistrationInput,
  type UpdatePaymentInput,
  type SelectPaymentMethodInput,
  type PublicEditRegistrationInput,
  type ListRegistrationsQuery,
  type ListRegistrationAuditLogsQuery,
  type ListRegistrationEmailLogsQuery,
  type RegistrationAuditLog,
  type RegistrationEmailLog,
  type RegistrationStats,
  type SearchRegistrantsQuery,
} from "@app/contracts";
import {
  calculateApplicableAmount,
  calculateDiscountAmount,
  calculateSettlement,
  getSkip,
  isFullySettled,
  paginate,
  type PaginatedResult,
} from "@app/shared";
import {
  withTxn,
  syncNetworkingRegistration,
  enqueueTriggeredEmailOutbox,
  applyRegistrationSettlement,
  emitSettlementEvents,
  settlementEventPair,
  casIncrementRegisteredTx,
  casDecrementRegisteredTx,
  getEventCounterInfoTx,
  updateUsageAmount,
  countUsagesForSponsorship,
  updateSponsorshipRow,
  findFormById,
  findActiveRegistrationFormById,
  findAccessDetailsByIds,
  searchRegistrantsForSponsorship as searchRegistrantsQuery,
  pgUniqueViolation,
  type DbExecutor,
  // registrations-owned primitives
  getRegistrationByIdRow,
  getRegistrationByIdempotencyKeyRow,
  getRegistrationClientId as getRegistrationClientIdQuery,
  getRegistrationEditToken,
  getRegistrationEditLinkSource,
  listRegistrationRows,
  getEventForRegistrationCreate,
  getEventForRegistrationAdmin,
  findRegistrationFormForEvent,
  getRegistrationFormSchemaForEvent,
  registrationExistsByEmailForm,
  findRegistrationForMutation,
  findRegistrationWithFormEvent,
  insertRegistrationRow,
  deleteRegistrationRow,
  getNetworkingProfilePhotoByRegistration,
  findRegistrationUsagesForRecalc,
  findRegistrationUsageLinks,
  deleteRegistrationUsages,
  allocateReferenceNumber,
  insertAuditLog,
  listRegistrationAuditLogRows,
  findUserNamesByIds,
  listRegistrationEmailLogRows,
  type RegistrationFieldsPatch,
  type RegistrationPaymentStatus,
  type RegistrationSettlementWrite,
} from "@app/db";
import { AccessService } from "../access/access.service";
import { PricingService } from "../pricing/pricing.service";
import { prepareFormDataForPricing } from "../pricing/form-data-for-pricing";
import {
  assertEventAcceptsPublicActions,
  assertEventWritable,
} from "../events";
import {
  assertClientModuleEnabled,
  assertModuleEnabledForClient,
  isModuleEnabledForClient,
  type ClientModuleState,
} from "../clients/module-gates";
import { AppException } from "../../core/app-exception";
import { CONFIG, type Config } from "../../core/config";
import { assertPublicLinkBaseUrlAllowed } from "../../core/public-link-origin";
import { logger } from "../../core/logger.service";
import { validatePaymentTransition } from "./payment-transitions";
import { getRegistrationTableColumns } from "./table-columns";
import {
  enrichWithAccessSelections,
  enrichManyWithAccessSelections,
  type RegistrationWithRelations,
} from "./registrations.enrichment";
import {
  toAdminRegistration,
  toPublicRegistration,
  type AdminView,
  type PublicRegistration,
} from "./registrations.mappers";

/** Admin-facing registration: no editToken / idempotencyKey (see mappers). */
export type AdminRegistration = AdminView<RegistrationWithRelations>;

const EDIT_TOKEN_BYTES = 32; // 64 hex characters

function generateEditToken(): string {
  return randomBytes(EDIT_TOKEN_BYTES).toString("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

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

function pgUnique(err: unknown): { isUnique: boolean; constraint: string } {
  const v = pgUniqueViolation(err);
  return { isUnique: v !== null, constraint: v?.constraint ?? "" };
}

/**
 * Reproduce the legacy global P2002 mapping (the target core filter does not yet
 * carry it): email+form unique violation → REGISTRATION_ALREADY_EXISTS, any other
 * unique violation → RES_3002. Idempotency-key violations are RE-THROWN untouched
 * so the public-create idempotency-race recovery can still catch them.
 */
function translateCreateUniqueViolation(err: unknown): never {
  const { isUnique, constraint } = pgUnique(err);
  if (!isUnique || /idempotency/i.test(constraint)) throw err;
  if (/email/i.test(constraint) || constraint === "registrations_email_form_id_key") {
    throw new AppException(
      ErrorCodes.REGISTRATION_ALREADY_EXISTS,
      "A registration with this email already exists for this form",
      409,
    );
  }
  throw new AppException(ErrorCodes.CONFLICT, "Resource already exists", 409);
}

interface RecalcInput {
  id: string;
  paymentStatus: string;
  paidAt: Date | null;
  paidAmount: number;
}

interface SettlementResult {
  priceBreakdown: PriceBreakdown;
  sponsorshipAmount: number;
  paymentStatus?: "PENDING" | "PARTIAL" | "SPONSORED" | "PAID";
  paidAt?: Date | null;
  coveredAccessIds: Set<string>;
}

export type GetRegistrationForEditResult = {
  registration: PublicRegistration;
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

export type EditRegistrationPublicResult = {
  registration: PublicRegistration;
  priceBreakdown: PriceBreakdown;
};

export type PublicCreateResult = {
  created: boolean;
  registration: PublicRegistration;
  priceBreakdown: PriceBreakdown;
};

@Injectable()
export class RegistrationsService {
  constructor(
    private readonly access: AccessService,
    private readonly pricing: PricingService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  // ==========================================================================
  // Shared side-effect + settlement helpers
  // ==========================================================================

  private async queueRegistrationCreatedEmail(
    exec: DbExecutor,
    eventId: string,
    registration: {
      id: string;
      email: string;
      firstName?: string | null;
      lastName?: string | null;
    },
  ): Promise<boolean> {
    await syncNetworkingRegistration(registration.id, exec);
    return enqueueTriggeredEmailOutbox(
      exec,
      {
        trigger: "REGISTRATION_CREATED",
        eventId,
        registration: {
          id: registration.id,
          email: registration.email,
          firstName: registration.firstName ?? null,
          lastName: registration.lastName ?? null,
        },
      },
      `email:triggered:REGISTRATION_CREATED:${registration.id}`,
    );
  }

  private assertLabSponsorshipAllowed(
    client: { enabledModules: string[] | null },
    paymentMethod: string | null | undefined,
  ): void {
    if (
      paymentMethod === "LAB_SPONSORSHIP" &&
      (client.enabledModules ?? []).includes("sponsorships")
    ) {
      throw new AppException(
        ErrorCodes.BAD_REQUEST,
        "Lab sponsorship payment method is only available when sponsorships are disabled",
        400,
      );
    }
  }

  private async syncPaidCount(
    exec: DbExecutor,
    registration: { id: string; eventId: string; priceBreakdown: unknown },
    oldStatus: string,
    newStatus: string,
  ): Promise<void> {
    const coveredAccessIds =
      oldStatus === "PARTIAL" || newStatus === "PARTIAL"
        ? await this.access.getAlreadyCoveredAccessIds(registration.id, exec)
        : new Set<string>();
    await this.access.syncPaidCountDelta(
      registration.eventId,
      { status: oldStatus, priceBreakdown: registration.priceBreakdown, coveredAccessIds },
      { status: newStatus, priceBreakdown: registration.priceBreakdown, coveredAccessIds },
      exec,
    );
  }

  private async recalculateLinkedSponsorshipSettlement(
    exec: DbExecutor,
    registration: RecalcInput,
    priceBreakdown: PriceBreakdown,
    totalAmount = priceBreakdown.subtotal,
  ): Promise<SettlementResult> {
    const usages = await findRegistrationUsagesForRecalc(registration.id, exec);
    const accessTypeIds = priceBreakdown.accessItems.map((i) => i.accessId);
    const coveredAccessIds = new Set<string>();
    let sponsorshipAmount = 0;

    if (usages.length === 0) sponsorshipAmount = priceBreakdown.sponsorshipTotal;

    for (const usage of usages) {
      for (const accessId of usage.sponsorship.coveredAccessIds) {
        coveredAccessIds.add(accessId);
      }
      const amountApplied = calculateApplicableAmount(usage.sponsorship, {
        totalAmount: priceBreakdown.subtotal,
        baseAmount: priceBreakdown.calculatedBasePrice,
        accessTypeIds,
        priceBreakdown,
      });
      sponsorshipAmount += amountApplied;
      if (amountApplied !== usage.amountApplied) {
        await updateUsageAmount(exec, usage.id, amountApplied);
      }
    }

    sponsorshipAmount = Math.min(sponsorshipAmount, priceBreakdown.subtotal);
    const updatedBreakdown: PriceBreakdown = {
      ...priceBreakdown,
      sponsorshipTotal: sponsorshipAmount,
      total: Math.max(0, priceBreakdown.subtotal - sponsorshipAmount),
    };

    const result: SettlementResult = {
      priceBreakdown: updatedBreakdown,
      sponsorshipAmount,
      coveredAccessIds,
    };

    if (
      registration.paymentStatus === "WAIVED" ||
      registration.paymentStatus === "REFUNDED" ||
      registration.paymentStatus === "PAID" ||
      registration.paymentStatus === "VERIFYING"
    ) {
      return result;
    }

    const settlement = calculateSettlement({
      totalAmount,
      paidAmount: registration.paidAmount,
      sponsorshipAmount,
    });
    if (sponsorshipAmount >= totalAmount && totalAmount > 0) {
      result.paymentStatus = "SPONSORED";
    } else if (
      settlement.isSettled &&
      (registration.paidAmount > 0 || registration.paymentStatus === "PAID")
    ) {
      result.paymentStatus = "PAID";
    } else if (registration.paymentStatus !== "VERIFYING") {
      result.paymentStatus = settlement.isPartiallyPaid ? "PARTIAL" : "PENDING";
    }
    if (result.paymentStatus !== undefined) {
      result.paidAt =
        result.paymentStatus === "PAID" || result.paymentStatus === "SPONSORED"
          ? registration.paidAt ?? new Date()
          : null;
    }
    return result;
  }

  /** Atomic event registered-count increment; mirrors legacy incrementRegisteredCountTx. */
  private async incrementEventRegistered(
    exec: DbExecutor,
    eventId: string,
  ): Promise<void> {
    if (await casIncrementRegisteredTx(exec, eventId)) return;
    const info = await getEventCounterInfoTx(exec, eventId);
    if (!info) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    if (info.status !== "OPEN") {
      throw new AppException(
        ErrorCodes.EVENT_NOT_OPEN,
        "Event is not accepting public actions",
        400,
      );
    }
    throw new AppException(ErrorCodes.EVENT_FULL, "Event is at capacity", 409);
  }

  private async decrementEventRegistered(
    exec: DbExecutor,
    eventId: string,
  ): Promise<void> {
    if (await casDecrementRegisteredTx(exec, eventId)) return;
    const info = await getEventCounterInfoTx(exec, eventId);
    if (!info) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    throw new AppException(
      ErrorCodes.VALIDATION_ERROR,
      "Event registered count is already zero",
      400,
    );
  }

  private audit(
    exec: DbExecutor,
    entry: {
      entityId: string;
      action: string;
      changes: Record<string, { old: unknown; new: unknown }>;
      performedBy?: string | null;
    },
  ): Promise<void> {
    return insertAuditLog(
      {
        entityType: "Registration",
        entityId: entry.entityId,
        action: entry.action,
        changes: entry.changes,
        performedBy: entry.performedBy ?? null,
      },
      exec,
    );
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  async getRegistrationById(id: string): Promise<AdminRegistration | null> {
    const row = await getRegistrationByIdRow(id);
    if (!row) return null;
    return toAdminRegistration(await enrichWithAccessSelections(row));
  }

  /** editToken intentionally NOT stripped (renamed to `token` by the create route). */
  async getRegistrationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<RegistrationWithRelations | null> {
    const row = await getRegistrationByIdempotencyKeyRow(idempotencyKey);
    if (!row) return null;
    return enrichWithAccessSelections(row);
  }

  getRegistrationClientId(id: string): Promise<string | null> {
    return getRegistrationClientIdQuery(id);
  }

  getRegistrationTableColumns(eventId: string) {
    return getRegistrationTableColumns(eventId);
  }

  searchRegistrantsForSponsorship(eventId: string, query: SearchRegistrantsQuery) {
    return searchRegistrantsQuery(eventId, query);
  }

  async listRegistrations(
    eventId: string,
    query: ListRegistrationsQuery,
  ): Promise<PaginatedResult<AdminView<RegistrationWithRelations>> & { stats: RegistrationStats }> {
    const { rows, total, stats: statsRaw } = await listRegistrationRows(
      eventId,
      query,
    );

    const stats: RegistrationStats = {
      total: 0,
      totalAmount: 0,
      paid: { count: 0, amount: 0 },
      pending: { count: 0, amount: 0 },
      sponsored: { count: 0, amount: 0 },
    };
    for (const row of statsRaw) {
      const count = row.cnt;
      const amount = row.totalAmount;
      stats.total += count;
      stats.totalAmount += amount;
      if (row.paymentStatus === "PAID") {
        stats.paid = { count, amount: row.paidAmount };
      } else if (
        row.paymentStatus === "PENDING" ||
        row.paymentStatus === "VERIFYING" ||
        row.paymentStatus === "PARTIAL"
      ) {
        stats.pending.count += count;
        stats.pending.amount += amount;
      } else if (
        row.paymentStatus === "SPONSORED" ||
        row.paymentStatus === "WAIVED"
      ) {
        stats.sponsored.count += count;
        stats.sponsored.amount += amount;
      }
    }

    // The query selects admin columns only; the mapper keeps that true for
    // any future change to the row source.
    const enriched = (await enrichManyWithAccessSelections(rows)).map(toAdminRegistration);
    const { page, limit } = query;
    return { ...paginate(enriched, total, { page, limit }), stats };
  }

  // ==========================================================================
  // Edit-token verification (timing-safe, no expiry)
  // ==========================================================================

  async verifyEditToken(registrationId: string, token: string): Promise<boolean> {
    const row = await getRegistrationEditToken(registrationId);
    if (!row?.editToken) return false;
    try {
      return timingSafeEqual(
        Buffer.from(row.editToken, "utf8"),
        Buffer.from(token, "utf8"),
      );
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Public create
  // ==========================================================================

  /**
   * Full public-create orchestration (idempotency short-circuit, form gate,
   * module gates, form-data validation, price calc, create with P2002 recovery).
   * Returns created=false for the two 200 (idempotency) paths.
   */
  async createPublicRegistration(
    formId: string,
    body: Omit<CreateRegistrationInput, "formId">,
  ): Promise<PublicCreateResult> {
    const input: CreateRegistrationInput = { ...body, formId };

    // 1. Idempotency short-circuit.
    if (input.idempotencyKey) {
      const existing = await this.getRegistrationByIdempotencyKey(
        input.idempotencyKey,
      );
      if (existing) {
        return {
          created: false,
          registration: toPublicRegistration(existing, { token: existing.editToken }),
          priceBreakdown: existing.priceBreakdown as PriceBreakdown,
        };
      }
    }

    // 2. Active REGISTRATION form gate (null → sponsor/inactive/missing/not-OPEN).
    const form = await findActiveRegistrationFormById(formId);
    if (!form) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Form not found", 404);
    }

    // 3. Module gates (DB-backed — matches legacy assertClientModuleEnabled).
    await assertClientModuleEnabled(form.event.clientId, "registrations");
    await assertClientModuleEnabled(form.event.clientId, "pricing");

    // 4. Form-data validation → the visible, coerced answers are both stored
    //    and priced (the quote prices the same data).
    const sanitizedFormData = prepareFormDataForPricing(form.schema, input.formData);
    const normalizedInput: CreateRegistrationInput = {
      ...input,
      formData: sanitizedFormData,
    };

    // 5. Price calculation.
    const calculated = await this.pricing.calculatePrice(form.eventId, {
      formData: sanitizedFormData,
      selectedAccessItems: (normalizedInput.accessSelections ?? []).map((s) => ({
        accessId: s.accessId,
        quantity: s.quantity,
      })),
      sponsorshipCodes: normalizedInput.sponsorshipCode
        ? [normalizedInput.sponsorshipCode]
        : [],
    });
    const priceBreakdown: PriceBreakdown = {
      ...calculated,
      accessItems: calculated.accessItems.map((item) => ({
        ...item,
        status: "confirmed",
      })),
      droppedAccessItems: [],
    };

    // 6. Create (with idempotency-race recovery).
    try {
      const created = await this.createRegistration(normalizedInput, priceBreakdown);
      return {
        created: true,
        registration: toPublicRegistration(created, { token: created.editToken }),
        priceBreakdown,
      };
    } catch (err) {
      const { isUnique, constraint } = pgUnique(err);
      if (
        normalizedInput.idempotencyKey &&
        isUnique &&
        /idempotency/i.test(constraint)
      ) {
        const existing = await this.getRegistrationByIdempotencyKey(
          normalizedInput.idempotencyKey,
        );
        if (existing) {
          return {
            created: false,
            registration: toPublicRegistration(existing, { token: existing.editToken }),
            priceBreakdown: existing.priceBreakdown as PriceBreakdown,
          };
        }
      }
      throw err;
    }
  }

  async createRegistration(
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

    if (linkBaseUrl) {
      assertPublicLinkBaseUrlAllowed(
        linkBaseUrl,
        this.config.publicLinkAllowedOrigins,
      );
    }

    const form = await findFormById(formId);
    if (!form) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Form not found", 404);
    }
    const eventId = form.eventId;

    // Duplicate check (outside tx — advisory fast-fail).
    if (await registrationExistsByEmailForm(email, formId)) {
      throw new AppException(
        ErrorCodes.REGISTRATION_ALREADY_EXISTS,
        "A registration with this email already exists for this form",
        409,
      );
    }

    // Advisory access-selection validation (outside tx).
    if (accessSelections && accessSelections.length > 0) {
      const v = await this.access.validateAccessSelections(
        eventId,
        accessSelections,
        formData,
      );
      if (!v.valid) {
        throw new AppException(
          ErrorCodes.BAD_REQUEST,
          `Invalid access selections: ${v.errors.join(", ")}`,
          400,
          { errors: v.errors },
        );
      }
    }

    await this.access.assertAccessSelectionRequirement(eventId, formData, accessSelections ?? [],
      (form.schema as { settings?: { accessSelectionRequired?: boolean } } | null)?.settings);

    let createdId!: string;
    try {
      await withTxn(async (tx) => {
      const event = await getEventForRegistrationCreate(eventId, tx);
      if (!event) {
        throw new AppException(
          ErrorCodes.EVENT_NOT_OPEN,
          "Event is not accepting registrations",
          400,
        );
      }
      assertEventAcceptsPublicActions(event);
      assertModuleEnabledForClient(event.client as ClientModuleState, "registrations");
      this.assertLabSponsorshipAllowed(event.client, paymentMethod);

      if (event.maxCapacity !== null && event.registeredCount >= event.maxCapacity) {
        throw new AppException(ErrorCodes.EVENT_FULL, "Event is at capacity", 409);
      }

      const editToken = generateEditToken();
      const referenceNumber = await allocateReferenceNumber(eventId, tx);

      const { id } = await insertRegistrationRow(
        {
          formId,
          eventId,
          formData,
          formSchemaVersion: form.schemaVersion ?? 1,
          networkingOptIn: input.networkingOptIn ?? null,
          email,
          firstName: firstName ?? null,
          lastName: lastName ?? null,
          phone: phone ?? null,
          referenceNumber,
          paymentStatus: "PENDING",
          paymentMethod: paymentMethod ?? null,
          labName: paymentMethod === "LAB_SPONSORSHIP" ? (labName ?? null) : null,
          totalAmount: priceBreakdown.subtotal,
          currency: priceBreakdown.currency,
          priceBreakdown,
          baseAmount: priceBreakdown.calculatedBasePrice,
          discountAmount: calculateDiscountAmount(priceBreakdown.appliedRules),
          accessAmount: priceBreakdown.accessTotal,
          sponsorshipCode: sponsorshipCode ?? null,
          sponsorshipAmount: priceBreakdown.sponsorshipTotal,
          accessTypeIds: accessSelections?.map((s) => s.accessId) ?? [],
          editToken,
          linkBaseUrl: linkBaseUrl ?? null,
          idempotencyKey: idempotencyKey ?? null,
        },
        tx,
      );
      createdId = id;

      if (accessSelections && accessSelections.length > 0) {
        await Promise.all(
          accessSelections.map((s) =>
            this.access.incrementAccessRegisteredCountTx(s.accessId, s.quantity, tx),
          ),
        );
      }

      await this.incrementEventRegistered(tx, eventId);

      await this.audit(tx, {
        entityId: id,
        action: "CREATE",
        changes: {
          email: { old: null, new: email },
          firstName: { old: null, new: firstName ?? null },
          lastName: { old: null, new: lastName ?? null },
          totalAmount: { old: null, new: priceBreakdown.subtotal },
        },
        performedBy: "PUBLIC",
      });

      const clientId = event.clientId;
      const pending: AppEvent[] = [
        {
          type: "registration.created",
          clientId,
          eventId,
          payload: { id, email, paymentStatus: "PENDING" },
          ts: Date.now(),
        },
      ];
      if (accessSelections && accessSelections.length > 0) {
        pending.push({
          type: "eventAccess.countsChanged",
          clientId,
          eventId,
          payload: { id: eventId, accessIds: accessSelections.map((s) => s.accessId) },
          ts: Date.now(),
        });
      }
      await emitSettlementEvents(tx, pending);
      await this.queueRegistrationCreatedEmail(tx, eventId, {
        id,
        email,
        firstName,
        lastName,
      });
      });
    } catch (err) {
      translateCreateUniqueViolation(err);
    }

    const enriched = await this.getEnrichedRow(createdId);
    return enriched;
  }

  private async getEnrichedRow(id: string): Promise<RegistrationWithRelations> {
    const row = await getRegistrationByIdRow(id);
    if (!row) {
      throw new AppException(
        ErrorCodes.REGISTRATION_NOT_FOUND,
        "Registration not found",
        404,
      );
    }
    return enrichWithAccessSelections(row);
  }

  private async getStrippedById(id: string): Promise<AdminRegistration> {
    const enriched = await this.getRegistrationById(id);
    if (!enriched) {
      throw new AppException(
        ErrorCodes.REGISTRATION_NOT_FOUND,
        "Registration not found after update",
        404,
      );
    }
    return enriched;
  }

  // ==========================================================================
  // Admin create
  // ==========================================================================

  async createAdminRegistration(
    eventId: string,
    input: AdminCreateRegistrationInput,
    adminUserId: string,
  ): Promise<AdminRegistration> {
    const {
      email: rawEmail,
      firstName,
      lastName,
      phone,
      formData: rawFormData,
      role,
      accessSelections,
      paymentMethod,
      paymentStatus,
      labName,
      sendEmail,
    } = input;
    const email = normalizeEmail(rawEmail);

    const form = await findRegistrationFormForEvent(eventId);
    if (!form) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "No registration form found for this event",
        404,
      );
    }
    // Admin answers: visible fields only, type-checked, required not enforced;
    // stored and priced as returned.
    const formData = prepareFormDataForPricing(
      (await getRegistrationFormSchemaForEvent(eventId))?.schema,
      rawFormData,
      { enforceRequired: false },
    );

    if (await registrationExistsByEmailForm(email, form.id)) {
      throw new AppException(
        ErrorCodes.REGISTRATION_ALREADY_EXISTS,
        "A registration with this email already exists for this form",
        409,
      );
    }

    if (accessSelections && accessSelections.length > 0) {
      const v = await this.access.validateAccessSelections(
        eventId,
        accessSelections,
        formData,
      );
      if (!v.valid) {
        throw new AppException(
          ErrorCodes.BAD_REQUEST,
          `Invalid access selections: ${v.errors.join(", ")}`,
          400,
          { errors: v.errors },
        );
      }
    }

    const eventGate = await getEventForRegistrationAdmin(eventId);
    if (!eventGate) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    assertModuleEnabledForClient(eventGate.client as ClientModuleState, "pricing");

    const priceBreakdown = await this.pricing.calculatePrice(eventId, {
      formData,
      selectedAccessItems: (accessSelections ?? []).map((s) => ({
        accessId: s.accessId,
        quantity: s.quantity,
      })),
      sponsorshipCodes: [],
    });

    let createdId!: string;
    try {
      await withTxn(async (tx) => {
      const event = await getEventForRegistrationAdmin(eventId, tx);
      if (!event) {
        throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
      }
      assertEventWritable(event);
      assertModuleEnabledForClient(event.client as ClientModuleState, "registrations");
      this.assertLabSponsorshipAllowed(event.client, paymentMethod);

      if (event.maxCapacity !== null && event.registeredCount >= event.maxCapacity) {
        throw new AppException(ErrorCodes.EVENT_FULL, "Event is at capacity", 409);
      }

      const resolvedPaymentStatus = paymentStatus ?? "PENDING";
      const referenceNumber = await allocateReferenceNumber(eventId, tx);
      const accessTypeIds = accessSelections?.map((s) => s.accessId) ?? [];

      const { id } = await insertRegistrationRow(
        {
          formId: form.id,
          eventId,
          formData,
          formSchemaVersion: form.schemaVersion,
          email,
          firstName,
          lastName,
          phone: phone ?? null,
          referenceNumber,
          role,
          paymentStatus: resolvedPaymentStatus,
          paidAmount:
            resolvedPaymentStatus === "PAID"
              ? calculateSettlement({
                  totalAmount: priceBreakdown.subtotal,
                  paidAmount: 0,
                  sponsorshipAmount: 0,
                }).netAmount
              : 0,
          paidAt: isFullySettled(resolvedPaymentStatus)
            ? new Date()
            : null,
          paymentMethod: paymentMethod ?? null,
          labName: paymentMethod === "LAB_SPONSORSHIP" ? (labName ?? null) : null,
          totalAmount: priceBreakdown.subtotal,
          currency: priceBreakdown.currency,
          priceBreakdown,
          baseAmount: priceBreakdown.calculatedBasePrice,
          discountAmount: calculateDiscountAmount(priceBreakdown.appliedRules),
          accessAmount: priceBreakdown.accessTotal,
          sponsorshipAmount: 0,
          accessTypeIds,
          editToken: null,
          linkBaseUrl: null,
          idempotencyKey: null,
        },
        tx,
      );
      createdId = id;

      if (accessSelections && accessSelections.length > 0) {
        await Promise.all(
          accessSelections.map((s) =>
            this.access.incrementAccessRegisteredCountTx(s.accessId, s.quantity, tx),
          ),
        );
      }

      if (isFullySettled(resolvedPaymentStatus)) {
        await this.syncPaidCount(
          tx,
          { id, eventId, priceBreakdown },
          "PENDING",
          resolvedPaymentStatus,
        );
      }

      await this.incrementEventRegistered(tx, eventId);

      await this.audit(tx, {
        entityId: id,
        action: "CREATE",
        changes: {
          email: { old: null, new: email },
          firstName: { old: null, new: firstName },
          lastName: { old: null, new: lastName },
          role: { old: null, new: role },
          totalAmount: { old: null, new: priceBreakdown.subtotal },
        },
        performedBy: adminUserId,
      });

      if (sendEmail) {
        await this.queueRegistrationCreatedEmail(tx, eventId, {
          id,
          email,
          firstName,
          lastName,
        });
      }
      });
    } catch (err) {
      translateCreateUniqueViolation(err);
    }

    return toAdminRegistration(await this.getEnrichedRow(createdId));
  }

  // ==========================================================================
  // Admin partial update (payment/note/role)
  // ==========================================================================

  async updateRegistration(
    id: string,
    input: UpdateRegistrationInput,
    performedBy?: string,
  ): Promise<AdminRegistration> {
    await withTxn(async (tx) => {
      const registration = await findRegistrationForMutation(id, tx);
      if (!registration) {
        throw new AppException(
          ErrorCodes.REGISTRATION_NOT_FOUND,
          "Registration not found",
          404,
        );
      }
      assertEventWritable(registration.event);
      assertModuleEnabledForClient(
        registration.event.client as ClientModuleState,
        "registrations",
      );

      const settlement: RegistrationSettlementWrite = {};
      const fields: RegistrationFieldsPatch = {};
      if (input.paymentStatus !== undefined) {
        validatePaymentTransition(registration.paymentStatus, input.paymentStatus);
        settlement.paymentStatus = input.paymentStatus;
        if (
          isFullySettled(input.paymentStatus) &&
          !registration.paidAt
        ) {
          settlement.paidAt = new Date();
        }
      }
      const paidAmount =
        input.paidAmount ??
        (input.paymentStatus === "PAID"
          ? calculateSettlement(registration).netAmount
          : undefined);
      if (paidAmount !== undefined) {
        if (paidAmount > calculateSettlement(registration).netAmount) {
          throw new AppException(
            ErrorCodes.BAD_REQUEST,
            "Paid amount cannot exceed registration total",
            400,
          );
        }
        settlement.paidAmount = paidAmount;
      }
      if (input.paymentMethod !== undefined) fields.paymentMethod = input.paymentMethod;
      if (input.paymentReference !== undefined)
        fields.paymentReference = input.paymentReference;
      if (input.paymentProofUrl !== undefined)
        fields.paymentProofUrl = input.paymentProofUrl;
      if (input.note !== undefined) fields.note = input.note;
      if (input.role !== undefined) fields.role = input.role;

      const changes: Record<string, { old: unknown; new: unknown }> = {};
      if (input.note !== undefined && input.note !== registration.note) {
        changes.note = { old: registration.note, new: input.note };
      }
      const statusChanged =
        input.paymentStatus !== undefined &&
        input.paymentStatus !== registration.paymentStatus;
      if (statusChanged) {
        changes.paymentStatus = {
          old: registration.paymentStatus,
          new: input.paymentStatus,
        };
      }
      if (
        settlement.paidAmount !== undefined &&
        settlement.paidAmount !== registration.paidAmount
      ) {
        changes.paidAmount = {
          old: registration.paidAmount,
          new: settlement.paidAmount,
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

      await applyRegistrationSettlement(tx, { registrationId: id, settlement, fields });

      if (statusChanged) {
        await this.syncPaidCount(
          tx,
          registration,
          registration.paymentStatus,
          input.paymentStatus as string,
        );
      }

      if (Object.keys(changes).length > 0) {
        await this.audit(tx, {
          entityId: id,
          action: "UPDATE",
          changes,
          performedBy,
        });
      }

      const pending = settlementEventPair({
        id,
        eventId: registration.eventId,
        clientId: registration.event.clientId,
        oldStatus: registration.paymentStatus,
        newStatus: input.paymentStatus as string | undefined,
        emitCountsChanged: statusChanged,
      });
      await emitSettlementEvents(tx, pending);
    });

    return this.getStrippedById(id);
  }

  // ==========================================================================
  // Admin full edit (override — no payment-transition validation)
  // ==========================================================================

  async adminEditRegistration(
    eventId: string,
    id: string,
    input: AdminEditRegistrationInput,
    adminUserId: string,
  ): Promise<AdminRegistration> {
    await withTxn(async (tx) => {
      const registration = await findRegistrationForMutation(id, tx);
      if (!registration) {
        throw new AppException(
          ErrorCodes.REGISTRATION_NOT_FOUND,
          "Registration not found",
          404,
        );
      }
      if (registration.eventId !== eventId) {
        throw new AppException(
          ErrorCodes.BAD_REQUEST,
          "Registration does not belong to this event",
          400,
        );
      }
      assertEventWritable(registration.event);
      assertModuleEnabledForClient(
        registration.event.client as ClientModuleState,
        "registrations",
      );

      const settlement: RegistrationSettlementWrite = {};
      const fields: RegistrationFieldsPatch = {};
      const changes: Record<string, { old: unknown; new: unknown }> = {};
      const hasPriceEdits =
        input.accessSelections !== undefined || input.formData !== undefined;
      const setDefaultPaidAmount = (paidAmount: number) => {
        settlement.paidAmount = paidAmount;
        if (paidAmount !== registration.paidAmount) {
          changes.paidAmount = {
            old: registration.paidAmount,
            new: paidAmount,
          };
        }
      };

      const inputEmail =
        input.email !== undefined ? normalizeEmail(input.email) : undefined;
      if (inputEmail !== undefined && inputEmail !== registration.email) {
        if (await registrationExistsByEmailForm(inputEmail, registration.formId, tx, id)) {
          throw new AppException(
            ErrorCodes.REGISTRATION_ALREADY_EXISTS,
            "A registration with this email already exists for this form",
            409,
          );
        }
        fields.email = inputEmail;
        changes.email = { old: registration.email, new: inputEmail };
      }
      if (input.firstName !== undefined && input.firstName !== registration.firstName) {
        fields.firstName = input.firstName;
        changes.firstName = { old: registration.firstName, new: input.firstName };
      }
      if (input.lastName !== undefined && input.lastName !== registration.lastName) {
        fields.lastName = input.lastName;
        changes.lastName = { old: registration.lastName, new: input.lastName };
      }
      if (input.phone !== undefined && input.phone !== registration.phone) {
        fields.phone = input.phone;
        changes.phone = { old: registration.phone, new: input.phone };
      }
      // Admin answers: visible fields only, type-checked, required not
      // enforced; stored and priced as returned.
      const editedFormData =
        input.formData !== undefined
          ? prepareFormDataForPricing(
              (await getRegistrationFormSchemaForEvent(eventId, tx))?.schema,
              input.formData,
              { enforceRequired: false },
            )
          : undefined;
      if (editedFormData !== undefined) {
        fields.formData = editedFormData;
        changes.formData = { old: "(previous)", new: "(updated)" };
      }
      if (input.role !== undefined && input.role !== registration.role) {
        fields.role = input.role;
        changes.role = { old: registration.role, new: input.role };
      }
      if (input.note !== undefined && input.note !== registration.note) {
        fields.note = input.note;
        changes.note = { old: registration.note, new: input.note };
      }

      // Payment fields — NO transition validation (admin override).
      if (
        input.paymentStatus !== undefined &&
        input.paymentStatus !== registration.paymentStatus
      ) {
        settlement.paymentStatus = input.paymentStatus;
        changes.paymentStatus = {
          old: registration.paymentStatus,
          new: input.paymentStatus,
        };
        if (
          isFullySettled(input.paymentStatus) &&
          !registration.paidAt
        ) {
          settlement.paidAt = new Date();
        }
      }
      if (
        input.paidAmount !== undefined &&
        input.paidAmount !== registration.paidAmount
      ) {
        if (input.paidAmount > calculateSettlement(registration).netAmount) {
          throw new AppException(
            ErrorCodes.BAD_REQUEST,
            "Paid amount cannot exceed registration total",
            400,
          );
        }
        settlement.paidAmount = input.paidAmount;
        changes.paidAmount = { old: registration.paidAmount, new: input.paidAmount };
      }
      if (
        input.paymentMethod !== undefined &&
        input.paymentMethod !== registration.paymentMethod
      ) {
        fields.paymentMethod = input.paymentMethod;
        changes.paymentMethod = {
          old: registration.paymentMethod,
          new: input.paymentMethod,
        };
      }
      if (input.paymentReference !== undefined)
        fields.paymentReference = input.paymentReference;
      if (input.paymentProofUrl !== undefined)
        fields.paymentProofUrl = input.paymentProofUrl;
      if (input.labName !== undefined) fields.labName = input.labName;

      // Price-affecting edit branch.
      if (hasPriceEdits) {
        assertModuleEnabledForClient(
          registration.event.client as ClientModuleState,
          "pricing",
        );
        const effectiveFormData =
          editedFormData ??
          (registration.formData as Record<string, unknown>) ??
          {};
        const oldBreakdown = registration.priceBreakdown as PriceBreakdown | null;
        const oldAccessItems = (oldBreakdown?.accessItems ?? []).map((item) => ({
          accessId: item.accessId,
          quantity: item.quantity,
        }));
        const effectiveAccessSelections = input.accessSelections ?? oldAccessItems;
        const selectedAccessItems = effectiveAccessSelections.map((s) => ({
          accessId: s.accessId,
          quantity: s.quantity,
        }));
        const existingAccessIds = new Set(registration.accessTypeIds ?? []);

        if (
          input.accessSelections !== undefined &&
          effectiveAccessSelections.length > 0
        ) {
          const v = await this.access.validateAccessSelections(
            eventId,
            effectiveAccessSelections,
            effectiveFormData,
            existingAccessIds,
            tx,
          );
          if (!v.valid) {
            throw new AppException(
              ErrorCodes.BAD_REQUEST,
              `Invalid access selections: ${v.errors.join(", ")}`,
              400,
              { errors: v.errors },
            );
          }
        }

        const existingSponsorshipCodes = registration.sponsorshipCode
          ? [registration.sponsorshipCode]
          : [];
        let priceBreakdown = await this.pricing.calculatePrice(
          eventId,
          {
            formData: effectiveFormData,
            selectedAccessItems,
            sponsorshipCodes: existingSponsorshipCodes,
          },
          tx,
        );

        const oldAccessTypeIds = registration.accessTypeIds ?? [];
        if (input.accessSelections !== undefined) {
          await Promise.all(
            oldAccessItems.map((old) =>
              this.access.decrementAccessRegisteredCountTx(
                old.accessId,
                old.quantity,
                tx,
              ),
            ),
          );
          await Promise.all(
            effectiveAccessSelections
              .filter((sel) => sel.quantity > 0)
              .map((sel) =>
                this.access.incrementAccessRegisteredCountTx(
                  sel.accessId,
                  sel.quantity,
                  tx,
                ),
              ),
          );
        }

        const recalculated = await this.recalculateLinkedSponsorshipSettlement(
          tx,
          { ...registration, paidAmount: input.paidAmount ?? registration.paidAmount },
          priceBreakdown,
        );
        priceBreakdown = recalculated.priceBreakdown;

        const nextPaymentStatus =
          input.paymentStatus ??
          recalculated.paymentStatus ??
          registration.paymentStatus;
        const shouldDefaultPaidAmount =
          input.paymentStatus === "PAID" && input.paidAmount === undefined;
        const defaultPaidAmount = shouldDefaultPaidAmount
          ? calculateSettlement({
              totalAmount: priceBreakdown.subtotal,
              paidAmount: registration.paidAmount,
              sponsorshipAmount: recalculated.sponsorshipAmount,
            }).netAmount
          : undefined;
        const nextPaidAmount =
          input.paidAmount ?? defaultPaidAmount ?? registration.paidAmount;
        if (nextPaidAmount > priceBreakdown.total) {
          throw new AppException(
            ErrorCodes.BAD_REQUEST,
            "Paid amount cannot exceed registration total",
            400,
          );
        }

        // base/access/discount amounts are derived from the breakdown by the writer.
        settlement.totalAmount = priceBreakdown.subtotal;
        settlement.sponsorshipAmount = recalculated.sponsorshipAmount;
        fields.accessTypeIds = effectiveAccessSelections.map((s) => s.accessId);
        settlement.priceBreakdown = priceBreakdown;
        if (shouldDefaultPaidAmount) {
          setDefaultPaidAmount(nextPaidAmount);
        }
        if (
          input.paymentStatus === undefined &&
          recalculated.paymentStatus !== undefined &&
          recalculated.paymentStatus !== registration.paymentStatus
        ) {
          settlement.paymentStatus = recalculated.paymentStatus;
          changes.paymentStatus = {
            old: registration.paymentStatus,
            new: recalculated.paymentStatus,
          };
        }
        if (input.paymentStatus === undefined && recalculated.paidAt !== undefined) {
          settlement.paidAt = recalculated.paidAt;
        }
        if (input.accessSelections !== undefined) {
          changes.accessSelections = {
            old: oldAccessTypeIds,
            new: effectiveAccessSelections.map((s) => s.accessId),
          };
        }
        changes.totalAmount = {
          old: registration.totalAmount,
          new: priceBreakdown.subtotal,
        };

        if (
          input.accessSelections !== undefined ||
          nextPaymentStatus !== registration.paymentStatus
        ) {
          await this.access.syncPaidCountDelta(
            eventId,
            {
              status: registration.paymentStatus,
              priceBreakdown: registration.priceBreakdown,
              coveredAccessIds: recalculated.coveredAccessIds,
            },
            {
              status: nextPaymentStatus,
              priceBreakdown,
              coveredAccessIds: recalculated.coveredAccessIds,
            },
            tx,
          );
        }
      }

      if (
        !hasPriceEdits &&
        input.paymentStatus === "PAID" &&
        input.paidAmount === undefined
      ) {
        setDefaultPaidAmount(calculateSettlement(registration).netAmount);
      }

      fields.lastEditedAt = new Date();
      await applyRegistrationSettlement(tx, { registrationId: id, settlement, fields });

      // paidCount sync for the payment-status-only path (no access/formData edit).
      if (
        input.paymentStatus !== undefined &&
        input.paymentStatus !== registration.paymentStatus &&
        input.accessSelections === undefined &&
        input.formData === undefined
      ) {
        const effectivePriceBreakdown =
          (settlement.priceBreakdown as unknown) ?? registration.priceBreakdown;
        await this.syncPaidCount(
          tx,
          { id, eventId, priceBreakdown: effectivePriceBreakdown },
          registration.paymentStatus,
          input.paymentStatus,
        );
      }

      if (Object.keys(changes).length > 0) {
        await this.audit(tx, {
          entityId: id,
          action: "UPDATE",
          changes,
          performedBy: adminUserId,
        });
      }

      const statusChanged =
        input.paymentStatus !== undefined &&
        input.paymentStatus !== registration.paymentStatus;
      const pending = settlementEventPair({
        id,
        eventId,
        clientId: registration.event.clientId,
        oldStatus: registration.paymentStatus,
        newStatus:
          (settlement.paymentStatus as string | undefined) ?? input.paymentStatus,
        emitCountsChanged: !!(
          statusChanged ||
          (input.accessSelections && input.accessSelections.length > 0)
        ),
      });
      await emitSettlementEvents(tx, pending);
    });

    return this.getStrippedById(id);
  }

  // ==========================================================================
  // Delete
  // ==========================================================================

  async deleteRegistration(
    id: string,
    performedBy?: string,
    force?: boolean,
    requestingUserRole?: number,
  ): Promise<void> {
    if (
      force &&
      requestingUserRole !== UserRole.CLIENT_ADMIN &&
      requestingUserRole !== UserRole.SUPER_ADMIN
    ) {
      throw new AppException(
        ErrorCodes.FORBIDDEN,
        "Only admins can force-delete registrations",
        403,
      );
    }

    const networkingPhoto = await withTxn(async (tx) => {
      const registration = await findRegistrationForMutation(id, tx);
      if (!registration) {
        throw new AppException(
          ErrorCodes.REGISTRATION_NOT_FOUND,
          "Registration not found",
          404,
        );
      }
      assertEventWritable(registration.event);
      assertModuleEnabledForClient(
        registration.event.client as ClientModuleState,
        "registrations",
      );

      if (registration.paymentStatus === "PAID" && !force) {
        throw new AppException(
          ErrorCodes.REGISTRATION_DELETE_BLOCKED,
          "Cannot delete a paid registration. Use refund instead.",
          400,
        );
      }

      await this.audit(tx, {
        entityId: id,
        action: "DELETE",
        changes: {
          email: { old: registration.email, new: null },
          firstName: { old: registration.firstName, new: null },
          lastName: { old: registration.lastName, new: null },
          paymentStatus: { old: registration.paymentStatus, new: null },
          ...(force ? { forceDelete: { old: null, new: true } } : {}),
        },
        performedBy,
      });

      const usages = await findRegistrationUsageLinks(id, tx);
      const coveredAccessIds =
        registration.paymentStatus === "PARTIAL"
          ? await this.access.getAlreadyCoveredAccessIds(id, tx)
          : new Set<string>();

      if (usages.length > 0) {
        await deleteRegistrationUsages(id, tx);
        const sponsorshipIds = [...new Set(usages.map((u) => u.sponsorshipId))];
        for (const sponsorshipId of sponsorshipIds) {
          const remaining = await countUsagesForSponsorship(tx, sponsorshipId);
          await updateSponsorshipRow(tx, sponsorshipId, {
            status: remaining > 0 ? "USED" : "PENDING",
          });
        }
      }

      const priceBreakdown = registration.priceBreakdown as PriceBreakdown;
      if (priceBreakdown.accessItems) {
        await Promise.all(
          priceBreakdown.accessItems.map((item) =>
            this.access.decrementAccessRegisteredCountTx(item.accessId, item.quantity, tx),
          ),
        );
      }

      await this.access.syncPaidCountDelta(
        registration.eventId,
        { status: registration.paymentStatus, priceBreakdown, coveredAccessIds },
        { status: "PENDING", priceBreakdown },
        tx,
      );

      await this.decrementEventRegistered(tx, registration.eventId);
      // The networking profile cascades with the row; keep its photo for cleanup after commit.
      const photo = await getNetworkingProfilePhotoByRegistration(id, tx);
      await deleteRegistrationRow(id, tx);

      const clientId = registration.event.clientId;
      const accessIds = priceBreakdown.accessItems?.map((a) => a.accessId) ?? [];
      const pending: AppEvent[] = [
        {
          type: "registration.deleted",
          clientId,
          eventId: registration.eventId,
          payload: { id: registration.id, email: registration.email },
          ts: Date.now(),
        },
        {
          type: "eventAccess.countsChanged",
          clientId,
          eventId: registration.eventId,
          payload: { id: registration.eventId, accessIds },
          ts: Date.now(),
        },
      ];
      await emitSettlementEvents(tx, pending);
      return photo;
    });
    if (networkingPhoto)
      await deleteNetworkingPhoto(networkingPhoto.photoUrl, networkingPhoto.eventId, networkingPhoto.id);
  }

  // ==========================================================================
  // Public self-service: get-for-edit
  // ==========================================================================

  async getRegistrationForEdit(
    registrationId: string,
  ): Promise<GetRegistrationForEditResult> {
    const registration = await findRegistrationWithFormEvent(registrationId);
    if (!registration) {
      throw new AppException(
        ErrorCodes.REGISTRATION_NOT_FOUND,
        "Registration not found",
        404,
      );
    }

    const priceBreakdown = registration.priceBreakdown as PriceBreakdown;
    const accessIds = priceBreakdown.accessItems?.map((i) => i.accessId) ?? [];
    const details =
      accessIds.length > 0 ? await findAccessDetailsByIds(accessIds) : [];
    const accessMap = new Map(details.map((a) => [a.id, a]));
    const accessSelections = (priceBreakdown.accessItems ?? []).map((item) => ({
      id: `${registration.id}-${item.accessId}`,
      accessId: item.accessId,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      subtotal: item.subtotal,
      access:
        accessMap.get(item.accessId) ?? {
          id: item.accessId,
          name: String(item.name ?? item.accessId),
          type: "OTHER",
          startsAt: null,
          endsAt: null,
        },
    }));

    const restrictions: string[] = [];
    let canEdit = true;
    let canEditPersonalInfo = true;
    let canEditAccess = true;
    let canAddAccess = true;
    let canRemoveAccess = true;
    let isFullySponsored = false;

    const blockAll = (reason: string) => {
      canEdit = false;
      canEditPersonalInfo = false;
      canEditAccess = false;
      canAddAccess = false;
      canRemoveAccess = false;
      restrictions.push(reason);
    };

    if (registration.paymentStatus === "REFUNDED") {
      blockAll("Registration has been refunded");
    }
    if (
      registration.event.status !== "OPEN" ||
      registration.event.endDate < new Date()
    ) {
      blockAll("Event is not accepting changes");
    }
    if (!isModuleEnabledForClient(registration.event.client, "registrations")) {
      blockAll("Registrations are disabled for this event");
    }
    if (!isModuleEnabledForClient(registration.event.client, "pricing")) {
      blockAll("Pricing is disabled for this event");
    }
    if (registration.paymentStatus === "VERIFYING") {
      canEditAccess = false;
      canAddAccess = false;
      canRemoveAccess = false;
      restrictions.push("Payment proof is under review");
    }
    const isPaid =
      registration.paymentStatus === "PAID" ||
      registration.paymentStatus === "SPONSORED" ||
      registration.paidAmount > 0;
    if (isPaid) {
      canRemoveAccess = false;
      restrictions.push("Cannot remove access items (payment received)");
    }
    if (registration.paymentStatus === "WAIVED") {
      canEditAccess = false;
      canAddAccess = false;
      canRemoveAccess = false;
      restrictions.push("Waived registrations cannot modify access selections");
    }
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

    const { amountDue } = calculateSettlement({
      totalAmount: registration.totalAmount,
      paidAmount: registration.paidAmount,
      sponsorshipAmount: registration.sponsorshipAmount,
    });

    return {
      registration: toPublicRegistration({ ...registration, accessSelections }),
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

  // ==========================================================================
  // Public self-service: edit (optimistic CAS on updatedAt)
  // ==========================================================================

  async editRegistrationPublic(
    registrationId: string,
    input: PublicEditRegistrationInput,
  ): Promise<EditRegistrationPublicResult> {
    const expectedUpdatedAt = new Date(input.expectedUpdatedAt);
    if (Number.isNaN(expectedUpdatedAt.getTime())) {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "Invalid expectedUpdatedAt precondition",
        400,
      );
    }

    let newPriceBreakdown!: PriceBreakdown;

    await withTxn(async (tx) => {
      const current = await findRegistrationWithFormEvent(registrationId, tx);
      if (!current) {
        throw new AppException(
          ErrorCodes.REGISTRATION_NOT_FOUND,
          "Registration not found",
          404,
        );
      }

      if (current.paymentStatus === "REFUNDED") {
        throw new AppException(
          ErrorCodes.REGISTRATION_REFUNDED,
          "Refunded registrations cannot be edited",
          400,
        );
      }

      try {
        assertEventAcceptsPublicActions(current.event);
      } catch {
        throw new AppException(
          ErrorCodes.REGISTRATION_EDIT_FORBIDDEN,
          "Event is not accepting changes",
          400,
        );
      }

      assertModuleEnabledForClient(
        current.event.client as ClientModuleState,
        "registrations",
      );
      assertModuleEnabledForClient(
        current.event.client as ClientModuleState,
        "pricing",
      );

      const isAccessEdit = input.accessSelections !== undefined;

      if (current.paymentStatus === "VERIFYING" && isAccessEdit) {
        throw new AppException(
          ErrorCodes.REGISTRATION_VERIFYING_BLOCKED,
          "Cannot modify access while payment is under review",
          400,
        );
      }
      if (current.paymentStatus === "WAIVED" && isAccessEdit) {
        throw new AppException(
          ErrorCodes.REGISTRATION_WAIVED_ACCESS_BLOCKED,
          "Waived registrations cannot modify access selections",
          400,
        );
      }
      if (
        current.sponsorshipAmount >= current.totalAmount &&
        current.totalAmount > 0 &&
        isAccessEdit
      ) {
        throw new AppException(
          ErrorCodes.REGISTRATION_FULLY_SPONSORED_BLOCKED,
          "Fully sponsored registrations cannot modify access selections",
          400,
        );
      }

      const currentFormData =
        (current.formData as Record<string, unknown> | null) ?? {};
      let newFormData: Record<string, unknown> = input.formData
        ? { ...currentFormData, ...input.formData }
        : currentFormData;

      if (input.formData) {
        newFormData = prepareFormDataForPricing(current.form.schema, newFormData);
      }

      const currentPriceBreakdown =
        (current.priceBreakdown as PriceBreakdown | null) ??
        ({ accessItems: [] } as unknown as PriceBreakdown);
      const currentAccessItems = currentPriceBreakdown.accessItems ?? [];
      const currentAccessIds = new Set(currentAccessItems.map((i) => i.accessId));

      const newAccessSelections =
        input.accessSelections ??
        currentAccessItems.map((item) => ({
          accessId: item.accessId,
          quantity: item.quantity,
        }));

      const toQuantityMap = (
        items: Array<{ accessId: string; quantity: number }>,
      ) => {
        const q = new Map<string, number>();
        for (const item of items) {
          q.set(item.accessId, (q.get(item.accessId) ?? 0) + item.quantity);
        }
        return q;
      };

      const oldQuantities = toQuantityMap(currentAccessItems);
      const newQuantities = toQuantityMap(newAccessSelections);
      const accessDeltas = Array.from(
        new Set([...oldQuantities.keys(), ...newQuantities.keys()]),
      )
        .map((accessId) => ({
          accessId,
          delta: (newQuantities.get(accessId) ?? 0) - (oldQuantities.get(accessId) ?? 0),
        }))
        .filter((c) => c.delta !== 0);

      const currentIsPaid =
        current.paymentStatus === "PAID" ||
        current.paymentStatus === "SPONSORED" ||
        current.paidAmount > 0;
      const negativeDeltas = accessDeltas.filter((c) => c.delta < 0);
      if (currentIsPaid && negativeDeltas.length > 0) {
        throw new AppException(
          ErrorCodes.REGISTRATION_ACCESS_REMOVAL_BLOCKED,
          "Cannot remove access items from a paid registration",
          400,
          {
            message: "Paid registrations can only add new access items",
            attemptedRemovals: negativeDeltas.map((c) => c.accessId),
          },
        );
      }

      if (isAccessEdit || input.formData !== undefined) {
        const v = await this.access.validateAccessSelections(
          current.eventId,
          newAccessSelections,
          newFormData,
          currentAccessIds,
          tx,
        );
        if (!v.valid) {
          throw new AppException(
            ErrorCodes.BAD_REQUEST,
            `Invalid access selections: ${v.errors.join(", ")}`,
            400,
            { errors: v.errors },
          );
        }
      }

      if (isAccessEdit || input.formData !== undefined) {
        await this.access.assertAccessSelectionRequirement(current.eventId, newFormData, newAccessSelections,
          (current.form.schema as { settings?: { accessSelectionRequired?: boolean } } | null)?.settings, tx);
      }

      newPriceBreakdown = await this.pricing.calculatePrice(
        current.eventId,
        {
          formData: newFormData,
          selectedAccessItems: newAccessSelections.map((s) => ({
            accessId: s.accessId,
            quantity: s.quantity,
          })),
          sponsorshipCodes: current.sponsorshipCode ? [current.sponsorshipCode] : [],
        },
        tx,
      );

      const newTotalAmount = currentIsPaid
        ? Math.max(current.totalAmount, newPriceBreakdown.subtotal)
        : newPriceBreakdown.subtotal;
      const recalculated = await this.recalculateLinkedSponsorshipSettlement(
        tx,
        current,
        newPriceBreakdown,
        newTotalAmount,
      );
      newPriceBreakdown = recalculated.priceBreakdown;
      const nextPaymentStatus = recalculated.paymentStatus ?? current.paymentStatus;
      const nextPaidAt =
        recalculated.paymentStatus !== undefined ? recalculated.paidAt ?? null : current.paidAt;

      await Promise.all(
        accessDeltas
          .filter((c) => c.delta > 0)
          .map((c) =>
            this.access.incrementAccessRegisteredCountTx(c.accessId, c.delta, tx),
          ),
      );
      if (!currentIsPaid) {
        await Promise.all(
          accessDeltas
            .filter((c) => c.delta < 0)
            .map((c) =>
              this.access.decrementAccessRegisteredCountTx(
                c.accessId,
                Math.abs(c.delta),
                tx,
              ),
            ),
        );
      }

      if (
        (isAccessEdit && accessDeltas.length > 0) ||
        nextPaymentStatus !== current.paymentStatus
      ) {
        const currentCovered =
          current.paymentStatus === "PARTIAL"
            ? await this.access.getAlreadyCoveredAccessIds(registrationId, tx)
            : new Set<string>();
        await this.access.syncPaidCountDelta(
          current.eventId,
          {
            status: current.paymentStatus,
            priceBreakdown: currentPriceBreakdown,
            coveredAccessIds: currentCovered,
          },
          {
            status: nextPaymentStatus,
            priceBreakdown: newPriceBreakdown,
            coveredAccessIds: recalculated.coveredAccessIds,
          },
          tx,
        );
      }

      // Compare-and-swap on updatedAt; base/access/discount amounts are
      // derived from the breakdown by the writer.
      const written = await applyRegistrationSettlement(tx, {
        registrationId,
        expectedUpdatedAt,
        settlement: {
          totalAmount: newTotalAmount,
          priceBreakdown: newPriceBreakdown,
          sponsorshipAmount: recalculated.sponsorshipAmount,
          paymentStatus: nextPaymentStatus as RegistrationPaymentStatus,
          paidAt: nextPaidAt,
        },
        fields: {
          formData: newFormData,
          firstName: input.firstName ?? current.firstName,
          lastName: input.lastName ?? current.lastName,
          phone: input.phone ?? current.phone,
          accessTypeIds: newAccessSelections.map((s) => s.accessId),
          lastEditedAt: new Date(),
        },
      });

      if (!written) {
        throw new AppException(
          ErrorCodes.CONCURRENT_MODIFICATION,
          "Registration changed. Refresh and try again.",
          409,
        );
      }

      const auditChanges: Record<string, { old: unknown; new: unknown }> = {};
      if (input.formData) {
        auditChanges.formData = { old: currentFormData, new: newFormData };
      }
      if (input.firstName !== undefined && input.firstName !== current.firstName) {
        auditChanges.firstName = { old: current.firstName, new: input.firstName };
      }
      if (input.lastName !== undefined && input.lastName !== current.lastName) {
        auditChanges.lastName = { old: current.lastName, new: input.lastName };
      }
      if (input.phone !== undefined && input.phone !== current.phone) {
        auditChanges.phone = { old: current.phone, new: input.phone };
      }
      if (isAccessEdit && accessDeltas.length > 0) {
        auditChanges.accessSelections = {
          old: currentAccessItems.map((i) => ({
            accessId: i.accessId,
            quantity: i.quantity,
          })),
          new: newAccessSelections.map((s) => ({
            accessId: s.accessId,
            quantity: s.quantity,
          })),
        };
      }
      if (Object.keys(auditChanges).length > 0) {
        await this.audit(tx, {
          entityId: registrationId,
          action: "UPDATE",
          changes: auditChanges,
          performedBy: "PUBLIC",
        });
      }

      const clientId = current.event.clientId;
      const pending: AppEvent[] = [
        {
          type: "registration.updated",
          clientId,
          eventId: current.eventId,
          payload: { id: registrationId, paymentStatus: nextPaymentStatus },
          ts: Date.now(),
        },
      ];
      if (isAccessEdit && accessDeltas.length > 0) {
        pending.push({
          type: "eventAccess.countsChanged",
          clientId,
          eventId: current.eventId,
          payload: {
            id: current.eventId,
            accessIds: accessDeltas.map((c) => c.accessId),
          },
          ts: Date.now(),
        });
      }
      await emitSettlementEvents(tx, pending);
    });

    const registration = toPublicRegistration(await this.getEnrichedRow(registrationId));
    return { registration, priceBreakdown: newPriceBreakdown };
  }

  // ==========================================================================
  // Confirm payment (admin) — strict transition
  // ==========================================================================

  async confirmPayment(
    id: string,
    input: UpdatePaymentInput,
    performedBy?: string,
    ipAddress?: string,
  ): Promise<AdminRegistration> {
    await withTxn(async (tx) => {
      const old = await findRegistrationForMutation(id, tx);
      if (!old) {
        throw new AppException(
          ErrorCodes.REGISTRATION_NOT_FOUND,
          "Registration not found",
          404,
        );
      }
      assertEventWritable(old.event);
      assertModuleEnabledForClient(
        old.event.client as ClientModuleState,
        "registrations",
      );

      validatePaymentTransition(old.paymentStatus, input.paymentStatus);

      const { netAmount } = calculateSettlement(old);
      const effectivePaidAmount = input.paidAmount ?? netAmount;
      if (effectivePaidAmount > netAmount) {
        throw new AppException(
          ErrorCodes.BAD_REQUEST,
          "Paid amount cannot exceed registration total",
          400,
        );
      }
      // ponytail: legacy logger.warn on partial-amount confirm dropped (non-behavioral).

      const newStatus = input.paymentStatus;
      const nextPaidAmount = effectivePaidAmount;
      const nextPaymentMethod = input.paymentMethod ?? old.paymentMethod;
      const settlement: RegistrationSettlementWrite = {
        paymentStatus: newStatus,
        paidAmount: nextPaidAmount,
      };
      if (isFullySettled(newStatus)) {
        settlement.paidAt = new Date();
      }
      await applyRegistrationSettlement(tx, {
        registrationId: id,
        settlement,
        fields: {
          paymentMethod: nextPaymentMethod,
          paymentReference: input.paymentReference ?? old.paymentReference,
          paymentProofUrl: input.paymentProofUrl ?? old.paymentProofUrl,
        },
      });

      await insertAuditLog(
        {
          entityType: "Registration",
          entityId: id,
          action: "PAYMENT_CONFIRMED",
          changes: {
            paymentStatus: { old: old.paymentStatus, new: newStatus },
            paidAmount: { old: old.paidAmount, new: nextPaidAmount },
            paymentMethod: { old: old.paymentMethod, new: nextPaymentMethod },
          },
          performedBy: performedBy ?? null,
          ipAddress: ipAddress ?? null,
        },
        tx,
      );

      await this.syncPaidCount(
        tx,
        { id, eventId: old.eventId, priceBreakdown: old.priceBreakdown },
        old.paymentStatus,
        input.paymentStatus,
      );

      const wasSettled = isFullySettled(old.paymentStatus);
      const isSettled = isFullySettled(input.paymentStatus);
      const clientId = old.event.clientId;
      const pending: AppEvent[] = [
        {
          type:
            !wasSettled && isSettled
              ? "registration.paymentConfirmed"
              : "registration.updated",
          clientId,
          eventId: old.eventId,
          payload: { id, paymentStatus: input.paymentStatus },
          ts: Date.now(),
        },
      ];
      if (wasSettled !== isSettled) {
        const breakdown = old.priceBreakdown as PriceBreakdown;
        const accessIds = breakdown.accessItems?.map((a) => a.accessId) ?? [];
        pending.push({
          type: "eventAccess.countsChanged",
          clientId,
          eventId: old.eventId,
          payload: { id: old.eventId, accessIds },
          ts: Date.now(),
        });
      }
      await emitSettlementEvents(tx, pending);

      if (input.paymentStatus === "PAID" && old.paymentStatus !== "PAID") {
        await enqueueTriggeredEmailOutbox(
          tx,
          {
            trigger: "PAYMENT_CONFIRMED",
            eventId: old.eventId,
            registration: {
              id,
              email: old.email,
              firstName: old.firstName ?? null,
              lastName: old.lastName ?? null,
            },
          },
          `email:triggered:PAYMENT_CONFIRMED:${id}`,
        );
      }
    });

    return this.getStrippedById(id);
  }

  // ==========================================================================
  // Admin: audited self-edit link (the only admin path to the edit token)
  // ==========================================================================

  /**
   * Registrant self-edit link for an admin, built exactly like the emailed
   * link. Every issuance writes an EDIT_LINK_ISSUED audit entry (actor + IP,
   * never the link). 404 when the registration has no edit token (admin-created
   * registrations are never given one).
   */
  async issueSelfEditLink(
    id: string,
    performedBy: string,
    ipAddress?: string,
  ): Promise<{ url: string }> {
    const source = await getRegistrationEditLinkSource(id);
    if (!source) {
      throw new AppException(
        ErrorCodes.REGISTRATION_NOT_FOUND,
        "Registration not found",
        404,
      );
    }
    if (!source.editToken) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "This registration has no self-edit link",
        404,
      );
    }
    await insertAuditLog({
      entityType: "Registration",
      entityId: id,
      action: "EDIT_LINK_ISSUED",
      performedBy,
      ipAddress: ipAddress ?? null,
    });
    const { editRegistrationLink } = buildRegistrationSelfLinks({
      registrationId: source.id,
      eventSlug: source.eventSlug,
      editToken: source.editToken,
      linkBaseUrl: source.linkBaseUrl,
    });
    return { url: editRegistrationLink };
  }

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

    // 7. Second txn — re-validate post-upload state, then persist. Resolves with
    //    the proof URL it replaced. On failure the row keeps the old proof and
    //    the new object is removed.
    const replacedUrl = await withTxn(async (tx) => {
      const currentReg = await findRegistrationWithFormEvent(registrationId, tx);
      if (!currentReg) {
        throw new AppException(ErrorCodes.NOT_FOUND, "Registration not found", 404);
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

      await this.audit(tx, {
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

  // ==========================================================================
  // Select payment method (public) — CASH / LAB_SPONSORSHIP; stays PENDING
  // ==========================================================================

  async selectPaymentMethod(
    registrationId: string,
    input: SelectPaymentMethodInput,
  ): Promise<void> {
    await withTxn(async (tx) => {
      const registration = await findRegistrationWithFormEvent(registrationId, tx);
      if (!registration) {
        throw new AppException(ErrorCodes.NOT_FOUND, "Registration not found", 404);
      }
      assertEventAcceptsPublicActions(registration.event);
      assertModuleEnabledForClient(
        registration.event.client as ClientModuleState,
        "registrations",
      );

      if (
        input.paymentMethod === "LAB_SPONSORSHIP" &&
        (registration.event.client.enabledModules ?? []).includes("sponsorships")
      ) {
        throw new AppException(
          ErrorCodes.BAD_REQUEST,
          "Lab sponsorship payment method is only available when sponsorships are disabled",
          400,
        );
      }

      if (registration.paymentStatus !== "PENDING") {
        throw new AppException(
          ErrorCodes.REGISTRATION_INVALID_STATUS,
          "Payment method can only be selected for pending registrations",
          400,
        );
      }

      const nextLabName =
        input.paymentMethod === "LAB_SPONSORSHIP" ? (input.labName ?? null) : null;
      const changes: Record<string, { old: unknown; new: unknown }> = {
        paymentMethod: { old: registration.paymentMethod, new: input.paymentMethod },
      };
      if (nextLabName !== registration.labName) {
        changes.labName = { old: registration.labName, new: nextLabName };
      }

      await applyRegistrationSettlement(tx, {
        registrationId,
        settlement: { paymentStatus: "PENDING" },
        fields: { paymentMethod: input.paymentMethod, labName: nextLabName },
      });

      await this.audit(tx, {
        entityId: registrationId,
        action: "PAYMENT_METHOD_SELECTED",
        changes,
        performedBy: "PUBLIC",
      });
    });
  }

  // ==========================================================================
  // Audit-log + email-log subroutes (paginated reads)
  // ==========================================================================

  async listRegistrationAuditLogs(
    registrationId: string,
    query: ListRegistrationAuditLogsQuery,
  ): Promise<PaginatedResult<RegistrationAuditLog>> {
    const { page, limit } = query;
    const skip = getSkip({ page, limit });
    const { rows, total } = await listRegistrationAuditLogRows(registrationId, {
      skip,
      limit,
    });

    const userIds = [
      ...new Set(
        rows
          .map((l) => l.performedBy)
          .filter(
            (id): id is string =>
              id !== null && id !== "SYSTEM" && id !== "PUBLIC",
          ),
      ),
    ];
    const users = await findUserNamesByIds(userIds);
    const userMap = new Map(users.map((u) => [u.id, u.name]));

    const enriched: RegistrationAuditLog[] = rows.map((log) => ({
      id: log.id,
      action: log.action as RegistrationAuditLog["action"],
      changes: log.changes as RegistrationAuditLog["changes"],
      performedBy: log.performedBy,
      performedByName:
        log.performedBy === "SYSTEM"
          ? "System"
          : log.performedBy === "PUBLIC"
            ? "Registrant (Self-Edit)"
            : (userMap.get(log.performedBy ?? "") ?? null),
      performedAt: log.performedAt.toISOString(),
      ipAddress: log.ipAddress,
    }));

    return paginate(enriched, total, { page, limit });
  }

  async listRegistrationEmailLogs(
    registrationId: string,
    query: ListRegistrationEmailLogsQuery,
  ): Promise<PaginatedResult<RegistrationEmailLog>> {
    const { page, limit } = query;
    const skip = getSkip({ page, limit });
    const { rows, total } = await listRegistrationEmailLogRows(registrationId, {
      skip,
      limit,
    });

    const enriched: RegistrationEmailLog[] = rows.map((log) => ({
      id: log.id,
      subject: log.subject,
      status: log.status as RegistrationEmailLog["status"],
      trigger: log.trigger as RegistrationEmailLog["trigger"],
      templateName: log.templateName,
      errorMessage: log.errorMessage,
      queuedAt: log.queuedAt.toISOString(),
      sentAt: log.sentAt?.toISOString() ?? null,
      deliveredAt: log.deliveredAt?.toISOString() ?? null,
      openedAt: log.openedAt?.toISOString() ?? null,
      clickedAt: log.clickedAt?.toISOString() ?? null,
      bouncedAt: log.bouncedAt?.toISOString() ?? null,
      failedAt: log.failedAt?.toISOString() ?? null,
    }));

    return paginate(enriched, total, { page, limit });
  }
}
