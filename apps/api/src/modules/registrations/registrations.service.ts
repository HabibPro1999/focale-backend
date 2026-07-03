import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { fileTypeFromBuffer } from "file-type";
import { getStorageProvider, compressFile } from "@app/integrations";
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
  calculateSettlement,
  getSkip,
  paginate,
  validateFormData,
  sanitizeFormData,
  type PaginatedResult,
  type FormSchema,
} from "@app/shared";
import {
  withTxn,
  enqueueRealtimeOutboxEvent,
  enqueueTriggeredEmailOutbox,
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
  type DbExecutor,
  // registrations-owned primitives
  getRegistrationByIdRow,
  getRegistrationByIdempotencyKeyRow,
  getRegistrationClientId as getRegistrationClientIdQuery,
  getRegistrationEditToken,
  listRegistrationRows,
  getEventForRegistrationCreate,
  getEventForRegistrationAdmin,
  findRegistrationFormForEvent,
  registrationExistsByEmailForm,
  findRegistrationForMutation,
  findRegistrationWithFormEvent,
  insertRegistrationRow,
  updateRegistrationRow,
  deleteRegistrationRow,
  casUpdateRegistrationByUpdatedAt,
  findRegistrationUsagesForRecalc,
  findRegistrationUsageLinks,
  deleteRegistrationUsages,
  generateReferenceNumber,
  insertRegistrationAuditLog,
  listRegistrationAuditLogRows,
  findUserNamesByIds,
  listRegistrationEmailLogRows,
  type RegistrationPatch,
} from "@app/db";
import { AccessService } from "../access/access.service";
import { PricingService } from "../pricing/pricing.service";
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
import { AppException } from "./app-exception";
import { validatePaymentTransition } from "./payment-transitions";
import { getRegistrationTableColumns } from "./table-columns";
import {
  calculateDiscountAmount,
  enrichWithAccessSelections,
  enrichManyWithAccessSelections,
  type RegistrationWithRelations,
} from "./registrations.enrichment";

const FULLY_SETTLED_STATUSES = ["PAID", "SPONSORED", "WAIVED"];
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

/**
 * Extract a storage key from a stored payment-proof URL. Handles bare keys
 * (no "://"), Firebase (storage.googleapis.com → strip bucket segment), and
 * R2/custom-domain URLs (strip leading "/"). Returns null on parse failure.
 * Ported verbatim; drives the admin signed-URL redirect + old-proof cleanup.
 */
export function extractKeyFromUrl(url: string): string | null {
  if (!url.includes("://")) {
    return url || null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "storage.googleapis.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      return decodeURIComponent(parts.slice(1).join("/"));
    }
    return decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    return null;
  }
}

function pgUnique(err: unknown): { isUnique: boolean; constraint: string } {
  const e = err as { code?: string; constraint?: string };
  return { isUnique: e?.code === "23505", constraint: e?.constraint ?? "" };
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
}

interface SettlementResult {
  priceBreakdown: PriceBreakdown;
  sponsorshipAmount: number;
  paymentStatus?: "PENDING" | "PARTIAL" | "SPONSORED";
  paidAt?: Date | null;
  coveredAccessIds: Set<string>;
}

export type GetRegistrationForEditResult = {
  registration: Record<string, unknown>;
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
  registration: RegistrationWithRelations;
  priceBreakdown: PriceBreakdown;
};

export type PublicCreateResult = {
  created: boolean;
  registration: Record<string, unknown>;
  priceBreakdown: PriceBreakdown;
};

@Injectable()
export class RegistrationsService {
  constructor(
    private readonly access: AccessService,
    private readonly pricing: PricingService,
  ) {}

  // ==========================================================================
  // Shared side-effect + settlement helpers
  // ==========================================================================

  private emitEvents(exec: DbExecutor, events: AppEvent[]): Promise<unknown> {
    return Promise.all(events.map((ev) => enqueueRealtimeOutboxEvent(exec, ev)));
  }

  private queueRegistrationCreatedEmail(
    exec: DbExecutor,
    eventId: string,
    registration: {
      id: string;
      email: string;
      firstName?: string | null;
      lastName?: string | null;
    },
  ): Promise<boolean> {
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
  ): Promise<SettlementResult> {
    const usages = await findRegistrationUsagesForRecalc(registration.id, exec);
    const accessTypeIds = priceBreakdown.accessItems.map((i) => i.accessId);
    const coveredAccessIds = new Set<string>();
    let sponsorshipAmount = 0;

    if (usages.length === 0) {
      return {
        priceBreakdown,
        sponsorshipAmount: priceBreakdown.sponsorshipTotal,
        coveredAccessIds,
      };
    }

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
      registration.paymentStatus === "PAID" ||
      registration.paymentStatus === "WAIVED" ||
      registration.paymentStatus === "REFUNDED"
    ) {
      return result;
    }

    if (sponsorshipAmount >= priceBreakdown.subtotal && priceBreakdown.subtotal > 0) {
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
    return insertRegistrationAuditLog(
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

  async getRegistrationById(id: string): Promise<RegistrationWithRelations | null> {
    const row = await getRegistrationByIdRow(id);
    if (!row) return null;
    const enriched = await enrichWithAccessSelections(row);
    // M23: strip editToken from admin-facing reads.
    const { editToken: _editToken, ...safe } = enriched;
    return safe as RegistrationWithRelations;
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
  ): Promise<PaginatedResult<RegistrationWithRelations> & { stats: RegistrationStats }> {
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

    const enriched = await enrichManyWithAccessSelections(rows);
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
          registration: this.withToken(existing),
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

    // 4. Form-data validation → sanitized/coerced data persisted (never raw).
    const validation = validateFormData(form.schema as FormSchema, input.formData);
    if (!validation.valid) {
      throw new AppException(
        ErrorCodes.FORM_VALIDATION_ERROR,
        "Form validation failed",
        400,
        { fieldErrors: validation.errors },
      );
    }
    const sanitizedFormData =
      validation.data ?? sanitizeFormData(form.schema as FormSchema, input.formData);
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
        registration: this.withToken(created),
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
            registration: this.withToken(existing),
            priceBreakdown: existing.priceBreakdown as PriceBreakdown,
          };
        }
      }
      throw err;
    }
  }

  /** { ...registration, token: editToken } — the public shape. */
  private withToken(reg: RegistrationWithRelations): Record<string, unknown> {
    return { ...reg, token: reg.editToken };
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
      const referenceNumber = await generateReferenceNumber(eventId, tx);

      const { id } = await insertRegistrationRow(
        {
          formId,
          eventId,
          formData,
          formSchemaVersion: form.schemaVersion ?? 1,
          email,
          firstName: firstName ?? null,
          lastName: lastName ?? null,
          phone: phone ?? null,
          referenceNumber,
          paymentStatus: "PENDING",
          paymentMethod: paymentMethod ?? null,
          labName: paymentMethod === "LAB_SPONSORSHIP" ? (labName ?? null) : null,
          totalAmount: priceBreakdown.total,
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
          totalAmount: { old: null, new: priceBreakdown.total },
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
      await this.emitEvents(tx, pending);
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

  private async getStrippedById(id: string): Promise<RegistrationWithRelations> {
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

    const form = await findRegistrationFormForEvent(eventId);
    if (!form) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "No registration form found for this event",
        404,
      );
    }

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
      const referenceNumber = await generateReferenceNumber(eventId, tx);
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
          paidAt: FULLY_SETTLED_STATUSES.includes(resolvedPaymentStatus)
            ? new Date()
            : null,
          paymentMethod: paymentMethod ?? null,
          labName: paymentMethod === "LAB_SPONSORSHIP" ? (labName ?? null) : null,
          totalAmount: priceBreakdown.total,
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

      if (FULLY_SETTLED_STATUSES.includes(resolvedPaymentStatus)) {
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
          totalAmount: { old: null, new: priceBreakdown.total },
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

    return this.getEnrichedRow(createdId);
  }

  // ==========================================================================
  // Admin partial update (payment/note/role)
  // ==========================================================================

  async updateRegistration(
    id: string,
    input: UpdateRegistrationInput,
    performedBy?: string,
  ): Promise<RegistrationWithRelations> {
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

      const patch: RegistrationPatch = {};
      if (input.paymentStatus !== undefined) {
        validatePaymentTransition(registration.paymentStatus, input.paymentStatus);
        patch.paymentStatus = input.paymentStatus;
        if (
          FULLY_SETTLED_STATUSES.includes(input.paymentStatus) &&
          !registration.paidAt
        ) {
          patch.paidAt = new Date();
        }
      }
      if (input.paidAmount !== undefined) {
        if (input.paidAmount > registration.totalAmount) {
          throw new AppException(
            ErrorCodes.BAD_REQUEST,
            "Paid amount cannot exceed registration total",
            400,
          );
        }
        patch.paidAmount = input.paidAmount;
      }
      if (input.paymentMethod !== undefined) patch.paymentMethod = input.paymentMethod;
      if (input.paymentReference !== undefined)
        patch.paymentReference = input.paymentReference;
      if (input.paymentProofUrl !== undefined)
        patch.paymentProofUrl = input.paymentProofUrl;
      if (input.note !== undefined) patch.note = input.note;
      if (input.role !== undefined) patch.role = input.role;

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
        input.paidAmount !== undefined &&
        input.paidAmount !== registration.paidAmount
      ) {
        changes.paidAmount = { old: registration.paidAmount, new: input.paidAmount };
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

      await updateRegistrationRow(id, patch, tx);

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

      const becameSettled =
        statusChanged &&
        FULLY_SETTLED_STATUSES.includes(input.paymentStatus as string) &&
        !FULLY_SETTLED_STATUSES.includes(registration.paymentStatus);
      const clientId = registration.event.clientId;
      const pending: AppEvent[] = [
        {
          type: becameSettled ? "registration.paymentConfirmed" : "registration.updated",
          clientId,
          eventId: registration.eventId,
          payload: {
            id,
            paymentStatus: input.paymentStatus ?? registration.paymentStatus,
          },
          ts: Date.now(),
        },
      ];
      if (statusChanged) {
        pending.push({
          type: "eventAccess.countsChanged",
          clientId,
          eventId: registration.eventId,
          payload: { id: registration.eventId, accessIds: [] },
          ts: Date.now(),
        });
      }
      await this.emitEvents(tx, pending);
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
  ): Promise<RegistrationWithRelations> {
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

      const patch: RegistrationPatch = {};
      const changes: Record<string, { old: unknown; new: unknown }> = {};

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
        patch.email = inputEmail;
        changes.email = { old: registration.email, new: inputEmail };
      }
      if (input.firstName !== undefined && input.firstName !== registration.firstName) {
        patch.firstName = input.firstName;
        changes.firstName = { old: registration.firstName, new: input.firstName };
      }
      if (input.lastName !== undefined && input.lastName !== registration.lastName) {
        patch.lastName = input.lastName;
        changes.lastName = { old: registration.lastName, new: input.lastName };
      }
      if (input.phone !== undefined && input.phone !== registration.phone) {
        patch.phone = input.phone;
        changes.phone = { old: registration.phone, new: input.phone };
      }
      if (input.formData !== undefined) {
        patch.formData = input.formData;
        changes.formData = { old: "(previous)", new: "(updated)" };
      }
      if (input.role !== undefined && input.role !== registration.role) {
        patch.role = input.role;
        changes.role = { old: registration.role, new: input.role };
      }
      if (input.note !== undefined && input.note !== registration.note) {
        patch.note = input.note;
        changes.note = { old: registration.note, new: input.note };
      }

      // Payment fields — NO transition validation (admin override).
      if (
        input.paymentStatus !== undefined &&
        input.paymentStatus !== registration.paymentStatus
      ) {
        patch.paymentStatus = input.paymentStatus;
        changes.paymentStatus = {
          old: registration.paymentStatus,
          new: input.paymentStatus,
        };
        if (
          FULLY_SETTLED_STATUSES.includes(input.paymentStatus) &&
          !registration.paidAt
        ) {
          patch.paidAt = new Date();
        }
      }
      if (
        input.paidAmount !== undefined &&
        input.paidAmount !== registration.paidAmount
      ) {
        if (input.paidAmount > registration.totalAmount) {
          throw new AppException(
            ErrorCodes.BAD_REQUEST,
            "Paid amount cannot exceed registration total",
            400,
          );
        }
        patch.paidAmount = input.paidAmount;
        changes.paidAmount = { old: registration.paidAmount, new: input.paidAmount };
      }
      if (
        input.paymentMethod !== undefined &&
        input.paymentMethod !== registration.paymentMethod
      ) {
        patch.paymentMethod = input.paymentMethod;
        changes.paymentMethod = {
          old: registration.paymentMethod,
          new: input.paymentMethod,
        };
      }
      if (input.paymentReference !== undefined)
        patch.paymentReference = input.paymentReference;
      if (input.paymentProofUrl !== undefined)
        patch.paymentProofUrl = input.paymentProofUrl;
      if (input.labName !== undefined) patch.labName = input.labName;

      // Price-affecting edit branch.
      if (input.accessSelections !== undefined || input.formData !== undefined) {
        assertModuleEnabledForClient(
          registration.event.client as ClientModuleState,
          "pricing",
        );
        const effectiveFormData =
          input.formData ??
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

        const settlement = await this.recalculateLinkedSponsorshipSettlement(
          tx,
          registration,
          priceBreakdown,
        );
        priceBreakdown = settlement.priceBreakdown;

        const nextPaymentStatus =
          input.paymentStatus ??
          settlement.paymentStatus ??
          registration.paymentStatus;
        const nextPaidAmount = input.paidAmount ?? registration.paidAmount;
        if (nextPaidAmount > priceBreakdown.total) {
          throw new AppException(
            ErrorCodes.BAD_REQUEST,
            "Paid amount cannot exceed registration total",
            400,
          );
        }

        patch.totalAmount = priceBreakdown.total;
        patch.baseAmount = priceBreakdown.calculatedBasePrice;
        patch.accessAmount = priceBreakdown.accessTotal;
        patch.discountAmount = calculateDiscountAmount(priceBreakdown.appliedRules);
        patch.sponsorshipAmount = settlement.sponsorshipAmount;
        patch.accessTypeIds = effectiveAccessSelections.map((s) => s.accessId);
        patch.priceBreakdown = priceBreakdown;
        if (
          input.paymentStatus === undefined &&
          settlement.paymentStatus !== undefined &&
          settlement.paymentStatus !== registration.paymentStatus
        ) {
          patch.paymentStatus = settlement.paymentStatus;
          changes.paymentStatus = {
            old: registration.paymentStatus,
            new: settlement.paymentStatus,
          };
        }
        if (input.paymentStatus === undefined && settlement.paidAt !== undefined) {
          patch.paidAt = settlement.paidAt;
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
          await this.access.syncPaidCountDelta(
            eventId,
            {
              status: registration.paymentStatus,
              priceBreakdown: registration.priceBreakdown,
              coveredAccessIds: settlement.coveredAccessIds,
            },
            {
              status: nextPaymentStatus,
              priceBreakdown,
              coveredAccessIds: settlement.coveredAccessIds,
            },
            tx,
          );
        }
      }

      patch.lastEditedAt = new Date();
      await updateRegistrationRow(id, patch, tx);

      // paidCount sync for the payment-status-only path (no access/formData edit).
      if (
        input.paymentStatus !== undefined &&
        input.paymentStatus !== registration.paymentStatus &&
        input.accessSelections === undefined &&
        input.formData === undefined
      ) {
        const effectivePriceBreakdown =
          (patch.priceBreakdown as unknown) ?? registration.priceBreakdown;
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
      const becameSettled =
        statusChanged &&
        FULLY_SETTLED_STATUSES.includes(input.paymentStatus as string) &&
        !FULLY_SETTLED_STATUSES.includes(registration.paymentStatus);
      const clientId = registration.event.clientId;
      const pending: AppEvent[] = [
        {
          type: becameSettled ? "registration.paymentConfirmed" : "registration.updated",
          clientId,
          eventId,
          payload: {
            id,
            paymentStatus: input.paymentStatus ?? registration.paymentStatus,
          },
          ts: Date.now(),
        },
      ];
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
      await this.emitEvents(tx, pending);
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
      await this.emitEvents(tx, pending);
    });
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

    const { editToken: _t, ...regRest } = registration;
    const publicEvent = {
      id: registration.event.id,
      name: registration.event.name,
      slug: registration.event.slug,
      clientId: registration.event.clientId,
      status: registration.event.status,
      endDate: registration.event.endDate,
    };

    return {
      registration: { ...regRest, event: publicEvent, accessSelections },
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
        const validation = validateFormData(
          current.form.schema as FormSchema,
          newFormData,
        );
        if (!validation.valid) {
          throw new AppException(
            ErrorCodes.FORM_VALIDATION_ERROR,
            "Form validation failed",
            400,
            { fieldErrors: validation.errors },
          );
        }
        newFormData =
          validation.data ??
          sanitizeFormData(current.form.schema as FormSchema, newFormData);
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

      if (isAccessEdit && accessDeltas.some((c) => c.delta > 0)) {
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

      const settlement = await this.recalculateLinkedSponsorshipSettlement(
        tx,
        current,
        newPriceBreakdown,
      );
      newPriceBreakdown = settlement.priceBreakdown;
      const nextPaymentStatus = settlement.paymentStatus ?? current.paymentStatus;
      const nextPaidAt =
        settlement.paymentStatus !== undefined ? settlement.paidAt ?? null : current.paidAt;

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
            coveredAccessIds: settlement.coveredAccessIds,
          },
          tx,
        );
      }

      const newTotalAmount = currentIsPaid
        ? Math.max(current.totalAmount, newPriceBreakdown.total)
        : newPriceBreakdown.total;

      const affected = await casUpdateRegistrationByUpdatedAt(
        registrationId,
        expectedUpdatedAt,
        {
          formData: newFormData,
          firstName: input.firstName ?? current.firstName,
          lastName: input.lastName ?? current.lastName,
          phone: input.phone ?? current.phone,
          totalAmount: newTotalAmount,
          priceBreakdown: newPriceBreakdown,
          baseAmount: newPriceBreakdown.calculatedBasePrice,
          accessAmount: newPriceBreakdown.accessTotal,
          discountAmount: calculateDiscountAmount(newPriceBreakdown.appliedRules),
          sponsorshipAmount: settlement.sponsorshipAmount,
          paymentStatus: nextPaymentStatus as never,
          paidAt: nextPaidAt,
          accessTypeIds: newAccessSelections.map((s) => s.accessId),
          lastEditedAt: new Date(),
        },
        tx,
      );

      if (affected === 0) {
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
      await this.emitEvents(tx, pending);
    });

    const registration = await this.getStrippedById(registrationId);
    return { registration, priceBreakdown: newPriceBreakdown };
  }

  // ==========================================================================
  // Confirm payment (admin) — strict transition; response KEEPS editToken
  // ==========================================================================

  async confirmPayment(
    id: string,
    input: UpdatePaymentInput,
    performedBy?: string,
    ipAddress?: string,
  ): Promise<RegistrationWithRelations> {
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

      const effectivePaidAmount = input.paidAmount ?? old.totalAmount;
      if (effectivePaidAmount > old.totalAmount) {
        throw new AppException(
          ErrorCodes.BAD_REQUEST,
          "Paid amount cannot exceed registration total",
          400,
        );
      }
      // ponytail: legacy logger.warn on partial-amount confirm dropped (non-behavioral).

      const newStatus = input.paymentStatus;
      const nextPaidAmount = input.paidAmount ?? old.totalAmount;
      const nextPaymentMethod = input.paymentMethod ?? old.paymentMethod;
      const patch: RegistrationPatch = {
        paymentStatus: newStatus,
        paidAmount: nextPaidAmount,
        paymentMethod: nextPaymentMethod,
        paymentReference: input.paymentReference ?? old.paymentReference,
        paymentProofUrl: input.paymentProofUrl ?? old.paymentProofUrl,
      };
      if (FULLY_SETTLED_STATUSES.includes(newStatus)) {
        patch.paidAt = new Date();
      }
      await updateRegistrationRow(id, patch, tx);

      await insertRegistrationAuditLog(
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

      const wasSettled = FULLY_SETTLED_STATUSES.includes(old.paymentStatus);
      const isSettled = FULLY_SETTLED_STATUSES.includes(input.paymentStatus);
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
      await this.emitEvents(tx, pending);

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

    // Fresh read — editToken intentionally NOT stripped (legacy asymmetry).
    return this.getEnrichedRow(id);
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
    const key = `${registration.eventId}/${registrationId}/proof.${compressed.ext}`;
    const storage = getStorageProvider();

    // 6. Best-effort delete of any old proof.
    if (registration.paymentProofUrl) {
      try {
        const oldKey = extractKeyFromUrl(registration.paymentProofUrl);
        if (oldKey) await storage.delete(oldKey);
      } catch {
        // ponytail: legacy logger.warn on old-proof delete failure dropped (non-blocking).
      }
    }

    // 7. Private upload (signed-URL access only).
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

    // 8. Second txn — re-validate post-upload state, then persist.
    await withTxn(async (tx) => {
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

      await updateRegistrationRow(
        registrationId,
        {
          paymentProofUrl: fileUrl,
          paymentStatus: "VERIFYING",
          paymentMethod: "BANK_TRANSFER",
        },
        tx,
      );

      await this.audit(tx, {
        entityId: registrationId,
        action: "PAYMENT_PROOF_UPLOADED",
        changes: {
          paymentStatus: { old: registration.paymentStatus, new: "VERIFYING" },
          paymentProofUrl: { old: registration.paymentProofUrl, new: fileUrl },
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

      await updateRegistrationRow(
        registrationId,
        {
          paymentMethod: input.paymentMethod,
          paymentStatus: "PENDING",
          labName: nextLabName,
        },
        tx,
      );

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
