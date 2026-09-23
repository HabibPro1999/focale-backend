import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import { getDb } from "../client";
import {
  networkingDeliveries,
  networkingProfiles,
  networkingPushSubscriptions,
  networkingMeetings,
  networkingTables,
  networkingChallenges,
  networkingConnections,
  networkingMessages,
  networkingBlocks,
  networkingNotifications,
} from "../schema/networking";
import { events } from "../schema/events-access";
import { registrations } from "../schema/registrations";
import { clients } from "../schema/users-clients";
import { forms } from "../schema/forms";
import { getNetworkingConfig } from "./networking";
import { networkingConsentPending } from "./networking-projection";
export * from "./networking-maintenance";
export * from "./networking-contact-export";
export * from "./networking-email-tracking";
export * from "./networking-report-data";

export type NetworkingDeliveryRow = typeof networkingDeliveries.$inferSelect;
export async function claimNetworkingDeliveries(
  limit = 20,
  eventId?: string,
): Promise<NetworkingDeliveryRow[]> {
  // RETURNING is decoded by Drizzle, including the exact millisecond lease fence.
  return getDb().update(networkingDeliveries).set({
    status: "PROCESSING",
    attempts: sql`attempts+1`,
    lockedUntil: sql`date_trunc('milliseconds',now())+interval '5 minutes'`,
    updatedAt: sql`now()`,
  }).where(sql`id IN (
      SELECT id FROM networking_deliveries
      WHERE ((status='PENDING' AND attempts<5) OR (status='PROCESSING' AND locked_until<now() AND attempts<5) OR (status='FAILED' AND attempts<5))
        AND available_at<=now() ${eventId ? sql`AND event_id=${eventId}` : sql``}
      ORDER BY CASE WHEN type='OTP' THEN 0 ELSE 1 END,available_at LIMIT ${Math.max(1, Math.min(limit, 100))} FOR UPDATE SKIP LOCKED
  )`).returning();
}
export async function updateNetworkingDelivery(
  row: NetworkingDeliveryRow,
  values: Partial<typeof networkingDeliveries.$inferInsert>,
) {
  const result = await getDb()
    .update(networkingDeliveries)
    .set({ ...values, updatedAt: new Date() })
    .where(
      and(
        eq(networkingDeliveries.id, row.id),
        eq(networkingDeliveries.status, "PROCESSING"),
        eq(networkingDeliveries.lockedUntil, row.lockedUntil!),
        gt(networkingDeliveries.lockedUntil, new Date()),
      ),
    )
    .returning({ id: networkingDeliveries.id });
  return result.length > 0;
}
/** A stale worker cannot continue dispatching after another worker reclaimed the lease. */
export async function refreshNetworkingDeliveryLease(
  row: NetworkingDeliveryRow,
) {
  const lockedUntil = new Date(Date.now() + 5 * 60_000);
  if (!(await updateNetworkingDelivery(row, { lockedUntil }))) return false;
  row.lockedUntil = lockedUntil;
  return true;
}
export async function networkingDeliveryContext(row: NetworkingDeliveryRow) {
  const db = getDb();
  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.id, row.eventId));
  const [client] = event
    ? await db.select().from(clients).where(eq(clients.id, event.clientId))
    : [];
  const [profile] = row.profileId
    ? await db
        .select()
        .from(networkingProfiles)
        .where(
          and(
            eq(networkingProfiles.id, row.profileId),
            eq(networkingProfiles.eventId, row.eventId),
          ),
        )
    : [];
  const [registration] = profile
    ? await db
        .select()
        .from(registrations)
        .where(
          and(
            eq(registrations.id, profile.registrationId),
            eq(registrations.eventId, row.eventId),
          ),
        )
    : [];
  const [meeting] =
    typeof row.payload.meetingId === "string"
      ? await db
          .select()
          .from(networkingMeetings)
          .where(
            and(
              eq(networkingMeetings.id, row.payload.meetingId),
              eq(networkingMeetings.eventId, row.eventId),
            ),
          )
      : [];
  const [table] = meeting?.tableId
    ? await db
        .select()
        .from(networkingTables)
        .where(
          and(
            eq(networkingTables.id, meeting.tableId),
            eq(networkingTables.eventId, row.eventId),
          ),
        )
    : [];
  const [connection] =
    typeof row.payload.connectionId === "string"
      ? await db
          .select()
          .from(networkingConnections)
          .where(
            and(
              eq(networkingConnections.id, row.payload.connectionId),
              eq(networkingConnections.eventId, row.eventId),
            ),
          )
      : [];
  const [message] =
    typeof row.payload.messageId === "string" && connection
      ? await db
          .select()
          .from(networkingMessages)
          .where(
            and(
              eq(networkingMessages.id, row.payload.messageId),
              eq(networkingMessages.connectionId, connection.id),
              eq(networkingMessages.eventId, row.eventId),
            ),
          )
      : [];
  const otherId =
    meeting && profile
      ? meeting.requesterId === profile.id
        ? meeting.recipientId
        : meeting.requesterId
      : connection && profile
        ? connection.profileAId === profile.id
          ? connection.profileBId
          : connection.profileAId
        : undefined;
  const [contact] = otherId
    ? await db
        .select()
        .from(networkingProfiles)
        .where(
          and(
            eq(networkingProfiles.id, otherId),
            eq(networkingProfiles.eventId, row.eventId),
          ),
        )
    : [];
  const [contactRegistration] = contact
    ? await db
        .select()
        .from(registrations)
        .where(
          and(
            eq(registrations.id, contact.registrationId),
            eq(registrations.eventId, row.eventId),
          ),
        )
    : [];
  const blocks =
    profile && contact
      ? await db
          .select({ id: networkingBlocks.id })
          .from(networkingBlocks)
          .where(
            and(
              eq(networkingBlocks.eventId, row.eventId),
              or(
                and(
                  eq(networkingBlocks.profileId, profile.id),
                  eq(networkingBlocks.targetId, contact.id),
                ),
                and(
                  eq(networkingBlocks.profileId, contact.id),
                  eq(networkingBlocks.targetId, profile.id),
                ),
              ),
            ),
          )
      : [];
  const [challenge] =
    row.type === "OTP" && typeof row.payload.challengeId === "string"
      ? await db
          .select()
          .from(networkingChallenges)
          .where(
            and(
              eq(networkingChallenges.id, row.payload.challengeId),
              eq(networkingChallenges.eventId, row.eventId),
            ),
          )
      : [];
  const subscriptions = profile
    ? await db
        .select()
        .from(networkingPushSubscriptions)
        .where(
          and(
            eq(networkingPushSubscriptions.profileId, profile.id),
            eq(networkingPushSubscriptions.eventId, row.eventId),
          ),
        )
    : [];
  const config = await getNetworkingConfig(row.eventId);
  // OTP only: undecided registrants sign in to give consent in the PWA (K1b).
  const [form] = row.type === "OTP" && profile && registration && !profile.consent
    ? await db.select({ schema: forms.schema }).from(forms)
        .where(and(eq(forms.id, registration.formId), eq(forms.eventId, row.eventId)))
    : [];
  const consentPending = !!form && !!profile && !!registration && networkingConsentPending({
    profile, optIn: registration.networkingOptIn, formSchema: form.schema, formData: registration.formData, config,
  });
  return {
    event,
    client,
    profile,
    registration,
    meeting,
    table,
    contact,
    contactRegistration,
    connection,
    message,
    blocked: blocks.length > 0,
    challenge,
    subscriptions,
    config,
    consentPending,
  };
}
export async function networkingDigestNotifications(
  row: NetworkingDeliveryRow,
) {
  const ids = Array.isArray(row.payload.notificationIds)
    ? row.payload.notificationIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  if (!row.profileId || !ids.length) return [];
  return getDb()
    .select()
    .from(networkingNotifications)
    .where(
      and(
        eq(networkingNotifications.eventId, row.eventId),
        eq(networkingNotifications.profileId, row.profileId),
        inArray(networkingNotifications.id, ids),
        sql`(${networkingNotifications.readAt} IS NULL OR ${networkingNotifications.type}='POST_EVENT_CONTACTS')`,
      ),
    )
    .orderBy(networkingNotifications.createdAt);
}
export async function localizeNetworkingNotification(
  row: NetworkingDeliveryRow,
  title: string,
  body: string,
  href: string,
) {
  if (typeof row.payload.notificationId !== "string" || !row.profileId) return;
  await getDb()
    .update(networkingNotifications)
    .set({ title, body, href })
    .where(
      and(
        eq(networkingNotifications.id, row.payload.notificationId),
        sql`EXISTS (SELECT 1 FROM networking_deliveries WHERE id=${row.id} AND status='PROCESSING' AND locked_until=${row.lockedUntil?.toISOString()}::timestamp AND locked_until>now())`,
        eq(networkingNotifications.eventId, row.eventId),
        eq(networkingNotifications.profileId, row.profileId),
      ),
    );
}
export async function deleteNetworkingPushSubscription(id: string) {
  await getDb()
    .delete(networkingPushSubscriptions)
    .where(eq(networkingPushSubscriptions.id, id));
}
