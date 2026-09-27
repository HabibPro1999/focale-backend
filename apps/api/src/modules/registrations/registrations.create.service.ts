import {
  ErrorCodes,
  type AdminCreateRegistrationInput,
  type AppEvent,
  type CreateRegistrationInput,
  type PriceBreakdown,
} from "@app/contracts";
import {
  findActiveRegistrationFormById,
  findFormById,
  findRegistrationFormForEvent,
  findRegistrationFormSchema,
  generateReferenceNumber,
  getEventForRegistrationAdmin,
  getEventForRegistrationCreate,
  insertRegistrationRow,
  registrationExistsByEmailForm,
  withTxn,
  type DbExecutor,
} from "@app/db";
import { calculateSettlement, isFullySettled } from "@app/shared";
import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { badRequest, conflict, notFound, orNotFound } from "../../core/app-exception";
import { CONFIG, type Config } from "../../core/config";
import { assertPublicLinkBaseUrlAllowed } from "../../core/public-link-origin";
import { AccessService } from "../access/access.service";
import { assertClientModuleEnabled, assertModuleEnabledForClient } from "../clients/module-gates";
import { assertEventAcceptsPublicActions, assertEventWritable } from "../events";
import { prepareFormDataForPricing } from "../pricing/form-data-for-pricing";
import { PricingService } from "../pricing/pricing.service";
import { breakdownColumns, type RegistrationWithRelations } from "./registrations.enrichment";
import {
  assertLabSponsorshipAllowed,
  normalizeEmail,
  pgUnique,
  registrationAlreadyExists,
  translateCreateUniqueViolation,
} from "./registrations.guards";
import { toAdminRegistration, toPublicRegistration, type PublicRegistration } from "./registrations.mappers";
import { RegistrationsReadService, type AdminRegistration } from "./registrations.read.service";
import { syncPaidCount } from "./registrations.settlement";
import {
  audit,
  emitRegistrationEventsAndSyncNetworking,
  incrementEventRegistered,
  syncNetworkingAndQueueRegistrationCreatedEmail,
} from "./registrations.side-effects";

const EDIT_TOKEN_BYTES = 32; // 64 hex characters

function generateEditToken(): string {
  return randomBytes(EDIT_TOKEN_BYTES).toString("hex");
}

export type PublicCreateResult = {
  created: boolean;
  registration: PublicRegistration;
  priceBreakdown: PriceBreakdown;
};

function replayExisting(existing: RegistrationWithRelations): PublicCreateResult {
  return { created: false, registration: toPublicRegistration(existing, { token: existing.editToken }), priceBreakdown: existing.priceBreakdown as PriceBreakdown };
}

@Injectable()
export class RegistrationsCreateService {
  constructor(
    private readonly access: AccessService,
    private readonly pricing: PricingService,
    @Inject(CONFIG) private readonly config: Config,
    private readonly read: RegistrationsReadService,
  ) {}

  private async reserveAccess(selections: CreateRegistrationInput["accessSelections"], exec: DbExecutor): Promise<void> {
    if (selections && selections.length > 0) {
      await Promise.all(selections.map((s) => this.access.incrementAccessRegisteredCountTx(s.accessId, s.quantity, exec)));
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
      const existing = await this.read.getRegistrationByIdempotencyKey(
        input.idempotencyKey,
      );
      if (existing) {
        return replayExisting(existing);
      }
    }

    // 2. Active REGISTRATION form gate (null → sponsor/inactive/missing/not-OPEN).
    const form = await findActiveRegistrationFormById(formId);
    if (!form) {
      throw notFound("Form not found");
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
        const existing = await this.read.getRegistrationByIdempotencyKey(
          normalizedInput.idempotencyKey,
        );
        if (existing) {
          return replayExisting(existing);
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

    const form = orNotFound(await findFormById(formId), "Form not found");

    const eventId = form.eventId;

    // Duplicate check (outside tx — advisory fast-fail).
    if (await registrationExistsByEmailForm(email, formId)) {
      throw registrationAlreadyExists();
    }

    // Advisory access-selection validation (outside tx).
    if (accessSelections && accessSelections.length > 0) {
      await this.access.assertAccessSelectionsValid(
        eventId,
        accessSelections,
        formData,
      );
    }

    await this.access.assertAccessSelectionRequirement(eventId, formData, accessSelections ?? [],
      form.schema);

    let createdId!: string;
    try {
      await withTxn(async (tx) => {
      const event = await getEventForRegistrationCreate(eventId, tx);
      if (!event) {
        throw badRequest("Event is not accepting registrations", { code: ErrorCodes.EVENT_NOT_OPEN });
      }
      assertEventAcceptsPublicActions(event);
      assertModuleEnabledForClient(event.client, "registrations");
      assertLabSponsorshipAllowed(event.client, paymentMethod);

      if (event.maxCapacity !== null && event.registeredCount >= event.maxCapacity) {
        throw conflict("Event is at capacity", { code: ErrorCodes.EVENT_FULL });
      }

      const editToken = generateEditToken();
      const referenceNumber = await generateReferenceNumber(eventId, tx);

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
          ...breakdownColumns(priceBreakdown),
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

      await this.reserveAccess(accessSelections, tx);

      await incrementEventRegistered(tx, eventId);

      await audit(tx, {
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
      await emitRegistrationEventsAndSyncNetworking(tx, pending);
      await syncNetworkingAndQueueRegistrationCreatedEmail(tx, eventId, {
        id,
        email,
        firstName,
        lastName,
      });
      });
    } catch (err) {
      translateCreateUniqueViolation(err);
    }

    const enriched = await this.read.getEnrichedRow(createdId);
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
      throw notFound("No registration form found for this event");
    }
    // Admin answers: visible fields only, type-checked, required not enforced;
    // stored and priced as returned.
    const formData = prepareFormDataForPricing(
      (await findRegistrationFormSchema(eventId))?.schema,
      rawFormData,
      { enforceRequired: false },
    );

    if (await registrationExistsByEmailForm(email, form.id)) {
      throw registrationAlreadyExists();
    }

    if (accessSelections && accessSelections.length > 0) {
      await this.access.assertAccessSelectionsValid(
        eventId,
        accessSelections,
        formData,
      );
    }

    const eventGate = await getEventForRegistrationAdmin(eventId);
    if (!eventGate) {
      throw notFound("Event not found");
    }
    assertModuleEnabledForClient(eventGate.client, "pricing");

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
        throw notFound("Event not found");
      }
      assertEventWritable(event);
      assertModuleEnabledForClient(event.client, "registrations");
      assertLabSponsorshipAllowed(event.client, paymentMethod);

      if (event.maxCapacity !== null && event.registeredCount >= event.maxCapacity) {
        throw conflict("Event is at capacity", { code: ErrorCodes.EVENT_FULL });
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
          ...breakdownColumns(priceBreakdown),
          sponsorshipAmount: 0,
          accessTypeIds,
          editToken: null,
          linkBaseUrl: null,
          idempotencyKey: null,
        },
        tx,
      );
      createdId = id;

      await this.reserveAccess(accessSelections, tx);

      if (isFullySettled(resolvedPaymentStatus)) {
        await syncPaidCount(this.access, 
          tx,
          { id, eventId, priceBreakdown },
          "PENDING",
          resolvedPaymentStatus,
        );
      }

      await incrementEventRegistered(tx, eventId);

      await audit(tx, {
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
        await syncNetworkingAndQueueRegistrationCreatedEmail(tx, eventId, {
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

    return toAdminRegistration(await this.read.getEnrichedRow(createdId));
  }
}
