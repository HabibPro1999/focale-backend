import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../client";
import { withSerializableTxn } from "../txn";
import { networkingAudit, networkingDeliveries } from "../schema/networking";
import type { NetworkingDeliveryRow } from "./networking-delivery";
import { networkingDailyMetrics, networkingEventTotals, networkingSectorMetrics } from "./networking-metrics";
import { networkingEmailMetrics } from "./networking-read";

/**
 * Aggregate-only durable report data contains no participant names, messages
 * or contact details. The figures are the organizer analytics' definitions
 * (`networking-metrics.ts`, plan 4.9); the summary keys are the stored report's.
 */
export async function networkingPostEventReportData(
  eventId: string,
  timezone = "UTC",
) {
  const db = getDb();
  const totals = await networkingEventTotals(eventId, { timezone }, db);
  const email = await networkingEmailMetrics(eventId);
  const summary: Record<string, number> = {
    participants: totals.participants,
    active_participants: totals.activatedParticipants,
    profile_views: totals.profileViews,
    interests: totals.likes,
    connections: totals.connections,
    messages: totals.messages,
    meeting_requests: totals.meetingRequests,
    meetings: totals.bookedMeetings,
    pending_meetings: totals.awaitingMeetings,
    responsive_conversations: totals.responsiveConversations,
    conversations: totals.conversations,
    completed_meetings: totals.completedMeetings,
    no_shows: totals.noShowMeetings,
    cancelled_meetings: totals.cancelledMeetings,
    emails_sent: email?.emailSent ?? 0,
    emails_opened: email?.emailOpened ?? 0,
    emails_clicked: email?.emailClicked ?? 0,
  };
  // A blank sector keeps its empty label: the PDF prints it as a dash.
  const sectors = await networkingSectorMetrics(eventId, { unspecified: "" }, db);
  const timeSeries = (await networkingDailyMetrics(eventId, timezone, db))
    .filter((day) => day.connections || day.messages || day.meetings)
    .map(({ date, connections, messages, meetings }) => ({ date, connections, messages, meetings }));
  return { summary, sectors, timeSeries };
}
export async function saveNetworkingPostEventReport(
  row: NetworkingDeliveryRow,
  storageKey: string,
  summary: Record<string, number>,
) {
  // SERIALIZABLE with retries: the lease-checked claim and its audit row commit together or not at all.
  return withSerializableTxn(async (tx) => {
    const data = { storageKey, generatedAt: new Date().toISOString(), summary };
    const claimed = await tx
      .update(networkingDeliveries)
      .set({
        status: "SENT",
        lockedUntil: null,
        payload: data,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(networkingDeliveries.id, row.id),
          eq(networkingDeliveries.status, "PROCESSING"),
          eq(networkingDeliveries.lockedUntil, row.lockedUntil!),
          sql`${networkingDeliveries.lockedUntil}>now()`,
        ),
      )
      .returning({ id: networkingDeliveries.id });
    if (!claimed.length) return false;
    await tx
      .insert(networkingAudit)
      .values({
        id: row.id,
        eventId: row.eventId,
        actorId: "networking-worker",
        action: "POST_EVENT_REPORT",
        targetId: row.eventId,
        data,
      })
      .onConflictDoNothing({ target: networkingAudit.id });
    return true;
  });
}
export async function latestNetworkingPostEventReport(eventId: string) {
  const [row] = await getDb()
    .select()
    .from(networkingAudit)
    .where(
      and(
        eq(networkingAudit.eventId, eventId),
        eq(networkingAudit.action, "POST_EVENT_REPORT"),
      ),
    )
    .orderBy(desc(networkingAudit.createdAt))
    .limit(1);
  if (!row || typeof row.data.storageKey !== "string") return null;
  return {
    storageKey: row.data.storageKey,
    generatedAt: String(row.data.generatedAt),
    summary: row.data.summary as Record<string, number>,
  };
}
