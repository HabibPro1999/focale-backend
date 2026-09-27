import { networkingStore } from "./networking-store";
import { ownedNetworkingDelivery, ownedNetworkingDeliverySql } from "./networking-delivery-fence";
import { clampNetworkingPageLimit } from "./networking-pagination";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "../client";
import {
  networkingDeliveries,
  networkingPushSubscriptions,
  networkingBlocks,
  networkingNotifications,
} from "../schema/networking";
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
      ORDER BY CASE WHEN type='OTP' THEN 0 ELSE 1 END,available_at LIMIT ${clampNetworkingPageLimit(limit)} FOR UPDATE SKIP LOCKED
  )`).returning();
}
export async function updateNetworkingDelivery(
  row: NetworkingDeliveryRow,
  values: Partial<typeof networkingDeliveries.$inferInsert>,
) {
  const result = await getDb()
    .update(networkingDeliveries)
    .set({ ...values, updatedAt: new Date() })
    .where(ownedNetworkingDelivery(row, "app"))
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
  const store = networkingStore(db);
  const event = (await store.one("events", { id: row.eventId })) ?? undefined;
  const [client] = event
    ? await db.select().from(clients).where(eq(clients.id, event.clientId))
    : [];
  const profile = row.profileId
    ? (await store.one("profiles", { id: row.profileId, eventId: row.eventId })) ?? undefined : undefined;
  const registration = profile
    ? (await store.one("registrations", { id: profile.registrationId, eventId: row.eventId })) ?? undefined : undefined;
  const meeting = typeof row.payload.meetingId === "string"
    ? (await store.one("meetings", { id: row.payload.meetingId, eventId: row.eventId })) ?? undefined : undefined;
  const table = meeting?.tableId
    ? (await store.one("tables", { id: meeting.tableId, eventId: row.eventId })) ?? undefined : undefined;
  const connection = typeof row.payload.connectionId === "string"
    ? (await store.one("connections", { id: row.payload.connectionId, eventId: row.eventId })) ?? undefined : undefined;
  const message = typeof row.payload.messageId === "string" && connection
    ? (await store.one("messages", { id: row.payload.messageId, connectionId: connection.id, eventId: row.eventId })) ?? undefined : undefined;
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
  const contact = otherId
    ? (await store.one("profiles", { id: otherId, eventId: row.eventId })) ?? undefined : undefined;
  const contactRegistration = contact
    ? (await store.one("registrations", { id: contact.registrationId, eventId: row.eventId })) ?? undefined : undefined;
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
  const challenge = row.type === "OTP" && typeof row.payload.challengeId === "string"
    ? (await store.one("challenges", { id: row.payload.challengeId, eventId: row.eventId })) ?? undefined : undefined;
  const subscriptions = profile
    ? await store.all("pushSubscriptions", { profileId: profile.id, eventId: row.eventId }) : [];
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
        sql`EXISTS (SELECT 1 FROM networking_deliveries WHERE ${ownedNetworkingDeliverySql(row)})`,
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
