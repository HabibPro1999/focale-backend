import { Injectable } from "@nestjs/common";
import {
  ErrorCodes,
  type AvailableSponsorship,
  type CreateBatchResult,
  type CreateSponsorshipBatchInput,
  type LinkSponsorshipResult,
  type ListSponsorshipsQuery,
  type UpdateSponsorshipInput,
} from "@app/contracts";
import {
  paginate,
  toOffsetPagination,
} from "@app/shared";
import {
  deleteSponsorshipRow,
  findActiveEventAccess,
  findSponsorshipForMutation,
  getActiveSponsorForm,
  getSponsorshipEventPricing,
  getLinkedSponsorships,
  getPendingSponsorships,
  getRegistrationCoverage,
  getSponsorshipById,
  getSponsorshipClientId,
  listSponsorships,
  lockRegistrationsForUpdate,
  lockSponsorshipForUpdate,
  searchRegistrantsForSponsorship,
  updateSponsorshipRow,
  withLockingTxn,
  type DbExecutor,
  type SponsorshipWithUsages,
} from "@app/db";
import { assertEventWritable } from "../events";
import { assertModuleEnabledForClient } from "../clients/module-gates";
import { AccessService } from "../access/access.service";
import {
  notFound,
  badRequest,
} from "../../core/app-exception";
import {
  applicableAmountFor,
  detectCoverageOverlap,
  validateCoveredAccessTimeOverlap,
  type ExistingUsage,
} from "./sponsorships.utils";
import { SponsorshipBatch } from "./sponsorship-batch";
import { SponsorshipLinks } from "./sponsorship-links";

const MODULE = "sponsorships";

/** Single Nest facade; workflow helpers use the same AccessService instance. */
@Injectable()
export class SponsorshipsService {
  private readonly batch: SponsorshipBatch;
  private readonly links: SponsorshipLinks;

  constructor(access: AccessService) {
    this.batch = new SponsorshipBatch(access);
    this.links = new SponsorshipLinks(access);
  }

  // ==========================================================================
  // Reads
  // ==========================================================================

  async listSponsorships(eventId: string, query: ListSponsorshipsQuery) {
    const { page, limit, ...filters } = query;
    const { data, total, stats } = await listSponsorships(eventId, {
      ...filters,
      ...toOffsetPagination({ page, limit }),
    });
    return { ...paginate(data, total, { page, limit }), stats };
  }

  getSponsorshipById(id: string) {
    return getSponsorshipById(id);
  }

  getSponsorshipClientId(id: string): Promise<string | null> {
    return getSponsorshipClientId(id);
  }

  getLinkedSponsorships(registrationId: string) {
    return getLinkedSponsorships(registrationId);
  }

  getActiveSponsorForm(eventId: string) {
    return getActiveSponsorForm(eventId);
  }

  searchRegistrantsForSponsorship(
    eventId: string,
    opts: { query: string; unpaidOnly: boolean; limit: number },
  ) {
    return searchRegistrantsForSponsorship(eventId, opts);
  }

  async getAvailableSponsorships(
    eventId: string,
    registrationId: string,
  ): Promise<AvailableSponsorship[]> {
    const registration = await getRegistrationCoverage(registrationId);
    if (!registration) {
      throw notFound("Registration not found", { code: ErrorCodes.REGISTRATION_NOT_FOUND });
    }
    if (registration.eventId !== eventId) {
      throw badRequest("Registration does not belong to this event", { code: ErrorCodes.BAD_REQUEST });
    }

    const pending = await getPendingSponsorships(eventId);
    const existingUsages: ExistingUsage[] = registration.existingUsages;
    return pending.map((sponsorship) => {
      const coverage = {
        coversBasePrice: sponsorship.coversBasePrice,
        coveredAccessIds: sponsorship.coveredAccessIds,
        totalAmount: sponsorship.totalAmount,
      };
      const applicableAmount = applicableAmountFor(coverage, registration);
      const conflicts = detectCoverageOverlap(existingUsages, coverage);
      return {
        id: sponsorship.id,
        code: sponsorship.code,
        beneficiaryName: sponsorship.beneficiaryName,
        beneficiaryEmail: sponsorship.beneficiaryEmail,
        totalAmount: sponsorship.totalAmount,
        coversBasePrice: sponsorship.coversBasePrice,
        coveredAccessIds: sponsorship.coveredAccessIds,
        batch: sponsorship.batch,
        applicableAmount,
        conflicts,
      };
    });
  }

  // ==========================================================================
  // Update / cancel / delete (own locking READ COMMITTED txn)
  // ==========================================================================

  async updateSponsorship(
    id: string,
    input: UpdateSponsorshipInput,
  ): Promise<SponsorshipWithUsages> {
    if (input.status === "CANCELLED") {
      return this.cancelSponsorship(id);
    }
    await withLockingTxn((tx) => this.updateSponsorshipCore(tx, id, input));
    return (await getSponsorshipById(id)) as SponsorshipWithUsages;
  }

  private async findSponsorshipForLockedMutation(tx: DbExecutor, id: string) {
    await lockSponsorshipForUpdate(tx, id);
    const before = await findSponsorshipForMutation(tx, id);
    if (!before) return null;
    // Discover ids under the sponsorship lock; lock the complete registration
    // set in id order before any settlement/counter writes, then re-read.
    await lockRegistrationsForUpdate(
      tx,
      before.usages.flatMap((usage) => usage.registrationId ? [usage.registrationId] : []),
    );
    return findSponsorshipForMutation(tx, id);
  }

  private async updateSponsorshipCore(
    tx: DbExecutor,
    id: string,
    input: UpdateSponsorshipInput,
  ): Promise<void> {
    const sponsorship = await this.findSponsorshipForLockedMutation(tx, id);
    if (!sponsorship) {
      throw notFound("Sponsorship not found");
    }
    assertEventWritable(sponsorship.event);
    assertModuleEnabledForClient(sponsorship.event.client, MODULE);

    const coverageChanged =
      input.coversBasePrice !== undefined ||
      input.coveredAccessIds !== undefined;
    const nextCoversBasePrice =
      input.coversBasePrice ?? sponsorship.coversBasePrice;
    const nextCoveredAccessIds =
      input.coveredAccessIds ?? sponsorship.coveredAccessIds ?? [];

    // Fetch active access rows once when we need them (overlap and/or repricing).
    const needAccess =
      nextCoveredAccessIds.length > 0 && coverageChanged;
    const accessRows = needAccess
      ? await findActiveEventAccess(tx, sponsorship.eventId, nextCoveredAccessIds)
      : [];

    if (input.coveredAccessIds !== undefined && nextCoveredAccessIds.length >= 2) {
      const timeErrors = validateCoveredAccessTimeOverlap(
        nextCoveredAccessIds,
        accessRows,
      );
      if (timeErrors.length > 0) {
        throw badRequest(`Time conflicts in covered access items: ${timeErrors.join("; ")}`, { code: ErrorCodes.BAD_REQUEST, details: { timeConflicts: timeErrors } });
      }
    }

    let nextTotalAmount = sponsorship.totalAmount;
    if (coverageChanged) {
      nextTotalAmount = 0;
      if (nextCoversBasePrice) {
        nextTotalAmount += (await getSponsorshipEventPricing(tx, sponsorship.eventId))?.basePrice ?? 0;
      }
      nextTotalAmount += accessRows.reduce((sum, item) => sum + item.price, 0);
    }

    const patch: Parameters<typeof updateSponsorshipRow>[2] = {};
    for (const key of ["beneficiaryName", "beneficiaryEmail", "beneficiaryPhone", "beneficiaryAddress"] as const) {
      if (input[key] !== undefined) Object.assign(patch, { [key]: input[key] });
    }
    if (coverageChanged) {
      patch.coversBasePrice = nextCoversBasePrice;
      patch.coveredAccessIds = nextCoveredAccessIds;
      patch.totalAmount = nextTotalAmount;
    }

    if (Object.keys(patch).length > 0) {
      await updateSponsorshipRow(tx, id, patch);
    }
    if (coverageChanged && sponsorship.usages.length > 0) {
      await this.links.recalculateUsageAmounts(tx, id);
    }
    // ponytail: audit + realtime outbox omitted — deferred across this port wave.
  }

  async cancelSponsorship(
    id: string,
  ): Promise<SponsorshipWithUsages> {
    await withLockingTxn((tx) => this.cancelSponsorshipCore(tx, id));
    return (await getSponsorshipById(id)) as SponsorshipWithUsages;
  }

  private async cancelSponsorshipCore(
    tx: DbExecutor,
    id: string,
  ): Promise<void> {
    const sponsorship = await this.findSponsorshipForLockedMutation(tx, id);
    if (!sponsorship) {
      throw notFound("Sponsorship not found");
    }
    assertEventWritable(sponsorship.event);
    assertModuleEnabledForClient(sponsorship.event.client, MODULE);

    // Unconditional: unlinks lingering usages even when already CANCELLED.
    await this.links.unlinkSponsorshipFromAllRegistrations(
      tx,
      id,
      sponsorship.usages,
    );

    if (sponsorship.status !== "CANCELLED") {
      await updateSponsorshipRow(tx, id, { status: "CANCELLED" });
    }
  }

  async deleteSponsorship(id: string): Promise<void> {
    await withLockingTxn((tx) => this.deleteSponsorshipCore(tx, id));
  }

  private async deleteSponsorshipCore(
    tx: DbExecutor,
    id: string,
  ): Promise<void> {
    const sponsorship = await this.findSponsorshipForLockedMutation(tx, id);
    if (!sponsorship) {
      throw notFound("Sponsorship not found");
    }
    assertEventWritable(sponsorship.event);
    assertModuleEnabledForClient(sponsorship.event.client, MODULE);

    await this.links.unlinkSponsorshipFromAllRegistrations(
      tx,
      id,
      sponsorship.usages,
    );
    await deleteSponsorshipRow(tx, id);
  }

  createSponsorshipBatch(eventId: string, formId: string, input: CreateSponsorshipBatchInput): Promise<CreateBatchResult> {
    return this.batch.createSponsorshipBatch(eventId, formId, input);
  }

  linkSponsorshipToRegistration(sponsorshipId: string, registrationId: string, adminUserId: string): Promise<LinkSponsorshipResult> {
    return this.links.linkSponsorshipToRegistration(sponsorshipId, registrationId, adminUserId);
  }

  linkSponsorshipByCode(registrationId: string, code: string, adminUserId: string): Promise<LinkSponsorshipResult> {
    return this.links.linkSponsorshipByCode(registrationId, code, adminUserId);
  }

  unlinkSponsorshipFromRegistration(sponsorshipId: string, registrationId: string): Promise<void> {
    return this.links.unlinkSponsorshipFromRegistration(sponsorshipId, registrationId);
  }
}
