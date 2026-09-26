import { and, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { NetworkingConfigSchema } from "@app/contracts";
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
  networkingConfigs,
} from "../schema/networking";
import { events } from "../schema/events-access";
import { registrations } from "../schema/registrations";
import { clients } from "../schema/users-clients";
import { forms } from "../schema/forms";
import { networkingConsentPending } from "./networking-projection";
export * from "./networking-maintenance";
export * from "./networking-contact-export";
export * from "./networking-email-tracking";
export * from "./networking-report-data";

export type NetworkingDeliveryRow = typeof networkingDeliveries.$inferSelect;

/**
 * Which rows a delivery lane claims (4.2): sign-in codes have dedicated
 * lanes, so a code never waits behind a batch of digests. Each kind has its
 * own partial claim index (0031), whose predicate the claim repeats.
 */
export type NetworkingDeliveryLane = "otp" | "other";
export const NETWORKING_DELIVERY_MAX_ATTEMPTS = 5;

export async function claimNetworkingDeliveries(
  limit = 20,
  eventId?: string,
  lane: NetworkingDeliveryLane = "other",
): Promise<NetworkingDeliveryRow[]> {
  // RETURNING is decoded by Drizzle, including the exact millisecond lease fence.
  return getDb().update(networkingDeliveries).set({
    status: "PROCESSING",
    attempts: sql`attempts+1`,
    lockedUntil: sql`date_trunc('milliseconds',now())+interval '5 minutes'`,
    updatedAt: sql`now()`,
  }).where(sql`id IN (
      SELECT id FROM networking_deliveries
      WHERE ${lane === "otp" ? sql`type = 'OTP'` : sql`type <> 'OTP'`}
        AND status IN ('PENDING', 'PROCESSING', 'FAILED') AND attempts < ${sql.raw(String(NETWORKING_DELIVERY_MAX_ATTEMPTS))}
        AND (status <> 'PROCESSING' OR locked_until < now())
        AND available_at <= now() ${eventId ? sql`AND event_id=${eventId}` : sql``}
      ORDER BY available_at LIMIT ${Math.max(1, Math.min(limit, 100))} FOR UPDATE SKIP LOCKED
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

const contactProfiles = alias(networkingProfiles, "contact_profile");
const contactRegistrations = alias(registrations, "contact_registration");
const idText = (value: unknown) => (typeof value === "string" ? value : undefined);
const idMatch = (column: AnyPgColumn, value: string | undefined) =>
  value === undefined ? sql`false` : eq(column, value);
/** The other participant of the meeting (else the connection) the notice is about. */
const counterpartId = sql`CASE WHEN ${networkingProfiles.id} IS NULL THEN NULL
  WHEN ${networkingMeetings.id} IS NOT NULL THEN CASE WHEN ${networkingMeetings.requesterId} = ${networkingProfiles.id} THEN ${networkingMeetings.recipientId} ELSE ${networkingMeetings.requesterId} END
  WHEN ${networkingConnections.id} IS NOT NULL THEN CASE WHEN ${networkingConnections.profileAId} = ${networkingProfiles.id} THEN ${networkingConnections.profileBId} ELSE ${networkingConnections.profileAId} END
END`;
/** A block in either direction between the participant and the counterpart. */
const blockedBetween = sql<boolean>`EXISTS (SELECT 1 FROM ${networkingBlocks}
  WHERE ${networkingBlocks.eventId} = ${networkingProfiles.eventId}
    AND ((${networkingBlocks.profileId} = ${networkingProfiles.id} AND ${networkingBlocks.targetId} = ${contactProfiles.id})
      OR (${networkingBlocks.profileId} = ${contactProfiles.id} AND ${networkingBlocks.targetId} = ${networkingProfiles.id})))`.mapWith(Boolean);
const relationColumns = {
  meeting: networkingMeetings,
  table: networkingTables,
  connection: networkingConnections,
  message: networkingMessages,
  contact: contactProfiles,
  contactRegistration: contactRegistrations,
  blocked: blockedBetween,
};
/** The meeting/connection/message named by `ids`, and the counterpart, all in the event `eventId`. */
function relationJoins(eventId: SQL | AnyPgColumn, ids: { meetingId: SQL | string | undefined; connectionId: SQL | string | undefined; messageId: SQL | string | undefined }) {
  const match = (column: AnyPgColumn, id: SQL | string | undefined) =>
    id === undefined ? sql`false` : typeof id === "string" ? eq(column, id) : sql`${column} = ${id}`;
  return {
    meeting: and(match(networkingMeetings.id, ids.meetingId), sql`${networkingMeetings.eventId} = ${eventId}`)!,
    table: and(eq(networkingTables.id, networkingMeetings.tableId), sql`${networkingTables.eventId} = ${eventId}`)!,
    connection: and(match(networkingConnections.id, ids.connectionId), sql`${networkingConnections.eventId} = ${eventId}`)!,
    message: and(
      match(networkingMessages.id, ids.messageId),
      eq(networkingMessages.connectionId, networkingConnections.id),
      sql`${networkingMessages.eventId} = ${eventId}`,
    )!,
    contact: and(sql`${contactProfiles.eventId} = ${eventId}`, sql`${contactProfiles.id} = ${counterpartId}`)!,
    contactRegistration: and(eq(contactRegistrations.id, contactProfiles.registrationId), sql`${contactRegistrations.eventId} = ${eventId}`)!,
  };
}
const orUndefined = <T>(value: T | null | undefined) => value ?? undefined;

/**
 * Everything a delivery is checked and rendered against (4.2): one statement
 * for the event, client, config, participant, registration, the meeting,
 * connection or message it names, the counterpart and any block between them
 * (and the challenge and consent form of a sign-in code), plus one for push
 * subscriptions when `subscriptions` is true (the default). Two round trips
 * at most; the worker calls it once per claim and once per channel.
 */
export async function networkingDeliveryContext(
  row: NetworkingDeliveryRow,
  options: { subscriptions?: boolean } = {},
) {
  const db = getDb();
  const otp = row.type === "OTP";
  const joins = relationJoins(events.id, {
    meetingId: idText(row.payload.meetingId),
    connectionId: idText(row.payload.connectionId),
    messageId: idText(row.payload.messageId),
  });
  const [base] = await db
    .select({
      event: events,
      client: clients,
      config: networkingConfigs.config,
      profile: networkingProfiles,
      registration: registrations,
      challenge: networkingChallenges,
      formSchema: forms.schema,
      ...relationColumns,
    })
    .from(events)
    .leftJoin(clients, eq(clients.id, events.clientId))
    .leftJoin(networkingConfigs, eq(networkingConfigs.eventId, events.id))
    .leftJoin(networkingProfiles, and(idMatch(networkingProfiles.id, row.profileId ?? undefined), eq(networkingProfiles.eventId, events.id)))
    .leftJoin(registrations, and(eq(registrations.id, networkingProfiles.registrationId), eq(registrations.eventId, events.id)))
    .leftJoin(networkingMeetings, joins.meeting)
    .leftJoin(networkingTables, joins.table)
    .leftJoin(networkingConnections, joins.connection)
    .leftJoin(networkingMessages, joins.message)
    .leftJoin(contactProfiles, joins.contact)
    .leftJoin(contactRegistrations, joins.contactRegistration)
    .leftJoin(networkingChallenges, and(
      idMatch(networkingChallenges.id, otp ? idText(row.payload.challengeId) : undefined),
      eq(networkingChallenges.eventId, events.id),
    ))
    // OTP only: undecided registrants sign in to give consent in the PWA (K1b).
    .leftJoin(forms, and(
      otp ? sql`NOT ${networkingProfiles.consent}` : sql`false`,
      eq(forms.id, registrations.formId),
      eq(forms.eventId, events.id),
    ))
    .where(eq(events.id, row.eventId));
  const subscriptions = options.subscriptions !== false && row.profileId && base?.profile
    ? await db
        .select()
        .from(networkingPushSubscriptions)
        .where(
          and(
            eq(networkingPushSubscriptions.profileId, row.profileId),
            eq(networkingPushSubscriptions.eventId, row.eventId),
          ),
        )
    : [];
  const config = NetworkingConfigSchema.parse(base?.config ?? {});
  const profile = orUndefined(base?.profile);
  const registration = orUndefined(base?.registration);
  const formSchema = base?.formSchema;
  const consentPending = formSchema != null && !!profile && !!registration && networkingConsentPending({
    profile, optIn: registration.networkingOptIn, formSchema, formData: registration.formData, config,
  });
  return {
    event: orUndefined(base?.event),
    client: orUndefined(base?.client),
    profile,
    registration,
    meeting: orUndefined(base?.meeting),
    table: orUndefined(base?.table),
    contact: orUndefined(base?.contact),
    contactRegistration: orUndefined(base?.contactRegistration),
    connection: orUndefined(base?.connection),
    message: orUndefined(base?.message),
    blocked: base?.blocked === true,
    challenge: orUndefined(base?.challenge),
    subscriptions,
    config,
    consentPending,
  };
}
export type NetworkingDeliveryContext = Awaited<ReturnType<typeof networkingDeliveryContext>>;

/**
 * A daily digest's unread notifications, each with the relations it names
 * (meeting, connection, message, counterpart, block), in one statement. The
 * event, participant, registration and config come from `base`, the
 * digest's own context.
 */
export async function networkingDigestContexts(
  row: NetworkingDeliveryRow,
  base: NetworkingDeliveryContext,
) {
  const ids = Array.isArray(row.payload.notificationIds)
    ? row.payload.notificationIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  if (!row.profileId || !ids.length) return [];
  const n = networkingNotifications;
  const joins = relationJoins(n.eventId, {
    meetingId: sql`(${n.data} ->> 'meetingId')`,
    connectionId: sql`(${n.data} ->> 'connectionId')`,
    messageId: sql`(${n.data} ->> 'messageId')`,
  });
  const rows = await getDb()
    .select({ notification: n, ...relationColumns })
    .from(n)
    .innerJoin(networkingProfiles, and(eq(networkingProfiles.id, n.profileId), eq(networkingProfiles.eventId, n.eventId)))
    .leftJoin(networkingMeetings, joins.meeting)
    .leftJoin(networkingTables, joins.table)
    .leftJoin(networkingConnections, joins.connection)
    .leftJoin(networkingMessages, joins.message)
    .leftJoin(contactProfiles, joins.contact)
    .leftJoin(contactRegistrations, joins.contactRegistration)
    .where(
      and(
        eq(n.eventId, row.eventId),
        eq(n.profileId, row.profileId),
        inArray(n.id, ids),
        sql`(${n.readAt} IS NULL OR ${n.type}='POST_EVENT_CONTACTS')`,
      ),
    )
    .orderBy(n.createdAt, n.id);
  return rows.map((item) => ({
    notification: item.notification,
    context: {
      ...base,
      meeting: orUndefined(item.meeting),
      table: orUndefined(item.table),
      contact: orUndefined(item.contact),
      contactRegistration: orUndefined(item.contactRegistration),
      connection: orUndefined(item.connection),
      message: orUndefined(item.message),
      blocked: item.blocked === true,
      challenge: undefined,
      consentPending: false,
    } satisfies NetworkingDeliveryContext,
  }));
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
