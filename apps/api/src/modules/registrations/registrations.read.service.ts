import {
  ErrorCodes,
  type ListRegistrationAuditLogsQuery,
  type ListRegistrationEmailLogsQuery,
  type ListRegistrationsQuery,
  type RegistrationAuditLog,
  type RegistrationEmailLog,
  type RegistrationStats,
  type SearchRegistrantsQuery,
} from "@app/contracts";
import {
  findUserNamesByIds,
  getRegistrationByIdRow,
  getRegistrationByIdempotencyKeyRow,
  getRegistrationClientId as getRegistrationClientIdQuery,
  getRegistrationEditLinkSource,
  insertAuditLog,
  listRegistrationAuditLogRows,
  listRegistrationEmailLogRows,
  listRegistrationRows,
  searchRegistrantsForSponsorship as searchRegistrantsQuery,
} from "@app/db";
import { buildRegistrationSelfLinks } from "@app/integrations";
import { paginate, toOffsetPagination, type PaginatedResult } from "@app/shared";
import { Injectable } from "@nestjs/common";
import { notFound } from "../../core/app-exception";
import {
  enrichManyWithAccessSelections,
  enrichWithAccessSelections,
  type RegistrationWithRelations,
} from "./registrations.enrichment";
import { toAdminRegistration, type AdminView } from "./registrations.mappers";
import { getRegistrationTableColumns } from "./table-columns";

/** Admin-facing registration: no editToken / idempotencyKey (see mappers). */
export type AdminRegistration = AdminView<RegistrationWithRelations>;

@Injectable()
export class RegistrationsReadService {
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
    const { page, limit, ...filters } = query;
    const { rows, total, stats: statsRaw } = await listRegistrationRows(
      eventId,
      { ...filters, ...toOffsetPagination({ page, limit }) },
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
    return { ...paginate(enriched, total, { page, limit }), stats };
  }

  async getEnrichedRow(id: string): Promise<RegistrationWithRelations> {
    const row = await getRegistrationByIdRow(id);
    if (!row) {
      throw notFound("Registration not found", { code: ErrorCodes.REGISTRATION_NOT_FOUND });
    }
    return enrichWithAccessSelections(row);
  }

  async getStrippedById(id: string): Promise<AdminRegistration> {
    const enriched = await this.getRegistrationById(id);
    if (!enriched) {
      throw notFound("Registration not found after update", { code: ErrorCodes.REGISTRATION_NOT_FOUND });
    }
    return enriched;
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
      throw notFound("Registration not found", { code: ErrorCodes.REGISTRATION_NOT_FOUND });
    }
    if (!source.editToken) {
      throw notFound("This registration has no self-edit link");
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
    const { rows, total } = await listRegistrationAuditLogRows(
      registrationId,
      toOffsetPagination({ page, limit }),
    );

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
    const { rows, total } = await listRegistrationEmailLogRows(
      registrationId,
      toOffsetPagination({ page, limit }),
    );

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
