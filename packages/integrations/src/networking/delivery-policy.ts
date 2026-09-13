import type { NetworkingDeliveryRow } from "@app/db";
import type { NetworkingNotificationContext } from "./notification-rendering";

export function networkingDeliverySkipReason(
  row: NetworkingDeliveryRow,
  ctx: NetworkingNotificationContext,
  now = new Date(),
): string | undefined {
  const {
    event,
    client,
    profile,
    registration,
    config,
    meeting,
    connection,
    message,
    challenge,
    contact,
    contactRegistration,
  } = ctx;
  if (
    !event ||
    !client?.active ||
    !config.enabled ||
    event.status === "ARCHIVED" ||
    !["networking", "registrations", "emails"].every((module) =>
      client.enabledModules?.includes(module),
    )
  )
    return "event_unavailable";
  if (row.type !== "POST_EVENT_CONTACTS" && row.type !== "DAILY_DIGEST" && config.closesAt && new Date(config.closesAt) <= now)
    return "networking_closed";
  const eligible = (person: typeof profile, registrant: typeof registration) =>
    !!person &&
    person.status === "ACTIVE" &&
    person.consent &&
    !person.withdrawnAt &&
    !!registrant &&
    registrant.eventId === row.eventId &&
    registrant.networkingOptIn !== false &&
    config.eligiblePaymentStatuses.includes(registrant.paymentStatus);
  if (!eligible(profile, registration)) return "participant_ineligible";
  if (
    row.type === "OTP" &&
    (!challenge ||
      challenge.consumedAt ||
      challenge.attempts >= 5 ||
      challenge.expiresAt <= now ||
      challenge.email.toLowerCase() !== profile!.email.toLowerCase())
  )
    return "code_expired";
  if (row.type === "MATCH" || row.type === "MESSAGE") {
    if (
      !connection ||
      ![connection.profileAId, connection.profileBId].includes(profile!.id)
    )
      return "connection_unavailable";
    if (
      row.type === "MESSAGE" &&
      (!config.chatEnabled || !message || message.senderId !== contact?.id)
    )
      return "message_unavailable";
    if (row.type === "MESSAGE" && message) {
      const readAt =
        connection.profileAId === profile!.id
          ? connection.readAAt
          : connection.readBAt;
      if (readAt && readAt >= message.createdAt) return "message_already_read";
    }
  }
  if (row.type.startsWith("MEETING_")) {
    if (
      !meeting ||
      ![meeting.requesterId, meeting.recipientId].includes(profile!.id) ||
      meeting.revision !== Number(row.payload.revision)
    )
      return "meeting_changed";
    if (
      row.type.startsWith("MEETING_REMINDER") &&
      (!config.meetingsEnabled ||
        meeting.status !== "CONFIRMED" ||
        meeting.startsAt <= now)
    )
      return "meeting_not_upcoming";
    if (
      ["MEETING_REQUEST", "MEETING_RESCHEDULE", "MEETING_RESCHEDULED"].includes(
        row.type,
      ) &&
      meeting.expiresAt <= now
    )
      return "proposal_expired";
  }
  if (
    (meeting || connection) &&
    (ctx.blocked || !eligible(contact, contactRegistration))
  )
    return ctx.blocked ? "participants_blocked" : "contact_ineligible";
  if (row.type === "DAILY_DIGEST" && profile!.emailPreference !== "DAILY")
    return "digest_preference_changed";
  return undefined;
}
