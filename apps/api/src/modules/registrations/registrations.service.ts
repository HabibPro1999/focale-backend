import { timingSafeEqual } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { buildRegistrationSelfLinks } from "@app/integrations";
import { deleteNetworkingPhoto } from "../networking/networking.uploads.service";
import {
  ErrorCodes,
  type AppEvent,
  type PriceBreakdown,
  type ListRegistrationsQuery,
  type ListRegistrationAuditLogsQuery,
  type ListRegistrationEmailLogsQuery,
  type RegistrationAuditLog,
  type RegistrationEmailLog,
  type RegistrationStats,
  type SearchRegistrantsQuery,
} from "@app/contracts";
import {
  calculateSettlement,
  getSkip,
  paginate,
  type PaginatedResult,
} from "@app/shared";
import {
  withLockingTxn,
  lockRegistrationForUpdate,
  lockRegistrationSponsorships,
  releaseRegistrationUsagesTxn,
  emitSettlementEvents,
  findAccessDetailsByIds,
  searchRegistrantsForSponsorship as searchRegistrantsQuery,
  // registrations-owned primitives
  getRegistrationClientId as getRegistrationClientIdQuery,
  getRegistrationEditToken,
  getRegistrationEditLinkSource,
  listRegistrationRows,
  findRegistrationForMutation,
  findRegistrationWithFormEvent,
  deleteRegistrationRow,
  getNetworkingProfilePhotoByRegistration,
  insertAuditLog,
  listRegistrationAuditLogRows,
  findUserNamesByIds,
  listRegistrationEmailLogRows,
} from "@app/db";
import { AccessService } from "../access/access.service";
import { assertEventWritable } from "../events";
import {
  assertModuleEnabledForClient,
  type ClientModuleState,
} from "../clients/module-gates";
import { AppException } from "../../core/app-exception";
import { getRegistrationTableColumns } from "./table-columns";
import { RegistrationSideEffects } from "./registrations.side-effects";
import { evaluateEditPolicy } from "./edit-policy";
import {
  enrichManyWithAccessSelections,
  type RegistrationWithRelations,
} from "./registrations.enrichment";
import {
  toAdminRegistration,
  toPublicRegistration,
  type AdminView,
  type PublicRegistration,
} from "./registrations.mappers";
import {
  getAdminRegistrationById,
  getRegistrationByIdempotencyKey,
  type AdminRegistration,
} from "./registrations.shared";

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

@Injectable()
export class RegistrationsService {
  constructor(
    private readonly access: AccessService,
    private readonly sideEffects: RegistrationSideEffects,
  ) {}

  // ==========================================================================
  // Reads
  // ==========================================================================

  getRegistrationById(id: string): Promise<AdminRegistration | null> {
    return getAdminRegistrationById(id);
  }

  /** editToken intentionally NOT stripped (renamed to `token` by the create route). */
  getRegistrationByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<RegistrationWithRelations | null> {
    return getRegistrationByIdempotencyKey(idempotencyKey);
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

      await this.sideEffects.audit(tx, {
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

      await this.sideEffects.decrementEventRegistered(tx, registration.eventId);
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
