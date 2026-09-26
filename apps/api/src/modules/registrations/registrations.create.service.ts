import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  type AppEvent,
  type PriceBreakdown,
  type CreateRegistrationInput,
  type AdminCreateRegistrationInput,
} from "@app/contracts";
import {
  calculateDiscountAmount,
  calculateSettlement,
  isFullySettled,
  normalizeSponsorshipCode,
} from "@app/shared";
import {
  withLockingTxn,
  settleRegistrationTxn,
  claimSponsorshipCodeTxn,
  linkSponsorshipUsageTxn,
  emitSettlementEvents,
  findFormById,
  findActiveRegistrationFormById,
  pgUniqueViolation,
  type DbExecutor,
  getEventForRegistrationCreate,
  getEventForRegistrationAdmin,
  findRegistrationFormForEvent,
  getRegistrationFormSchemaForEvent,
  registrationExistsByEmailForm,
  insertRegistrationRow,
  allocateReferenceNumber,
  insertAuditLog,
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
import { RegistrationSideEffects } from "./registrations.side-effects";
import { assertValidSelections } from "./registrations.guards";
import { type RegistrationWithRelations } from "./registrations.enrichment";
import {
  toAdminRegistration,
  toPublicRegistration,
  type PublicRegistration,
} from "./registrations.mappers";
import {
  getEnrichedRow,
  getRegistrationByIdempotencyKey,
  normalizeEmail,
  type AdminRegistration,
} from "./registrations.shared";

const EDIT_TOKEN_BYTES = 32; // 64 hex characters

function generateEditToken(): string {
  return randomBytes(EDIT_TOKEN_BYTES).toString("hex");
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

export type PublicCreateResult = {
  created: boolean;
  registration: PublicRegistration;
  priceBreakdown: PriceBreakdown;
};

/**
 * The registration creates: the public signup (idempotency, form and module
 * gates, pricing, signup sponsorship-code consumption) and the admin create.
 */
@Injectable()
export class RegistrationCreateService {
  constructor(
    private readonly access: AccessService,
    private readonly pricing: PricingService,
    @Inject(CONFIG) private readonly config: Config,
    private readonly sideEffects: RegistrationSideEffects,
  ) {}

  // ==========================================================================
  // Shared settlement helpers
  // ==========================================================================

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
      const existing = await getRegistrationByIdempotencyKey(
        input.idempotencyKey,
      );
      if (existing) {
        return {
          created: false,
          registration: toPublicRegistration(existing, { token: existing.editToken }),
          priceBreakdown: existing.priceBreakdown,
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
        priceBreakdown: created.priceBreakdown,
      };
    } catch (err) {
      const { isUnique, constraint } = pgUnique(err);
      if (
        normalizedInput.idempotencyKey &&
        isUnique &&
        /idempotency/i.test(constraint)
      ) {
        const existing = await getRegistrationByIdempotencyKey(
          normalizedInput.idempotencyKey,
        );
        if (existing) {
          return {
            created: false,
            registration: toPublicRegistration(existing, { token: existing.editToken }),
            priceBreakdown: existing.priceBreakdown,
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

      await this.sideEffects.incrementEventRegistered(tx, eventId);

      const linked = sponsorship
        ? await this.consumeSponsorshipAtSignup(tx, { sponsorship, registrationId: id, eventId, grossBreakdown })
        : null;
      const paymentStatus = linked?.settled.after.paymentStatus ?? "PENDING";

      await this.sideEffects.audit(tx, {
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
      await this.sideEffects.queueNetworkingSync(tx, { id, eventId });
      await this.sideEffects.queueRegistrationCreatedEmail(tx, eventId, {
        id,
        email,
        firstName,
        lastName,
      });
      });
    } catch (err) {
      translateCreateUniqueViolation(err);
    }

    const enriched = await getEnrichedRow(createdId);
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
      // Counter writes can deadlock with an access prerequisite edit. As in
      // public creation, retry the whole transaction; side effects use outbox.
      await withLockingTxn(async (tx) => {
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
        await this.sideEffects.syncPaidCount(
          tx,
          { id, eventId, priceBreakdown },
          "PENDING",
          resolvedPaymentStatus,
        );
      }

      await this.sideEffects.incrementEventRegistered(tx, eventId);

      await this.sideEffects.audit(tx, {
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

      await this.sideEffects.queueNetworkingSync(tx, { id, eventId });
      if (sendEmail) {
        await this.sideEffects.queueRegistrationCreatedEmail(tx, eventId, {
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

    return toAdminRegistration(await getEnrichedRow(createdId));
  }
}
