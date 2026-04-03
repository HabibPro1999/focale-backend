import { prisma } from "@/database/client.js";
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";
import type { Prisma } from "@/generated/prisma/client.js";
import type {
  ListRegistrationAuditLogsQuery,
  RegistrationAuditLog,
  ListRegistrationEmailLogsQuery,
  RegistrationEmailLog,
  SearchRegistrantsQuery,
  RegistrantSearchResult,
} from "./registrations.schema.js";

// ============================================================================
// Audit & Email Log Queries
// ============================================================================

/**
 * List audit logs for a registration.
 * Returns paginated results with resolved performer names.
 */
export async function listRegistrationAuditLogs(
  registrationId: string,
  query: ListRegistrationAuditLogsQuery,
): Promise<PaginatedResult<RegistrationAuditLog>> {
  const { page, limit } = query;
  const skip = getSkip({ page, limit });

  const where = { entityType: "Registration", entityId: registrationId };

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      skip,
      take: limit,
      orderBy: { performedAt: "desc" },
    }),
    prisma.auditLog.count({ where }),
  ]);

  // Collect user IDs to resolve names
  const userIds = logs
    .map((l) => l.performedBy)
    .filter(
      (id): id is string => id !== null && id !== "SYSTEM" && id !== "PUBLIC",
    );

  const uniqueUserIds = [...new Set(userIds)];

  const users =
    uniqueUserIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: uniqueUserIds } },
          select: { id: true, name: true },
        })
      : [];

  const userMap = new Map(users.map((u) => [u.id, u.name]));

  const enrichedLogs: RegistrationAuditLog[] = logs.map((log) => ({
    id: log.id,
    action: log.action as RegistrationAuditLog["action"],
    changes: log.changes as Record<
      string,
      { old: unknown; new: unknown }
    > | null,
    performedBy: log.performedBy,
    performedByName:
      log.performedBy === "SYSTEM"
        ? "System"
        : log.performedBy === "PUBLIC"
          ? "Registrant (Self-Edit)"
          : (userMap.get(log.performedBy!) ?? null),
    performedAt: log.performedAt.toISOString(),
    ipAddress: log.ipAddress,
  }));

  return paginate(enrichedLogs, total, { page, limit });
}

/**
 * List email logs for a registration.
 * Returns paginated results with template names.
 */
export async function listRegistrationEmailLogs(
  registrationId: string,
  query: ListRegistrationEmailLogsQuery,
): Promise<PaginatedResult<RegistrationEmailLog>> {
  const { page, limit } = query;
  const skip = getSkip({ page, limit });

  const where = { registrationId };

  const [logs, total] = await Promise.all([
    prisma.emailLog.findMany({
      where,
      skip,
      take: limit,
      include: {
        template: { select: { name: true } },
      },
      orderBy: { queuedAt: "desc" },
    }),
    prisma.emailLog.count({ where }),
  ]);

  const enrichedLogs: RegistrationEmailLog[] = logs.map((log) => ({
    id: log.id,
    subject: log.subject,
    status: log.status as RegistrationEmailLog["status"],
    trigger: log.trigger as RegistrationEmailLog["trigger"],
    templateName: log.template?.name ?? null,
    errorMessage: log.errorMessage,
    queuedAt: log.queuedAt.toISOString(),
    sentAt: log.sentAt?.toISOString() ?? null,
    deliveredAt: log.deliveredAt?.toISOString() ?? null,
    openedAt: log.openedAt?.toISOString() ?? null,
    clickedAt: log.clickedAt?.toISOString() ?? null,
    bouncedAt: log.bouncedAt?.toISOString() ?? null,
    failedAt: log.failedAt?.toISOString() ?? null,
  }));

  return paginate(enrichedLogs, total, { page, limit });
}

// ============================================================================
// Registrant Search (for Linked Account Sponsorship)
// ============================================================================

/**
 * Search registrants by name or email for sponsorship linking.
 * Used when sponsorship mode is LINKED_ACCOUNT.
 */
export async function searchRegistrantsForSponsorship(
  eventId: string,
  query: SearchRegistrantsQuery,
): Promise<RegistrantSearchResult[]> {
  const { query: searchQuery, unpaidOnly, limit } = query;

  const where: Prisma.RegistrationWhereInput = {
    eventId,
    OR: [
      { email: { contains: searchQuery, mode: "insensitive" } },
      { firstName: { contains: searchQuery, mode: "insensitive" } },
      { lastName: { contains: searchQuery, mode: "insensitive" } },
    ],
  };

  // Filter to unpaid only if requested
  if (unpaidOnly) {
    where.paymentStatus = { in: ["PENDING", "VERIFYING", "PARTIAL"] };
  }

  const registrations = await prisma.registration.findMany({
    where,
    take: limit,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      paymentStatus: true,
      totalAmount: true,
      baseAmount: true,
      accessAmount: true,
      sponsorshipAmount: true,
      accessTypeIds: true,
      phone: true,
      formData: true,
      sponsorshipUsages: {
        select: {
          sponsorship: {
            select: {
              status: true,
              coversBasePrice: true,
              coveredAccessIds: true,
            },
          },
        },
      },
    },
  });

  return registrations.map((r) => {
    // Aggregate coverage from USED sponsorships only
    const usedSponsorships = r.sponsorshipUsages
      .map((u) => u.sponsorship)
      .filter((s) => s.status === "USED");

    const isBasePriceCovered = usedSponsorships.some((s) => s.coversBasePrice);
    const coveredAccessIds = [
      ...new Set(usedSponsorships.flatMap((s) => s.coveredAccessIds)),
    ];

    return {
      id: r.id,
      email: r.email,
      firstName: r.firstName,
      lastName: r.lastName,
      paymentStatus: r.paymentStatus as RegistrantSearchResult["paymentStatus"],
      totalAmount: r.totalAmount,
      baseAmount: r.baseAmount,
      sponsorshipAmount: r.sponsorshipAmount,
      accessTypeIds: r.accessTypeIds,
      coveredAccessIds,
      isBasePriceCovered,
      phone: r.phone,
      formData: r.formData as Record<string, unknown> | null,
    };
  });
}
