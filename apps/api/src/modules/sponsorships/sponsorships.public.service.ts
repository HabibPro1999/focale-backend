import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  type AppEvent,
  type CreateBatchResult,
  type CreateSponsorshipBatchInput,
} from "@app/contracts";
import { maskEmail } from "@app/shared";
import {
  emitSettlementEvents,
  enqueueSponsorshipEmailOutbox,
  enqueueTriggeredEmailOutbox,
  findActiveEventAccess,
  findEventForBatch,
  findRegistrationsForBatch,
  findSponsorFormById,
  getActiveSponsorForm,
  getDb,
  getEventPricingForBatch,
  getFormSchema,
  insertAuditLog,
  insertSponsorship,
  insertSponsorshipBatch,
  linkSponsorshipToRegistrationTxn,
  lockRegistrationsForUpdate,
  readSponsorshipTarget,
  searchRegistrantsForSponsorship,
  sponsorshipCodeExists,
  sponsorshipLinkRefusal,
  withLockingTxn,
  type AccessItemForOverlap,
  type DbExecutor,
  type RegistrantSearchResult,
  type RegistrationForBatch,
  type SettleRegistrationResult,
  type SponsorshipRow,
} from "@app/db";
import {
  buildBatchEmailContext,
  buildLinkedSponsorshipContext,
} from "@app/integrations";
import { assertEventOpen } from "../events";
import { assertModuleEnabledForClient } from "../clients/module-gates";
import { AccessService } from "../access/access.service";
import { AppException } from "../../core/app-exception";
import {
  generateUniqueCode,
  validateCoveredAccessTimeOverlap,
} from "./sponsorships.utils";
import {
  countsChanged,
  registrationEvents,
  rethrowSponsorshipException,
} from "./sponsorships.settlement";

// Public side of sponsorships (plan 5.7): what the anonymous, rate-limited
// sponsor form reaches — its form lookup, its registrant search and the batch
// intake. The admin operations (listing, coverage edit, cancel, delete, link
// and unlink by an admin) live in SponsorshipsAdminService, which this file
// does not import; nor does it import their settlement primitives. The one
// link made here is the sponsor form's own auto-approve in linked-account
// mode, recorded as SYSTEM.

const MODULE = "sponsorships";

/** Who a linked-mode batch's automatic links are recorded as. */
const BATCH_LINK_ACTOR = "SYSTEM";

function sumAccessPrices(
  coveredAccessIds: string[],
  accessPriceMap: Map<string, number>,
): number {
  return coveredAccessIds.reduce(
    (sum, id) => sum + (accessPriceMap.get(id) ?? 0),
    0,
  );
}

interface BatchContext {
  event: Awaited<ReturnType<typeof findEventForBatch>> & object;
  formId: string;
  pricing: { basePrice: number; currency: string } | null;
  accessPriceMap: Map<string, number>;
  accessItems: AccessItemForOverlap[];
  isLinkedMode: boolean;
  beneficiaries: CreateSponsorshipBatchInput["beneficiaries"];
  linkedBeneficiaries: CreateSponsorshipBatchInput["linkedBeneficiaries"];
  registrations: Map<string, RegistrationForBatch>;
}

/** Auto-approved linked-mode entry captured for post-create email enqueue. */
interface LinkedEmailEntry {
  amountApplied: number;
  isFullySponsored: boolean;
  sponsorship: {
    code: string;
    beneficiaryName: string;
    coversBasePrice: boolean;
    coveredAccessIds: string[];
    totalAmount: number;
  };
  registration: RegistrationForBatch;
}

@Injectable()
export class SponsorshipsPublicService {
  constructor(private readonly access: AccessService) {}

  // ==========================================================================
  // Sponsor form reads
  // ==========================================================================

  getActiveSponsorForm(eventId: string) {
    return getActiveSponsorForm(eventId);
  }

  /**
   * Registrant search for the anonymous sponsor form: the email is masked,
   * and fields are copied one by one, so a column added to the query does not
   * reach the anonymous caller by default.
   */
  async searchRegistrants(
    eventId: string,
    opts: { query: string; unpaidOnly: boolean; limit: number },
  ): Promise<RegistrantSearchResult[]> {
    const results = await searchRegistrantsForSponsorship(eventId, opts);
    return results.map((row) => ({
      id: row.id,
      email: maskEmail(row.email),
      firstName: row.firstName,
      lastName: row.lastName,
      paymentStatus: row.paymentStatus,
      totalAmount: row.totalAmount,
      baseAmount: row.baseAmount,
      accessAmount: row.accessAmount,
      sponsorshipAmount: row.sponsorshipAmount,
      accessTypeIds: row.accessTypeIds,
      coveredAccessIds: row.coveredAccessIds,
      isBasePriceCovered: row.isBasePriceCovered,
    }));
  }

  // ==========================================================================
  // Batch creation (public form submit)
  // ==========================================================================

  async createSponsorshipBatch(
    eventId: string,
    formId: string,
    input: CreateSponsorshipBatchInput,
  ): Promise<CreateBatchResult> {
    // input.idempotencyKey is intentionally ignored (legacy parity — see schema).
    const { sponsor, customFields } = input;
    const context = await this.validateBatchInput(eventId, formId, input);

    return withLockingTxn(async (tx) => {
      const formSchema = (await getFormSchema(tx, context.formId)) as
        | Record<string, unknown>
        | null;
      const sponsorshipSettings = formSchema?.sponsorshipSettings as
        | Record<string, unknown>
        | undefined;
      const autoApprove =
        (sponsorshipSettings?.autoApproveSponsorship as boolean | undefined) ??
        false;

      const batch = await insertSponsorshipBatch(tx, {
        eventId,
        formId: context.formId,
        labName: sponsor.labName,
        contactName: sponsor.contactName,
        email: sponsor.email,
        phone: sponsor.phone ?? null,
        formData: { sponsor, customFields: customFields ?? {} },
      });

      const clientId = context.event.clientId;
      let created: SponsorshipRow[];
      let linkedEmailEntries: LinkedEmailEntry[] = [];
      const pending: AppEvent[] = [];
      if (context.isLinkedMode) {
        const linkedResult = await this.createLinkedModeSponsorships(
          tx,
          eventId,
          batch.id,
          context.linkedBeneficiaries ?? [],
          context.registrations,
          autoApprove,
          context.accessPriceMap,
        );
        created = linkedResult.created;
        linkedEmailEntries = linkedResult.linkedEmailEntries;
        for (const { registrationId, sponsorshipId, settled } of linkedResult.links) {
          pending.push(
            {
              type: "sponsorship.linked",
              clientId,
              eventId,
              payload: { id: sponsorshipId, registrationId },
              ts: Date.now(),
            },
            ...registrationEvents(clientId, registrationId, settled),
          );
        }
        if (linkedResult.links.length > 0) {
          pending.push(countsChanged(clientId, eventId, linkedResult.links.map((link) => link.settled)));
        }
      } else {
        created = await this.createCodeModeSponsorships(
          tx,
          eventId,
          batch.id,
          context.beneficiaries ?? [],
          context.pricing?.basePrice ?? 0,
          context.accessPriceMap,
        );
      }

      await this.queueBatchEmails(
        tx,
        eventId,
        batch.id,
        context,
        {
          labName: sponsor.labName,
          contactName: sponsor.contactName,
          email: sponsor.email,
          phone: sponsor.phone ?? null,
        },
        autoApprove,
        created,
        linkedEmailEntries,
      );

      pending.unshift({
        type: "sponsorship.batchCreated",
        clientId,
        eventId,
        payload: { id: batch.id, batchId: batch.id, count: created.length },
        ts: Date.now(),
      });
      await emitSettlementEvents(tx, pending);
      return { batchId: batch.id, count: created.length };
    });
  }

  private async validateBatchInput(
    eventId: string,
    formId: string,
    input: CreateSponsorshipBatchInput,
  ): Promise<BatchContext> {
    const db = getDb();
    const beneficiaries = input.beneficiaries ?? [];
    const linkedBeneficiaries = input.linkedBeneficiaries ?? [];
    const isLinkedMode = linkedBeneficiaries.length > 0;

    if (!isLinkedMode && beneficiaries.length > 0) {
      const emails = beneficiaries.map((b) => b.email.toLowerCase());
      const dupes = emails.filter((e, i) => emails.indexOf(e) !== i);
      if (dupes.length > 0) {
        throw new AppException(
          ErrorCodes.VALIDATION_ERROR,
          `Duplicate beneficiary emails: ${[...new Set(dupes)].join(", ")}`,
          400,
        );
      }
    }
    if (isLinkedMode) {
      const regIds = linkedBeneficiaries.map((b) => b.registrationId);
      const dupes = regIds.filter((r, i) => regIds.indexOf(r) !== i);
      if (dupes.length > 0) {
        throw new AppException(
          ErrorCodes.VALIDATION_ERROR,
          "Duplicate registration IDs in linked beneficiaries",
          400,
        );
      }
    }

    const event = await findEventForBatch(db, eventId);
    if (!event) {
      throw new AppException(ErrorCodes.NOT_FOUND, "Event not found", 404);
    }
    assertEventOpen(event);
    assertModuleEnabledForClient(event.client, MODULE);

    const form = await findSponsorFormById(db, formId, eventId);
    if (!form) {
      throw new AppException(
        ErrorCodes.NOT_FOUND,
        "Sponsor form not found for this event",
        404,
      );
    }
    const sponsorshipMode =
      ((form.schema as Record<string, unknown> | null)?.sponsorshipSettings as
        | Record<string, unknown>
        | undefined)?.sponsorshipMode ?? "CODE";

    if (isLinkedMode && sponsorshipMode !== "LINKED_ACCOUNT") {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "This sponsor form does not accept linked-account sponsorships",
        400,
      );
    }
    if (!isLinkedMode && sponsorshipMode === "LINKED_ACCOUNT") {
      throw new AppException(
        ErrorCodes.VALIDATION_ERROR,
        "This sponsor form requires linked-account sponsorships",
        400,
      );
    }

    const pricing = await getEventPricingForBatch(db, eventId);

    const beneficiaryList = isLinkedMode ? linkedBeneficiaries : beneficiaries;
    const allAccessIds = new Set<string>();
    for (const b of beneficiaryList) {
      for (const id of b.coveredAccessIds) allAccessIds.add(id);
    }

    let accessPriceMap = new Map<string, number>();
    let batchAccessItems: AccessItemForOverlap[] = [];
    if (allAccessIds.size > 0) {
      const accessItems = await findActiveEventAccess(db, eventId, [
        ...allAccessIds,
      ]);
      batchAccessItems = accessItems;
      const valid = new Set(accessItems.map((a) => a.id));
      const invalid = [...allAccessIds].filter((id) => !valid.has(id));
      if (invalid.length > 0) {
        throw new AppException(
          ErrorCodes.BAD_REQUEST,
          `Invalid access items: ${invalid.join(", ")}`,
          400,
          { invalidAccessIds: invalid },
        );
      }

      const overlapErrors: string[] = [];
      beneficiaryList.forEach((b, index) => {
        if (b.coveredAccessIds.length < 2) return;
        const errors = validateCoveredAccessTimeOverlap(
          b.coveredAccessIds,
          accessItems,
        );
        for (const e of errors) {
          overlapErrors.push(`Beneficiary #${index + 1}: ${e}`);
        }
      });
      if (overlapErrors.length > 0) {
        throw new AppException(
          ErrorCodes.BAD_REQUEST,
          `Time conflicts in covered access items: ${overlapErrors.join("; ")}`,
          400,
          { timeConflicts: overlapErrors },
        );
      }
      accessPriceMap = new Map(accessItems.map((a) => [a.id, a.price]));
    }

    const registrations = new Map<string, RegistrationForBatch>();
    if (isLinkedMode) {
      const registrationIds = linkedBeneficiaries.map((b) => b.registrationId);
      const found = await findRegistrationsForBatch(db, eventId, registrationIds);
      const foundIds = new Set(found.map((r) => r.id));
      const missing = registrationIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new AppException(
          ErrorCodes.NOT_FOUND,
          `Registrations not found: ${missing.join(", ")}`,
          404,
          { missingRegistrationIds: missing },
        );
      }
      for (const r of found) registrations.set(r.id, r);
    }

    return {
      event,
      formId: form.id,
      pricing,
      accessPriceMap,
      accessItems: batchAccessItems,
      isLinkedMode,
      beneficiaries,
      linkedBeneficiaries,
      registrations,
    };
  }

  private async createCodeModeSponsorships(
    tx: DbExecutor,
    eventId: string,
    batchId: string,
    beneficiaries: NonNullable<CreateSponsorshipBatchInput["beneficiaries"]>,
    basePrice: number,
    accessPriceMap: Map<string, number>,
  ): Promise<SponsorshipRow[]> {
    const created: SponsorshipRow[] = [];
    // Sequential — unique-code generation must serialize (collision safety).
    for (const b of beneficiaries) {
      const code = await generateUniqueCode((c) => sponsorshipCodeExists(tx, c));
      const totalAmount =
        (b.coversBasePrice ? basePrice : 0) +
        sumAccessPrices(b.coveredAccessIds, accessPriceMap);
      const sponsorship = await insertSponsorship(tx, {
        batchId,
        eventId,
        code,
        status: "PENDING",
        beneficiaryName: b.name,
        beneficiaryEmail: b.email,
        beneficiaryPhone: b.phone ?? null,
        beneficiaryAddress: b.address ?? null,
        coversBasePrice: b.coversBasePrice,
        coveredAccessIds: b.coveredAccessIds,
        totalAmount,
      });
      created.push(sponsorship);
    }
    return created;
  }

  /**
   * Linked-mode beneficiaries: one sponsorship per target registration.
   * Without auto-approve each is created PENDING and targeted at its
   * registration. With auto-approve every target registration is locked
   * first, in ascending id order, and each sponsorship is linked through
   * linkSponsorshipToRegistrationTxn (usage, USED, settlement), unless the
   * link is refused on the locked row (the registration is settled, already
   * paid more than it would owe, or the coverage applies nothing): that
   * sponsorship stays PENDING and targeted, for an admin to review.
   *
   * The new sponsorship rows are created after the registration locks. That
   * does not break the sponsorship → registration lock order: no other
   * transaction can see, let alone lock, a row this one has just inserted.
   */
  private async createLinkedModeSponsorships(
    tx: DbExecutor,
    eventId: string,
    batchId: string,
    linkedBeneficiaries: NonNullable<
      CreateSponsorshipBatchInput["linkedBeneficiaries"]
    >,
    registrations: Map<string, RegistrationForBatch>,
    autoApprove: boolean,
    accessPriceMap: Map<string, number>,
  ): Promise<{
    created: SponsorshipRow[];
    linkedEmailEntries: LinkedEmailEntry[];
    links: Array<{ registrationId: string; sponsorshipId: string; settled: SettleRegistrationResult }>;
  }> {
    const created: SponsorshipRow[] = [];
    const linkedEmailEntries: LinkedEmailEntry[] = [];
    const links: Array<{ registrationId: string; sponsorshipId: string; settled: SettleRegistrationResult }> = [];
    if (autoApprove) {
      await lockRegistrationsForUpdate(
        tx,
        linkedBeneficiaries.map((linked) => linked.registrationId),
      );
    }
    for (const linked of linkedBeneficiaries) {
      const registration = registrations.get(linked.registrationId);
      const target = registration
        ? await readSponsorshipTarget(tx, linked.registrationId)
        : null;
      if (!registration || !target) {
        throw new AppException(
          ErrorCodes.REGISTRATION_NOT_FOUND,
          "Registration not found",
          404,
        );
      }
      const code = await generateUniqueCode((c) => sponsorshipCodeExists(tx, c));
      const beneficiaryName =
        [registration.firstName, registration.lastName]
          .filter(Boolean)
          .join(" ") || registration.email;
      const coverage = {
        coversBasePrice: linked.coversBasePrice,
        coveredAccessIds: linked.coveredAccessIds,
        totalAmount:
          (linked.coversBasePrice ? target.baseAmount : 0) +
          sumAccessPrices(linked.coveredAccessIds, accessPriceMap),
      };
      const refusal = autoApprove ? await sponsorshipLinkRefusal(tx, coverage, target) : null;
      const sponsorship = await insertSponsorship(tx, {
        batchId,
        eventId,
        code,
        status: "PENDING",
        beneficiaryName,
        beneficiaryEmail: registration.email,
        beneficiaryPhone: registration.phone ?? null,
        beneficiaryAddress: null,
        ...coverage,
        ...(autoApprove && !refusal ? {} : { targetRegistrationId: linked.registrationId }),
      });
      if (!autoApprove || refusal) {
        created.push(sponsorship);
        continue;
      }

      const link = await linkSponsorshipToRegistrationTxn(tx, {
        sponsorshipId: sponsorship.id,
        registrationId: linked.registrationId,
        appliedBy: BATCH_LINK_ACTOR,
        fields: { paymentMethod: "LAB_SPONSORSHIP" },
      }).catch(rethrowSponsorshipException);
      const { settled } = link;
      await this.access.handleCapacityReached(eventId, settled.paidAccess.incremented, tx);
      await insertAuditLog(
        {
          entityType: "Sponsorship",
          entityId: sponsorship.id,
          action: "LINK_TO_REGISTRATION",
          changes: {
            registrationId: { old: null, new: linked.registrationId },
            amountApplied: { old: 0, new: link.usage.amountApplied },
            sponsorshipAmount: { old: settled.before.sponsorshipAmount, new: settled.after.sponsorshipAmount },
            status: { old: "PENDING", new: "USED" },
          },
          performedBy: BATCH_LINK_ACTOR,
        },
        tx,
      );

      created.push({ ...sponsorship, status: "USED" });
      links.push({ registrationId: linked.registrationId, sponsorshipId: sponsorship.id, settled });
      linkedEmailEntries.push({
        amountApplied: link.usage.amountApplied,
        isFullySponsored: settled.after.paymentStatus === "SPONSORED",
        sponsorship: {
          code: sponsorship.code,
          beneficiaryName: sponsorship.beneficiaryName,
          coversBasePrice: sponsorship.coversBasePrice,
          coveredAccessIds: sponsorship.coveredAccessIds ?? [],
          totalAmount: sponsorship.totalAmount,
        },
        registration: {
          ...registration,
          totalAmount: settled.after.totalAmount,
          sponsorshipAmount: settled.after.sponsorshipAmount,
          paymentStatus: settled.after.paymentStatus,
          priceBreakdown: settled.after.priceBreakdown,
        },
      });
    }
    return { created, linkedEmailEntries, links };
  }

  /**
   * Batch confirmation to the lab + (auto-approved linked mode) per-beneficiary
   * SPONSORSHIP_LINKED / PAYMENT_CONFIRMED / SPONSORSHIP_PARTIAL emails, all
   * enqueued on the batch transaction (legacy queueBatchEmails parity).
   */
  private async queueBatchEmails(
    tx: DbExecutor,
    eventId: string,
    batchId: string,
    context: BatchContext,
    batch: {
      labName: string;
      contactName: string;
      email: string;
      phone: string | null;
    },
    autoApprove: boolean,
    sponsorships: SponsorshipRow[],
    linkedEmailEntries: LinkedEmailEntry[],
  ): Promise<void> {
    const currency = context.pricing?.currency ?? "TND";
    const eventForEmail = {
      name: context.event.name,
      slug: context.event.slug,
      startDate: context.event.startDate,
      location: context.event.location,
      client: { name: context.event.client.name },
    };

    const batchContext = buildBatchEmailContext({
      batch,
      sponsorships: sponsorships.map((s) => ({
        beneficiaryName: s.beneficiaryName,
        beneficiaryEmail: s.beneficiaryEmail,
        totalAmount: s.totalAmount,
      })),
      event: eventForEmail,
      currency,
    });

    await enqueueSponsorshipEmailOutbox(
      tx,
      {
        trigger: "SPONSORSHIP_BATCH_SUBMITTED",
        eventId,
        input: {
          recipientEmail: batch.email,
          recipientName: batch.contactName,
          context: batchContext as Record<string, unknown>,
        },
      },
      `email:sponsorship:SPONSORSHIP_BATCH_SUBMITTED:${batchId}`,
    );

    if (!context.isLinkedMode || !autoApprove) return;

    for (const entry of linkedEmailEntries) {
      const linkedContext = buildLinkedSponsorshipContext({
        amountApplied: entry.amountApplied,
        sponsorship: {
          ...entry.sponsorship,
          batch: {
            labName: batch.labName,
            contactName: batch.contactName,
            email: batch.email,
          },
        },
        registration: entry.registration,
        event: eventForEmail,
        pricing: context.pricing
          ? { basePrice: context.pricing.basePrice }
          : null,
        accessItems: context.accessItems,
        currency,
      });

      await enqueueSponsorshipEmailOutbox(
        tx,
        {
          trigger: "SPONSORSHIP_LINKED",
          eventId,
          input: {
            recipientEmail: entry.registration.email,
            recipientName:
              entry.registration.firstName || entry.sponsorship.beneficiaryName,
            context: linkedContext as Record<string, unknown>,
            registrationId: entry.registration.id,
          },
        },
        `email:sponsorship:SPONSORSHIP_LINKED:${entry.registration.id}:${entry.sponsorship.code}`,
      );

      if (entry.isFullySponsored) {
        await enqueueTriggeredEmailOutbox(
          tx,
          {
            trigger: "PAYMENT_CONFIRMED",
            eventId,
            registration: {
              id: entry.registration.id,
              email: entry.registration.email,
              firstName: entry.registration.firstName,
              lastName: entry.registration.lastName,
            },
          },
          `email:triggered:PAYMENT_CONFIRMED:${entry.registration.id}`,
        );
      } else if (entry.registration.sponsorshipAmount > 0) {
        await enqueueSponsorshipEmailOutbox(
          tx,
          {
            trigger: "SPONSORSHIP_PARTIAL",
            eventId,
            input: {
              recipientEmail: entry.registration.email,
              recipientName:
                entry.registration.firstName ||
                entry.sponsorship.beneficiaryName,
              context: linkedContext as Record<string, unknown>,
              registrationId: entry.registration.id,
            },
          },
          `email:sponsorship:SPONSORSHIP_PARTIAL:${entry.registration.id}:${entry.sponsorship.code}`,
        );
      }
    }
  }
}
