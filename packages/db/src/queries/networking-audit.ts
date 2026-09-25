import { and, count, desc, eq, inArray } from "drizzle-orm";
import { getDb, type DbExecutor } from "../client";
import { networkingAudit } from "../schema/networking";

/**
 * Organizer-visible audit actions: organizer and system decisions only.
 * Participant activity (swipes, MFA changes, profile views) is personal data
 * and never listed. Keep in step with the admin action enums; a unit test
 * fails when an admin meeting or report action is missing here.
 */
export const NETWORKING_ADMIN_AUDIT_ACTIONS = [
  "CONFIG_UPDATED",
  "PROFILE_UPDATED",
  "MEETING_ASSIGN",
  "MEETING_CANCEL",
  "MEETING_COMPLETED",
  "MEETING_NO_SHOW",
  "REPORT_DISMISS",
  "REPORT_RESOLVE",
  "REPORT_WARN",
  "REPORT_SUSPEND",
  "REPORT_EXCLUDE",
  "SPACE_CREATED",
  "SPACE_UPDATED",
  "SPACE_REMOVED",
  "TABLE_CREATED",
  "TABLE_UPDATED",
  "TABLE_REMOVED",
  "POST_EVENT_REPORT",
  "POST_EVENT_REPORT_REGENERATE",
] as const;

/** Newest first, one page read in SQL (index networking_audit_event_created_idx). */
export async function listNetworkingAdminAudit(
  eventId: string,
  page: { page: number; limit: number },
  db: DbExecutor = getDb(),
) {
  const where = and(
    eq(networkingAudit.eventId, eventId),
    inArray(networkingAudit.action, [...NETWORKING_ADMIN_AUDIT_ACTIONS]),
  );
  const [items, [total]] = await Promise.all([
    db
      .select()
      .from(networkingAudit)
      .where(where)
      .orderBy(desc(networkingAudit.createdAt), desc(networkingAudit.id))
      .limit(page.limit)
      .offset((page.page - 1) * page.limit),
    db.select({ total: count() }).from(networkingAudit).where(where),
  ]);
  return { items, total: Number(total?.total ?? 0) };
}
