import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
  calculateDiscountAmount,
  calculateSettlement,
  getSkip,
  isFullySettled,
  normalizeSponsorshipCode,
  paginate,
  type PaginatedResult,
} from "@app/shared";
import {
  withTxn,
  withLockingTxn,
  lockRegistrationForUpdate,
  lockRegistrationSponsorships,
  releaseRegistrationUsagesTxn,
  settleRegistrationTxn,
  claimSponsorshipCodeTxn,
  linkSponsorshipUsageTxn,
  syncNetworkingRegistration,
  enqueueTriggeredEmailOutbox,
  applyRegistrationSettlement,
  emitSettlementEvents,
  settlementEventPair,
  casIncrementRegisteredTx,
  casDecrementRegisteredTx,
  getEventCounterInfoTx,
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
  allocateReferenceNumber,
  insertAuditLog,
  listRegistrationAuditLogRows,
  findUserNamesByIds,
  listRegistrationEmailLogRows,
  type RegistrationFieldsPatch,
  type RegistrationSettlementWrite,
  type SettleRegistrationOptions,
  type SettleRegistrationResult,
  type LinkableSponsorship,
} from "@app/db";
import { AccessService, toAccessAppException } from "../access/access.service";
import { PricingService } from "../pricing/pricing.service";
import { prepareFormDataForPricing } from "../pricing/form-data-for-pricing";
import {
  assertEventAcceptsPublicActions,
  assertEventWritable,
} from "../events";
import {
  assertClientModuleEnabled,
  assertModuleEnabledForClient,
  type ClientModuleState,
} from "../clients/module-gates";
import { AppException } from "../../core/app-exception";
import { CONFIG, type Config } from "../../core/config";
import { assertPublicLinkBaseUrlAllowed } from "../../core/public-link-origin";
import { logger } from "../../core/logger.service";
import {
  validateAdminPaymentOverride,
  validatePaymentTransition,
} from "./payment-transitions";
import { getRegistrationTableColumns } from "./table-columns";
import { assertSelfEditAllowed, evaluateEditPolicy } from "./edit-policy";
import {
  assertPaidAmountWithinNet,
  assertPaidInFull,
  assertValidSelections,
  netOf,
} from "./registrations.guards";
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
 * carry it): email+form unique violation → REGISTRATION_ALREADY_EXISTS, a
 * signup code already stored on another registration (the partial unique index
 * that follows plan 2.7) → SPONSORSHIP_CODE_ALREADY_USED, any other unique
 * violation → RES_3002. Idempotency-key violations are RE-THROWN untouched
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
  if (/sponsorship_code/i.test(constraint)) {
    throw new AppException(
      ErrorCodes.SPONSORSHIP_CODE_ALREADY_USED,
      "This sponsorship code has already been used",
      409,
    );
  }
  throw new AppException(ErrorCodes.CONFLICT, "Resource already exists", 409);
}

/**
 * Per access item, how the selected quantity changes from `before` to
 * `after` (items listed twice are summed). Unchanged items are left out; the
 * rest are in ascending access id order, so concurrent edits take the
 * access rows in the same order.
 */
function accessQuantityDeltas(
  before: ReadonlyArray<{ accessId: string; quantity: number }>,
  after: ReadonlyArray<{ accessId: string; quantity: number }>,
): Array<{ accessId: string; delta: number }> {
  const deltas = new Map<string, number>();
  for (const item of before) deltas.set(item.accessId, (deltas.get(item.accessId) ?? 0) - item.quantity);
  for (const item of after) deltas.set(item.accessId, (deltas.get(item.accessId) ?? 0) + item.quantity);
  return [...deltas]
    .filter(([, delta]) => delta !== 0)
    .map(([accessId, delta]) => ({ accessId, delta }))
    .sort((a, b) => (a.accessId < b.accessId ? -1 : a.accessId > b.accessId ? 1 : 0));
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

  /**
   * Reprice a registration under its lock (plan 2.6), for the admin and the
   * public edit:
   * - price the answers and selections without sponsorship codes: the
   *   sponsorship comes from the linked usages, recomputed by the settlement.
   *   Without usages, the amount priced at signup (an unlinked code) is kept,
   *   capped at the new subtotal;
   * - move the access registered counters by the quantity delta (before the
   *   settlement, whose paid places they are checked against);
   * - settle: `decide` sees the new net and may refuse it or set the status
   *   and paid amount, otherwise the status is derived. Paid places move by
   *   the old → new delta and the breakdown, amounts and `fields` are
   *   written in one update;
   * - drop items that became full from unsettled registrations.
   */
  private async repriceRegistration(
    tx: DbExecutor,
    current: {
      id: string;
      eventId: string;
      totalAmount: number;
      sponsorshipAmount: number;
      priceBreakdown: unknown;
    },
    input: {
      formData: Record<string, unknown>;
      accessSelections: Array<{ accessId: string; quantity: number }>;
      /** Keep total_amount at least its stored value (payment received). */
      keepHigherTotal?: boolean;
      decide: NonNullable<SettleRegistrationOptions["decide"]>;
      fields: RegistrationFieldsPatch;
    },
  ): Promise<{
    settled: SettleRegistrationResult;
    accessDeltas: Array<{ accessId: string; delta: number }>;
  }> {
    const stored = current.priceBreakdown as PriceBreakdown | null;
    const priced = await this.pricing.calculatePrice(
      current.eventId,
      {
        formData: input.formData,
        selectedAccessItems: input.accessSelections.map((s) => ({
          accessId: s.accessId,
          quantity: s.quantity,
        })),
        sponsorshipCodes: [],
      },
      tx,
    );
    const priceBreakdown: PriceBreakdown = {
      ...priced,
      sponsorships: stored?.sponsorships ?? [],
      sponsorshipTotal: current.sponsorshipAmount,
    };

    const accessDeltas = accessQuantityDeltas(stored?.accessItems ?? [], input.accessSelections);
    for (const { accessId, delta } of accessDeltas) {
      if (delta > 0) {
        await this.access.incrementAccessRegisteredCountTx(accessId, delta, tx);
      } else {
        await this.access.decrementAccessRegisteredCountTx(accessId, -delta, tx);
      }
    }

    const settled = await settleRegistrationTxn(tx, current.id, {
      priceBreakdown,
      totalAmount: input.keepHigherTotal
        ? Math.max(current.totalAmount, priced.subtotal)
        : priced.subtotal,
      decide: input.decide,
      fields: input.fields,
    }).catch((err: unknown) => {
      throw toAccessAppException(err);
    });
    if (!settled) {
      throw new AppException(
        ErrorCodes.REGISTRATION_NOT_FOUND,
        "Registration not found",
        404,
      );
    }
    await this.access.handleCapacityReached(
      current.eventId,
      settled.paidAccess.incremented,
      tx,
    );
    return { settled, accessDeltas };
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

    // One stat row per payment status. `amountDue` is summed per registration
    // with the settlement math (net − paid, at least 0); refunded money is
    // not counted as collected.
    const stats: RegistrationStats = {
      total: 0,
      totalAmount: 0,
      collected: 0,
      paid: { count: 0, amount: 0 },
      pending: { count: 0, amount: 0 },
      sponsored: { count: 0, amount: 0 },
    };
    for (const row of statsRaw) {
      const count = row.cnt;
      stats.total += count;
      stats.totalAmount += row.totalAmount;
      if (row.paymentStatus !== "REFUNDED") stats.collected += row.paidAmount;
      if (row.paymentStatus === "PAID") {
        stats.paid = { count, amount: row.paidAmount };
      } else if (
        row.paymentStatus === "PENDING" ||
        row.paymentStatus === "VERIFYING" ||
        row.paymentStatus === "PARTIAL"
      ) {
        stats.pending.count += count;
        stats.pending.amount += row.amountDue;
      } else if (
        row.paymentStatus === "SPONSORED" ||
        row.paymentStatus === "WAIVED"
      ) {
        stats.sponsored.count += count;
        stats.sponsored.amount += row.totalAmount;
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

    // 5. Price calculation, without the sponsorship code: the code is
    //    consumed and priced under its lock in createRegistration (plan 2.7).
    const calculated = await this.pricing.calculatePrice(form.eventId, {
      formData: sanitizedFormData,
      selectedAccessItems: (normalizedInput.accessSelections ?? []).map((s) => ({
        accessId: s.accessId,
        quantity: s.quantity,
      })),
      sponsorshipCodes: [],
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
        priceBreakdown: created.priceBreakdown as PriceBreakdown,
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

  /**
   * Create a public registration from its gross price (any sponsorship in
   * `priceBreakdown` is ignored). A sponsorship code is consumed in the same
   * transaction, in lock order sponsorship → registration → counters (plan
   * 2.7): the code's sponsorship is locked first; an unknown or cancelled
   * code → 400 INVALID_SPONSORSHIP_CODE, a used, reserved or already claimed
   * one → 409 SPONSORSHIP_CODE_ALREADY_USED. Otherwise the registration is
   * inserted, the sponsorship linked (usage + USED) and the registration
   * settled: fully covered → SPONSORED, holding paid places.
   */
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
      paymentMethod,
      labName,
      idempotencyKey,
      linkBaseUrl,
    } = input;
    const email = normalizeEmail(rawEmail);
    const sponsorshipCode = normalizeSponsorshipCode(input.sponsorshipCode);
    const grossBreakdown: PriceBreakdown = {
      ...priceBreakdown,
      sponsorships: [],
      sponsorshipTotal: 0,
      total: priceBreakdown.subtotal,
    };

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
      await assertValidSelections(this.access, eventId, accessSelections, formData);
    }

    await this.access.assertAccessSelectionRequirement(eventId, formData, accessSelections ?? [],
      (form.schema as { settings?: { accessSelectionRequired?: boolean } } | null)?.settings);

    let createdId!: string;
    try {
      await withLockingTxn(async (tx) => {
      // The sponsorship lock comes first (lock order), before any counter.
      const sponsorship = sponsorshipCode
        ? await this.claimSponsorshipCode(tx, eventId, sponsorshipCode)
        : null;

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
          totalAmount: grossBreakdown.subtotal,
          currency: grossBreakdown.currency,
          priceBreakdown: grossBreakdown,
          baseAmount: grossBreakdown.calculatedBasePrice,
          discountAmount: calculateDiscountAmount(grossBreakdown.appliedRules),
          accessAmount: grossBreakdown.accessTotal,
          sponsorshipCode,
          sponsorshipAmount: 0,
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

      const linked = sponsorship
        ? await this.consumeSponsorshipAtSignup(tx, { sponsorship, registrationId: id, eventId, grossBreakdown })
        : null;
      const paymentStatus = linked?.settled.after.paymentStatus ?? "PENDING";

      await this.audit(tx, {
        entityId: id,
        action: "CREATE",
        changes: {
          email: { old: null, new: email },
          firstName: { old: null, new: firstName ?? null },
          lastName: { old: null, new: lastName ?? null },
          totalAmount: { old: null, new: grossBreakdown.subtotal },
          ...(linked
            ? {
                sponsorshipCode: { old: null, new: sponsorshipCode },
                sponsorshipAmount: { old: null, new: linked.settled.after.sponsorshipAmount },
                paymentStatus: { old: null, new: paymentStatus },
              }
            : {}),
        },
        performedBy: "PUBLIC",
      });
      if (linked) {
        await insertAuditLog(
          {
            entityType: "Sponsorship",
            entityId: linked.sponsorshipId,
            action: "LINK_TO_REGISTRATION",
            changes: {
              registrationId: { old: null, new: id },
              amountApplied: { old: 0, new: linked.amountApplied },
              sponsorshipAmount: { old: 0, new: linked.settled.after.sponsorshipAmount },
              status: { old: "PENDING", new: "USED" },
            },
            performedBy: "PUBLIC",
          },
          tx,
        );
      }

      const clientId = event.clientId;
      const pending: AppEvent[] = [
        {
          type: "registration.created",
          clientId,
          eventId,
          payload: { id, email, paymentStatus },
          ts: Date.now(),
        },
      ];
      if (linked) {
        pending.push({
          type: "sponsorship.linked",
          clientId,
          eventId,
          payload: { id: linked.sponsorshipId, registrationId: id },
          ts: Date.now(),
        });
      }
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

  /**
   * Lock the sponsorship of a signup code and check it can be consumed; the
   * first step of the create transaction.
   */
  private async claimSponsorshipCode(
    tx: DbExecutor,
    eventId: string,
    code: string,
  ): Promise<LinkableSponsorship> {
    const claim = await claimSponsorshipCodeTxn(tx, eventId, code);
    if (claim.outcome === "invalid") {
      throw new AppException(
        ErrorCodes.INVALID_SPONSORSHIP_CODE,
        "This sponsorship code is not valid for this event",
        400,
        { sponsorshipCode: code },
      );
    }
    if (claim.outcome === "used") {
      throw new AppException(
        ErrorCodes.SPONSORSHIP_CODE_ALREADY_USED,
        "This sponsorship code has already been used",
        409,
        { sponsorshipCode: code },
      );
    }
    return claim.sponsorship;
  }

  /**
   * Link the claimed sponsorship to the new registration and settle it
   * (usage recomputed, status derived: fully covered → SPONSORED), taking the
   * paid places that status holds.
   */
  private async consumeSponsorshipAtSignup(
    tx: DbExecutor,
    args: {
      sponsorship: LinkableSponsorship;
      registrationId: string;
      eventId: string;
      grossBreakdown: PriceBreakdown;
    },
  ): Promise<{ sponsorshipId: string; amountApplied: number; settled: SettleRegistrationResult }> {
    const { sponsorship, registrationId, eventId, grossBreakdown } = args;
    const usage = await linkSponsorshipUsageTxn(tx, {
      sponsorship,
      registrationId,
      priceBreakdown: grossBreakdown,
      appliedBy: "PUBLIC",
    });
    const settled = await settleRegistrationTxn(tx, registrationId, {
      priceBreakdown: {
        ...grossBreakdown,
        sponsorships: [
          {
            code: sponsorship.code,
            amount: Math.min(usage.amountApplied, grossBreakdown.subtotal),
            valid: true,
          },
        ],
      },
      coveredAccessIdsBefore: [],
    }).catch((err: unknown) => {
      throw toAccessAppException(err);
    });
    if (!settled) {
      throw new Error(`Registration ${registrationId} vanished inside its create transaction`);
    }
    await this.access.handleCapacityReached(eventId, settled.paidAccess.incremented, tx);
    return { sponsorshipId: sponsorship.id, amountApplied: usage.amountApplied, settled };
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
      await assertValidSelections(this.access, eventId, accessSelections, formData);
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
    // An empty body changes nothing: return the registration as it is, with
    // no write, audit row or event.
    if (Object.values(input).every((value) => value === undefined)) {
      const current = await this.getRegistrationById(id);
      if (!current) {
        throw new AppException(
          ErrorCodes.REGISTRATION_NOT_FOUND,
          "Registration not found",
          404,
        );
      }
      return current;
    }

    // Lock first so a concurrent confirmation or proof upload cannot be
    // overwritten from a stale read (ADR 0001).
    await withLockingTxn(async (tx) => {
      const locked = await lockRegistrationForUpdate(tx, id);
      const registration = locked
        ? await findRegistrationForMutation(id, tx)
        : null;
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
        assertPaidAmountWithinNet(paidAmount, calculateSettlement(registration).netAmount);
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
  // Admin full edit (override table: any status change but out of REFUNDED)
  // ==========================================================================

  async adminEditRegistration(
    eventId: string,
    id: string,
    input: AdminEditRegistrationInput,
    adminUserId: string,
  ): Promise<AdminRegistration> {
    // Lock first, then decide from the row re-read under the lock (ADR 0001):
    // a concurrent confirmation is either seen or waits for this edit.
    await withLockingTxn(async (tx) => {
      const locked = await lockRegistrationForUpdate(tx, id);
      const registration = locked
        ? await findRegistrationForMutation(id, tx)
        : null;
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

      const fields: RegistrationFieldsPatch = {};
      const changes: Record<string, { old: unknown; new: unknown }> = {};
      const hasPriceEdits =
        input.accessSelections !== undefined || input.formData !== undefined;

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

      // Payment fields — admin-override transitions (nothing leaves REFUNDED).
      const statusChange =
        input.paymentStatus !== undefined &&
        input.paymentStatus !== registration.paymentStatus
          ? input.paymentStatus
          : undefined;
      if (statusChange !== undefined) {
        validateAdminPaymentOverride(registration.paymentStatus, statusChange);
        changes.paymentStatus = { old: registration.paymentStatus, new: statusChange };
      }
      // A status newly fully settled gets a payment date; others keep theirs.
      const statusPaidAt =
        statusChange !== undefined && isFullySettled(statusChange) && !registration.paidAt
          ? new Date()
          : undefined;
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
      fields.lastEditedAt = new Date();

      let newStatus: string = statusChange ?? registration.paymentStatus;
      let movedAccessIds: string[] = [];
      if (hasPriceEdits) {
        // Price-affecting edit: reprice, then settle against the new net.
        assertModuleEnabledForClient(
          registration.event.client as ClientModuleState,
          "pricing",
        );
        const effectiveFormData =
          editedFormData ??
          (registration.formData as Record<string, unknown>) ??
          {};
        const oldAccessItems = (
          (registration.priceBreakdown as PriceBreakdown | null)?.accessItems ?? []
        ).map((item) => ({ accessId: item.accessId, quantity: item.quantity }));
        const effectiveAccessSelections = (input.accessSelections ?? oldAccessItems).map(
          (s) => ({ accessId: s.accessId, quantity: s.quantity }),
        );
        if (
          input.accessSelections !== undefined &&
          effectiveAccessSelections.length > 0
        ) {
          await assertValidSelections(this.access, eventId, effectiveAccessSelections, effectiveFormData, {
            existingAccessIds: new Set(registration.accessTypeIds ?? []),
            exec: tx,
          });
        }
        fields.accessTypeIds = effectiveAccessSelections.map((s) => s.accessId);

        const { settled, accessDeltas } = await this.repriceRegistration(tx, registration, {
          formData: effectiveFormData,
          accessSelections: effectiveAccessSelections,
          fields,
          decide: ({ before, net }) => {
            const currentNet = netOf(before);
            const netChanged = net !== currentNet;
            // A PAID registration whose price moves: the admin says how the
            // payment follows (an amount, or another status).
            if (
              before.paymentStatus === "PAID" &&
              netChanged &&
              input.paymentStatus === undefined &&
              input.paidAmount === undefined
            ) {
              throw new AppException(
                ErrorCodes.PAYMENT_ADJUSTMENT_REQUIRED,
                "This edit changes the price of a paid registration; set the paid amount or the payment status",
                409,
                { currentNet, newNet: net, paidAmount: before.paidAmount },
              );
            }
            // Setting PAID without an amount means paid in full (plan 2.1).
            const paidAmount =
              input.paidAmount ?? (input.paymentStatus === "PAID" ? net : undefined);
            const nextPaid = paidAmount ?? before.paidAmount;
            assertPaidAmountWithinNet(nextPaid, net);
            const staysPaid =
              (input.paymentStatus ?? before.paymentStatus) === "PAID";
            if (before.paymentStatus === "PAID" && netChanged && staysPaid) {
              assertPaidInFull(nextPaid, net);
            }
            // No status given: derived from the amounts (sticky statuses stay).
            return { paymentStatus: input.paymentStatus, paidAmount, paidAt: statusPaidAt };
          },
        });

        const { before, after } = settled;
        newStatus = after.paymentStatus;
        if (after.paymentStatus !== before.paymentStatus && changes.paymentStatus === undefined) {
          changes.paymentStatus = { old: before.paymentStatus, new: after.paymentStatus };
        }
        if (after.paidAmount !== before.paidAmount) {
          changes.paidAmount = { old: before.paidAmount, new: after.paidAmount };
        }
        if (input.accessSelections !== undefined) {
          changes.accessSelections = {
            old: registration.accessTypeIds ?? [],
            new: fields.accessTypeIds,
          };
        }
        changes.totalAmount = { old: before.totalAmount, new: after.totalAmount };
        movedAccessIds = [
          ...accessDeltas.map((c) => c.accessId),
          ...settled.paidAccess.incremented,
          ...settled.paidAccess.decremented,
        ];
      } else {
        // Payment-only edit: the given status and amount, validated against
        // the stored net.
        const settlement: RegistrationSettlementWrite = {};
        if (statusChange !== undefined) settlement.paymentStatus = statusChange;
        if (statusPaidAt !== undefined) settlement.paidAt = statusPaidAt;
        const net = calculateSettlement(registration).netAmount;
        // Setting PAID without an amount means paid in full (plan 2.1).
        const paidAmount =
          input.paidAmount !== undefined
            ? input.paidAmount !== registration.paidAmount
              ? input.paidAmount
              : undefined
            : input.paymentStatus === "PAID"
              ? net
              : undefined;
        if (paidAmount !== undefined) {
          assertPaidAmountWithinNet(paidAmount, net);
          settlement.paidAmount = paidAmount;
          if (paidAmount !== registration.paidAmount) {
            changes.paidAmount = { old: registration.paidAmount, new: paidAmount };
          }
        }
        await applyRegistrationSettlement(tx, { registrationId: id, settlement, fields });
        if (statusChange !== undefined) {
          await this.syncPaidCount(
            tx,
            { id, eventId, priceBreakdown: registration.priceBreakdown },
            registration.paymentStatus,
            statusChange,
          );
        }
      }

      if (Object.keys(changes).length > 0) {
        await this.audit(tx, {
          entityId: id,
          action: "UPDATE",
          changes,
          performedBy: adminUserId,
        });
      }

      const pending = settlementEventPair({
        id,
        eventId,
        clientId: registration.event.clientId,
        oldStatus: registration.paymentStatus,
        newStatus,
        emitCountsChanged: newStatus !== registration.paymentStatus || movedAccessIds.length > 0,
        accessIds: [...new Set(movedAccessIds)],
      });
      await emitSettlementEvents(tx, pending);
    });

    return this.getStrippedById(id);
  }

  // ==========================================================================
  // Delete
  // ==========================================================================

  /**
   * Admin delete. Only admins reach this: the controller's tenant check
   * (`canAccessClient`) refuses every other role, so `force` needs no extra
   * role check here.
   */
  async deleteRegistration(
    id: string,
    performedBy?: string,
    force?: boolean,
  ): Promise<void> {
    // Lock order (ADR 0001): the linked sponsorships, then the registration.
    const networkingPhoto = await withLockingTxn(async (tx) => {
      await lockRegistrationSponsorships(tx, id);
      const registration = (await lockRegistrationForUpdate(tx, id))
        ? await findRegistrationForMutation(id, tx)
        : null;
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

      // Usages go first; each sponsorship back to PENDING unless still linked
      // elsewhere, and a CANCELLED one stays CANCELLED.
      const released = await releaseRegistrationUsagesTxn(tx, id);
      const coveredAccessIds = new Set(released.coveredAccessIds);

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

    const policy = evaluateEditPolicy({
      registration,
      event: registration.event,
      now: new Date(),
    });

    const { amountDue } = calculateSettlement({
      totalAmount: registration.totalAmount,
      paidAmount: registration.paidAmount,
      sponsorshipAmount: registration.sponsorshipAmount,
    });

    return {
      registration: toPublicRegistration({ ...registration, accessSelections }),
      expectedUpdatedAt: registration.updatedAt.toISOString(),
      canEdit: policy.canEdit,
      canEditPersonalInfo: policy.canEditPersonalInfo,
      canEditAccess: policy.canEditAccess,
      canAddAccess: policy.canAddAccess,
      canRemoveAccess: policy.canRemoveAccess,
      isFullySponsored: policy.isFullySponsored,
      amountDue,
      editRestrictions: policy.restrictions,
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

    // Lock first, then decide from the row re-read under the lock (ADR 0001).
    await withLockingTxn(async (tx) => {
      const locked = await lockRegistrationForUpdate(tx, registrationId);
      const current = locked
        ? await findRegistrationWithFormEvent(registrationId, tx)
        : null;
      if (!current) {
        throw new AppException(
          ErrorCodes.REGISTRATION_NOT_FOUND,
          "Registration not found",
          404,
        );
      }

      const isAccessEdit = input.accessSelections !== undefined;
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
      const accessDeltas = accessQuantityDeltas(currentAccessItems, newAccessSelections);

      // The same policy GET-for-edit shows, enforced on the fresh row.
      const policy = evaluateEditPolicy({
        registration: current,
        event: current.event,
        now: new Date(),
      });
      assertSelfEditAllowed(policy, current.event.client as ClientModuleState, {
        changesAccess: isAccessEdit,
        removedAccessIds: accessDeltas.filter((c) => c.delta < 0).map((c) => c.accessId),
      });

      const currentFormData =
        (current.formData as Record<string, unknown> | null) ?? {};
      const newFormData = input.formData
        ? prepareFormDataForPricing(current.form.schema, {
            ...currentFormData,
            ...input.formData,
          })
        : currentFormData;
      const formDataChanged =
        input.formData !== undefined && !isDeepStrictEqual(newFormData, currentFormData);
      // Reprice only when something priced changed: a name or phone edit
      // leaves the price (and the payment status) as they are.
      const reprice = formDataChanged || accessDeltas.length > 0;

      if (reprice) {
        await assertValidSelections(this.access, current.eventId, newAccessSelections, newFormData, {
          existingAccessIds: currentAccessIds,
          exec: tx,
        });
        await this.access.assertAccessSelectionRequirement(
          current.eventId,
          newFormData,
          newAccessSelections,
          (current.form.schema as { settings?: { accessSelectionRequired?: boolean } } | null)
            ?.settings,
          tx,
        );
      }

      // Optimistic precondition from GET-for-edit, on the locked row.
      if (current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
        throw new AppException(
          ErrorCodes.CONCURRENT_MODIFICATION,
          "Registration changed. Refresh and try again.",
          409,
        );
      }

      const fields: RegistrationFieldsPatch = {
        formData: newFormData,
        firstName: input.firstName ?? current.firstName,
        lastName: input.lastName ?? current.lastName,
        phone: input.phone ?? current.phone,
        accessTypeIds: newAccessSelections.map((s) => s.accessId),
        lastEditedAt: new Date(),
      };
      let nextPaymentStatus = current.paymentStatus;
      const countsChangedIds = new Set(accessDeltas.map((c) => c.accessId));
      if (reprice) {
        const { settled } = await this.repriceRegistration(tx, current, {
          formData: newFormData,
          accessSelections: newAccessSelections,
          keepHigherTotal: policy.paymentReceived,
          fields,
          decide: ({ before, net }) => {
            // PAID means paid in full: a self-edit may not change the price.
            const currentNet = netOf(before);
            if (before.paymentStatus === "PAID" && net !== currentNet) {
              throw new AppException(
                ErrorCodes.REGISTRATION_PRICE_LOCKED,
                "This change would alter the price of a paid registration",
                409,
                { currentNet, newNet: net },
              );
            }
            return undefined;
          },
        });
        nextPaymentStatus = settled.after.paymentStatus;
        newPriceBreakdown = settled.after.priceBreakdown;
        for (const accessId of [
          ...settled.paidAccess.incremented,
          ...settled.paidAccess.decremented,
        ]) {
          countsChangedIds.add(accessId);
        }
      } else {
        await applyRegistrationSettlement(tx, { registrationId, settlement: {}, fields });
        newPriceBreakdown = currentPriceBreakdown;
      }

      const auditChanges: Record<string, { old: unknown; new: unknown }> = {};
      if (formDataChanged) {
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
      if (accessDeltas.length > 0) {
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
      if (countsChangedIds.size > 0) {
        pending.push({
          type: "eventAccess.countsChanged",
          clientId,
          eventId: current.eventId,
          payload: { id: current.eventId, accessIds: [...countsChangedIds] },
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
    // Lock first, then decide from the row re-read under the lock (ADR 0001):
    // a concurrent proof upload, method selection or admin edit waits for this
    // confirmation, or this one waits for it and sees its result.
    await withLockingTxn(async (tx) => {
      const locked = await lockRegistrationForUpdate(tx, id);
      const old = locked ? await findRegistrationForMutation(id, tx) : null;
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

      const newStatus = input.paymentStatus;
      const nextPaymentMethod = input.paymentMethod ?? old.paymentMethod;
      // Settle against the fresh breakdown: sponsorship usages recomputed, the
      // paid amount checked against that net, paid places moved by the delta.
      const settled = await settleRegistrationTxn(tx, id, {
        decide: ({ net }) => {
          const paidAmount = input.paidAmount ?? net;
          assertPaidAmountWithinNet(paidAmount, net);
          if (newStatus === "PAID") assertPaidInFull(paidAmount, net);
          return {
            paymentStatus: newStatus,
            paidAmount,
            ...(isFullySettled(newStatus) ? { paidAt: new Date() } : {}),
          };
        },
        fields: {
          paymentMethod: nextPaymentMethod,
          paymentReference: input.paymentReference ?? old.paymentReference,
          paymentProofUrl: input.paymentProofUrl ?? old.paymentProofUrl,
        },
      }).catch((err: unknown) => {
        throw toAccessAppException(err);
      });
      if (!settled) {
        throw new AppException(
          ErrorCodes.REGISTRATION_NOT_FOUND,
          "Registration not found",
          404,
        );
      }
      const nextPaidAmount = settled.after.paidAmount;
      await this.access.handleCapacityReached(
        old.eventId,
        settled.paidAccess.incremented,
        tx,
      );

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
      // Paid places can also move without a settled flip (PARTIAL with
      // sponsorship-covered items), so the moved items count too.
      const movedAccessIds = [
        ...settled.paidAccess.incremented,
        ...settled.paidAccess.decremented,
      ];
      if (wasSettled !== isSettled || movedAccessIds.length > 0) {
        const breakdown = old.priceBreakdown as PriceBreakdown;
        const accessIds = [
          ...new Set([
            ...(breakdown.accessItems?.map((a) => a.accessId) ?? []),
            ...movedAccessIds,
          ]),
        ];
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

    // 7. Second txn — lock, re-read and re-validate the post-upload state, then
    //    persist. The lock makes a concurrent confirmation either wait for this
    //    write or be seen by the re-check (PAID → VERIFYING is refused), so a
    //    confirmation is never overwritten. Resolves with the proof URL it
    //    replaced. On failure the row keeps the old proof and the new object is
    //    removed.
    const replacedUrl = await withLockingTxn(async (tx) => {
      const locked = await lockRegistrationForUpdate(tx, registrationId);
      const currentReg = locked
        ? await findRegistrationWithFormEvent(registrationId, tx)
        : null;
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
    // Lock, re-read, then re-check PENDING on the fresh row: a registration
    // confirmed (or under proof review) meanwhile is refused, never reset to
    // PENDING. The transition table alone would allow VERIFYING → PENDING.
    await withLockingTxn(async (tx) => {
      const locked = await lockRegistrationForUpdate(tx, registrationId);
      const registration = locked
        ? await findRegistrationWithFormEvent(registrationId, tx)
        : null;
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
