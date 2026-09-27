import {
  ErrorCodes,
  getSponsorshipMode,
  getSponsorshipSettings,
  type CreateBatchResult,
  type CreateSponsorshipBatchInput,
} from "@app/contracts";
import { type RegistrationForCalculation } from "@app/shared";
import {
  findActiveEventAccess,
  findEventForBatch,
  findRegistrationsForBatch,
  findSponsorFormById,
  getDb,
  getSponsorshipEventPricing,
  getFormSchema,
  insertSponsorship,
  insertSponsorshipBatch,
  insertUsage,
  sponsorshipCodeExists,
  updateRegistrationSettlement,
  withTxn,
  type AccessItemForOverlap,
  type DbExecutor,
  type RegistrationForBatch,
  type SponsorshipRow,
} from "@app/db";
import { assertEventOpen } from "../events";
import { assertModuleEnabledForClient } from "../clients/module-gates";
import { AccessService } from "../access/access.service";
import {
  notFound,
  badRequest,
} from "../../core/app-exception";
import {
  applicableAmountFor,
  generateUniqueCode,
  validateCoveredAccessTimeOverlap,
} from "./sponsorships.utils";
import type { BatchContext, LinkedEmailEntry } from "./sponsorship-batch.types";
import { nextStatusOnApply } from "./sponsorship-settlement";
import { queueBatchEmails } from "./sponsorship-emails";

const MODULE = "sponsorships";

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
}

function sumAccessPrices(
  coveredAccessIds: string[],
  accessPriceMap: Map<string, number>,
): number {
  return coveredAccessIds.reduce(
    (sum, id) => sum + (accessPriceMap.get(id) ?? 0),
    0,
  );
}

/** Public batch workflow; email enqueue remains inside the batch transaction. */
export class SponsorshipBatch {
  constructor(private readonly access: AccessService) {}

  async createSponsorshipBatch(
    eventId: string,
    formId: string,
    input: CreateSponsorshipBatchInput,
  ): Promise<CreateBatchResult> {
    // input.idempotencyKey is intentionally ignored (legacy parity — see schema).
    const { sponsor, customFields } = input;
    const context = await this.validateBatchInput(eventId, formId, input);

    return withTxn(async (tx) => {
      const batch = await insertSponsorshipBatch(tx, {
        eventId,
        formId: context.formId,
        labName: sponsor.labName,
        contactName: sponsor.contactName,
        email: sponsor.email,
        phone: sponsor.phone ?? null,
        formData: { sponsor, customFields: customFields ?? {} },
      });

      const autoApprove = getSponsorshipSettings(
        await getFormSchema(tx, context.formId),
      ).autoApproveSponsorship ?? false;

      let created: SponsorshipRow[];
      let linkedEmailEntries: LinkedEmailEntry[] = [];
      if (context.isLinkedMode) {
        const linkedResult = await this.createLinkedModeSponsorships(tx, context, {
          eventId, batchId: batch.id, autoApprove,
        });
        created = linkedResult.created;
        linkedEmailEntries = linkedResult.linkedEmailEntries;
      } else {
        created = await this.createCodeModeSponsorships(
          tx,
          eventId,
          batch.id,
          context.beneficiaries ?? [],
          context.pricing?.basePrice ?? 0,
          new Map(context.accessItems.map((item) => [item.id, item.price])),
        );
      }

      await queueBatchEmails(tx, context, {
        eventId, batchId: batch.id,
        batch: { ...sponsor, phone: sponsor.phone ?? null },
        autoApprove, sponsorships: created, linkedEmailEntries,
      });

      // ponytail: realtime outbox omitted — deferred across this port wave.
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
      const dupes = duplicates(emails);
      if (dupes.length > 0) {
        throw badRequest(`Duplicate beneficiary emails: ${[...new Set(dupes)].join(", ")}`);
      }
    } else if (isLinkedMode) {
      const regIds = linkedBeneficiaries.map((b) => b.registrationId);
      const dupes = duplicates(regIds);
      if (dupes.length > 0) {
        throw badRequest("Duplicate registration IDs in linked beneficiaries");
      }
    }

    const event = await findEventForBatch(db, eventId);
    if (!event) {
      throw notFound("Event not found");
    }
    assertEventOpen(event);
    assertModuleEnabledForClient(event.client, MODULE);

    const form = await findSponsorFormById(db, formId, eventId);
    if (!form) {
      throw notFound("Sponsor form not found for this event");
    }
    const sponsorshipMode = getSponsorshipMode(form.schema);

    if (isLinkedMode && sponsorshipMode !== "LINKED_ACCOUNT") {
      throw badRequest("This sponsor form does not accept linked-account sponsorships");
    }
    if (!isLinkedMode && sponsorshipMode === "LINKED_ACCOUNT") {
      throw badRequest("This sponsor form requires linked-account sponsorships");
    }

    const pricing = await getSponsorshipEventPricing(db, eventId);

    const beneficiaryList = isLinkedMode ? linkedBeneficiaries : beneficiaries;
    const allAccessIds = new Set<string>();
    for (const b of beneficiaryList) {
      for (const id of b.coveredAccessIds) allAccessIds.add(id);
    }

    let batchAccessItems: AccessItemForOverlap[] = [];
    if (allAccessIds.size > 0) {
      const accessItems = await findActiveEventAccess(db, eventId, [
        ...allAccessIds,
      ]);
      batchAccessItems = accessItems;
      const valid = new Set(accessItems.map((a) => a.id));
      const invalid = [...allAccessIds].filter((id) => !valid.has(id));
      if (invalid.length > 0) {
        throw badRequest(`Invalid access items: ${invalid.join(", ")}`, { code: ErrorCodes.BAD_REQUEST, details: { invalidAccessIds: invalid } });
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
        throw badRequest(`Time conflicts in covered access items: ${overlapErrors.join("; ")}`, { code: ErrorCodes.BAD_REQUEST, details: { timeConflicts: overlapErrors } });
      }
    }

    const registrations = new Map<string, RegistrationForBatch>();
    if (isLinkedMode) {
      const registrationIds = linkedBeneficiaries.map((b) => b.registrationId);
      const found = await findRegistrationsForBatch(db, eventId, registrationIds);
      const foundIds = new Set(found.map((r) => r.id));
      const missing = registrationIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw notFound(`Registrations not found: ${missing.join(", ")}`, { details: { missingRegistrationIds: missing } });
      }
      for (const r of found) registrations.set(r.id, r);
    }

    return {
      event,
      formId: form.id,
      pricing,
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

  private async createLinkedModeSponsorships(
    tx: DbExecutor,
    context: BatchContext,
    run: { eventId: string; batchId: string; autoApprove: boolean },
  ): Promise<{
    created: SponsorshipRow[];
    linkedEmailEntries: LinkedEmailEntry[];
  }> {
    const { eventId, batchId, autoApprove } = run;
    const { registrations } = context;
    const linkedBeneficiaries = context.linkedBeneficiaries ?? [];
    const accessPriceMap = new Map(context.accessItems.map((item) => [item.id, item.price]));
    const created: SponsorshipRow[] = [];
    const linkedEmailEntries: LinkedEmailEntry[] = [];
    // Sequential — auto-approve mutates the in-memory running total that a later
    // beneficiary targeting the same registration must observe.
    for (const linked of linkedBeneficiaries) {
      const registration = registrations.get(linked.registrationId);
      if (!registration) {
        throw notFound("Registration not found", { code: ErrorCodes.REGISTRATION_NOT_FOUND });
      }
      const code = await generateUniqueCode((c) => sponsorshipCodeExists(tx, c));
      const beneficiaryName =
        [registration.firstName, registration.lastName]
          .filter(Boolean)
          .join(" ") || registration.email;
      const totalAmount =
        (linked.coversBasePrice ? registration.baseAmount : 0) +
        sumAccessPrices(linked.coveredAccessIds, accessPriceMap);

      const sponsorship = await insertSponsorship(tx, {
        batchId,
        eventId,
        code,
        status: autoApprove ? "USED" : "PENDING",
        beneficiaryName,
        beneficiaryEmail: registration.email,
        beneficiaryPhone: registration.phone ?? null,
        beneficiaryAddress: null,
        coversBasePrice: linked.coversBasePrice,
        coveredAccessIds: linked.coveredAccessIds,
        totalAmount,
        ...(autoApprove ? {} : { targetRegistrationId: linked.registrationId }),
      });
      if (!autoApprove) {
        created.push(sponsorship);
        continue;
      }

      const priceBreakdown =
        registration.priceBreakdown as RegistrationForCalculation["priceBreakdown"];
      const oldCovered =
        registration.paymentStatus === "PARTIAL"
          ? await this.access.getAlreadyCoveredAccessIds(linked.registrationId, tx)
          : new Set<string>();
      const applicableAmount = applicableAmountFor(
        { coversBasePrice: linked.coversBasePrice, coveredAccessIds: linked.coveredAccessIds, totalAmount },
        registration,
      );

      await insertUsage(tx, {
        sponsorshipId: sponsorship.id,
        registrationId: linked.registrationId,
        amountApplied: applicableAmount,
        appliedBy: "SYSTEM",
      });

      const updatedSponsorshipAmount = Math.min(
        registration.sponsorshipAmount + applicableAmount,
        registration.totalAmount,
      );
      const isFullySponsored =
        updatedSponsorshipAmount >= registration.totalAmount;
      const nextPaymentStatus = nextStatusOnApply(
        registration.paymentStatus,
        isFullySponsored,
        updatedSponsorshipAmount,
      );

      await updateRegistrationSettlement(tx, linked.registrationId, {
        sponsorshipAmount: updatedSponsorshipAmount,
        paymentMethod: "LAB_SPONSORSHIP",
        paymentStatus: nextPaymentStatus,
        ...(nextPaymentStatus === "SPONSORED" ? { paidAt: new Date() } : {}),
      });

      const newCovered = new Set([...oldCovered, ...linked.coveredAccessIds]);
      await this.access.syncPaidCountDelta(
        eventId,
        {
          status: registration.paymentStatus,
          priceBreakdown: registration.priceBreakdown,
          coveredAccessIds: oldCovered,
        },
        {
          status: nextPaymentStatus,
          priceBreakdown: registration.priceBreakdown,
          coveredAccessIds: newCovered,
        },
        tx,
      );

      // Mutate running total so a later beneficiary on the same reg sees it.
      registration.sponsorshipAmount = updatedSponsorshipAmount;
      created.push(sponsorship);
      linkedEmailEntries.push({
        amountApplied: applicableAmount,
        isFullySponsored,
        sponsorship: {
          code: sponsorship.code,
          beneficiaryName: sponsorship.beneficiaryName,
          coversBasePrice: sponsorship.coversBasePrice,
          coveredAccessIds: sponsorship.coveredAccessIds ?? [],
          totalAmount: sponsorship.totalAmount,
        },
        registration: { ...registration },
      });
    }
    return { created, linkedEmailEntries };
  }

}
