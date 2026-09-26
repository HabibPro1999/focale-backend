import { newId } from "@app/shared";
import { withSerializableTxn } from "../txn";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { NetworkingConfigSchema, networkingProfileOverrides, type NetworkingConfig } from "@app/contracts";
import { getDb, type DbExecutor } from "../client";
import {
  networkingConfigs,
  networkingProfiles,
  networkingNotifications,
  networkingDeliveries,
  networkingSessions,
  networkingMeetings,
} from "../schema/networking";
import { events } from "../schema/events-access";
import { forms } from "../schema/forms";
import { projectNetworkingFields, resolveNetworkingConsent } from "./networking-projection";
import { networkingMeetingNotice, transitionNetworkingMeetings } from "./networking-meetings";
import { signalNetworkingNotification } from "./networking-notices";
import { registrations } from "../schema/registrations";

export async function getNetworkingConfig(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<NetworkingConfig> {
  const [row] = await db
    .select()
    .from(networkingConfigs)
    .where(eq(networkingConfigs.eventId, eventId));
  return NetworkingConfigSchema.parse(row?.config ?? {});
}
export async function enqueueNetworkingDelivery(
  input: typeof networkingDeliveries.$inferInsert,
  db: DbExecutor = getDb(),
) {
  const [row] = await db
    .insert(networkingDeliveries)
    .values(input)
    .onConflictDoNothing({ target: networkingDeliveries.dedupeKey })
    .returning();
  return row ?? null;
}
type NetworkingNotificationInsert = typeof networkingNotifications.$inferInsert;
type NetworkingNotificationRow = typeof networkingNotifications.$inferSelect;

function notificationDelivery(id: string, input: NetworkingNotificationInsert, dedupeKey: string) {
  return {
    eventId: input.eventId,
    profileId: input.profileId,
    type: input.type,
    payload: {
      notificationId: id,
      title: input.title,
      body: input.body,
      href: input.href ?? "",
      ...input.data,
    },
    dedupeKey,
  };
}

/**
 * The one way to write a participant notification: the in-app row, its
 * delivery (push/email), and a signal to the participant's live streams
 * (published after commit in the api, else a `networking.notify` outbox row).
 *
 * With `dedupeKey`, at most one notification is ever written for that key:
 * the delivery's unique dedupe key decides, and a duplicate writes and
 * signals nothing (returns null).
 */
export async function createNetworkingNotification(
  input: NetworkingNotificationInsert,
  db?: DbExecutor,
): Promise<NetworkingNotificationRow>;
export async function createNetworkingNotification(
  input: NetworkingNotificationInsert,
  db: DbExecutor,
  options: { dedupeKey: string },
): Promise<NetworkingNotificationRow | null>;
export async function createNetworkingNotification(
  input: NetworkingNotificationInsert,
  db: DbExecutor = getDb(),
  options: { dedupeKey?: string } = {},
): Promise<NetworkingNotificationRow | null> {
  const id = input.id ?? newId();
  if (options.dedupeKey) {
    const delivery = await enqueueNetworkingDelivery(notificationDelivery(id, input, options.dedupeKey), db);
    if (!delivery) return null;
  }
  const [row] = await db
    .insert(networkingNotifications)
    .values({ ...input, id })
    .returning();
  if (!options.dedupeKey)
    await enqueueNetworkingDelivery(notificationDelivery(row.id, row, `notification:${row.id}`), db);
  await signalNetworkingNotification(db, { eventId: row.eventId, profileId: row.profileId, notificationId: row.id });
  return row;
}
export async function syncNetworkingRegistration(
  registrationId: string,
  db?: DbExecutor,
): Promise<{ created: number; updated: number }> {
  if (!db)
    return withSerializableTxn((tx) =>
      syncNetworkingRegistration(registrationId, tx),
    );
  const [registration] = await db
    .select()
    .from(registrations)
    .where(eq(registrations.id, registrationId));
  if (!registration) return { created: 0, updated: 0 };
  const config = await getNetworkingConfig(registration.eventId, db);
  const [existing] = await db
    .select()
    .from(networkingProfiles)
    .where(eq(networkingProfiles.registrationId, registration.id));
  // Withdrawal is final: a withdrawn profile (or its erased tombstone) is never
  // re-projected from the registration, and its row keeps a new one from being created.
  if (existing?.withdrawnAt) return { created: 0, updated: 0 };
  if (!config.enabled && !existing) return { created: 0, updated: 0 };
  const formData = (
    registration.formData && typeof registration.formData === "object"
      ? registration.formData
      : {}
  ) as Record<string, unknown>;
  const [form] = await db
    .select({ schema: forms.schema })
    .from(forms)
    .where(
      and(
        eq(forms.id, registration.formId),
        eq(forms.eventId, registration.eventId),
      ),
    );
  const { projection, consent: mapped } = projectNetworkingFields(
    form?.schema,
    formData,
    config,
  );
  const overrides = networkingProfileOverrides(existing?.overrides ?? {});
  // K1: an opt-in boolean decides; otherwise the participant's choice, then the mapped answer.
  const { consent, undecided } = resolveNetworkingConsent({
    optIn: registration.networkingOptIn,
    choice: overrides.consent,
    mapped,
    withdrawn: !!existing?.withdrawnAt,
  });
  const eligible = config.eligiblePaymentStatuses.includes(
    registration.paymentStatus as NetworkingConfig["eligiblePaymentStatuses"][number],
  );
  if (existing) {
    const values = {
      ...projection,
      ...overrides,
      email: registration.email.trim().toLowerCase(),
      firstName: registration.firstName ?? "",
      lastName: registration.lastName ?? "",
    };
    await db
      .update(networkingProfiles)
      .set({
        ...values,
        consent,
        ...(consent && !existing.consent ? { visible: true, consentAt: new Date() } : {}),
        ...(existing.status === "PENDING" &&
        config.approvalMode === "AUTOMATIC" &&
        eligible
          ? { status: "ACTIVE" as const }
          : {}),
        ...(!consent ? { visible: false } : {}),
        updatedAt: new Date(),
      })
      .where(eq(networkingProfiles.id, existing.id));
    // Undecided registrants keep their consent-pending sessions to opt in from the PWA.
    if (
      !eligible ||
      (!consent && !undecided) ||
      existing.email !== registration.email.trim().toLowerCase()
    )
      await db
        .update(networkingSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(networkingSessions.profileId, existing.id),
            isNull(networkingSessions.revokedAt),
          ),
        );
    if (!eligible || !consent)
      await cancelNetworkingParticipantMeetings(
        existing.id,
        registration.eventId,
        db,
      );
    if (
      eligible &&
      consent &&
      !existing.withdrawnAt &&
      (existing.status === "ACTIVE" ||
        (existing.status === "PENDING" && config.approvalMode === "AUTOMATIC"))
    )
      await queueNetworkingActivation(existing.id, registration.eventId, db);
    return { created: 0, updated: 1 };
  }
  const inserted = await db
    .insert(networkingProfiles)
    .values({
      eventId: registration.eventId,
      registrationId: registration.id,
      email: registration.email.trim().toLowerCase(),
      firstName: registration.firstName ?? "",
      lastName: registration.lastName ?? "",
      ...projection,
      consent,
      visible: consent,
      consentAt: consent ? new Date() : null,
      language: config.defaultLanguage,
      status:
        config.approvalMode === "AUTOMATIC" && eligible ? "ACTIVE" : "PENDING",
    })
    .onConflictDoNothing({ target: networkingProfiles.registrationId })
    .returning({ id: networkingProfiles.id });
  if (inserted[0] && consent && eligible && config.approvalMode === "AUTOMATIC")
    await queueNetworkingActivation(inserted[0].id, registration.eventId, db);
  return { created: inserted.length, updated: 0 };
}
export async function syncNetworkingEvent(eventId: string) {
  const rows = await getDb()
    .select({ id: registrations.id })
    .from(registrations)
    .where(eq(registrations.eventId, eventId));
  let created = 0,
    updated = 0;
  for (const row of rows) {
    const result = await syncNetworkingRegistration(row.id);
    created += result.created;
    updated += result.updated;
  }
  return { created, updated };
}
/** Captured before a registration delete cascades to its profile, for post-commit photo cleanup. */
export async function getNetworkingProfilePhotoByRegistration(
  registrationId: string,
  db: DbExecutor = getDb(),
) {
  const [row] = await db
    .select({ id: networkingProfiles.id, eventId: networkingProfiles.eventId, photoUrl: networkingProfiles.photoUrl })
    .from(networkingProfiles)
    .where(eq(networkingProfiles.registrationId, registrationId));
  return row ?? null;
}
export async function revokeNetworkingSessions(
  profileId: string,
  db: DbExecutor = getDb(),
) {
  await db
    .update(networkingSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(networkingSessions.profileId, profileId),
        isNull(networkingSessions.revokedAt),
      ),
    );
}

/**
 * Release future resources when registration approval/consent/eligibility is
 * revoked, the participant withdraws, is moderated, or (with `counterpartId`)
 * blocks someone: one CANCEL transition over the participant's open meetings
 * that have not ended, never a scan of the event's meeting history. Its notices
 * are confidential: they never name the other side or the cause (K5).
 * `slug` avoids re-reading the event row inside a networking transaction.
 */
export async function cancelNetworkingParticipantMeetings(
  profileId: string,
  eventId: string,
  db: DbExecutor = getDb(),
  options: { counterpartId?: string; slug?: string } = {},
) {
  const m = networkingMeetings;
  const rows = await transitionNetworkingMeetings(
    db,
    "CANCEL",
    eventId,
    and(
      options.counterpartId === undefined
        ? or(eq(m.requesterId, profileId), eq(m.recipientId, profileId))
        : or(
            and(eq(m.requesterId, profileId), eq(m.recipientId, options.counterpartId)),
            and(eq(m.requesterId, options.counterpartId), eq(m.recipientId, profileId)),
          ),
      gt(m.endsAt, new Date()),
    )!,
    { proposedStartsAt: null, proposalBy: null },
  );
  if (!rows.length) return [];
  const slug = options.slug ?? (
    await db.select({ slug: events.slug }).from(events).where(eq(events.id, eventId))
  )[0]?.slug ?? "";
  for (const row of rows)
    for (const recipient of [row.requesterId, row.recipientId])
      await createNetworkingNotification(
        networkingMeetingNotice(row, recipient, {
          type: "MEETING_CANCELLED",
          slug,
          reason: "UNAVAILABLE",
          confidential: true,
        }),
        db,
      );
  return rows;
}

/** One activation notification per profile, shared by automatic and organizer approvals. */
export async function queueNetworkingActivation(
  profileId: string,
  eventId: string,
  db: DbExecutor,
) {
  const [event] = await db
    .select({ slug: events.slug })
    .from(events)
    .where(eq(events.id, eventId));
  await createNetworkingNotification(
    {
      eventId,
      profileId,
      type: "APPROVAL",
      title: "Networking is ready",
      body: "Your networking participation is active.",
      href: `/e/${event.slug}`,
      data: { status: "ACTIVE" },
    },
    db,
    { dedupeKey: `networking-activation:${profileId}` },
  );
}
