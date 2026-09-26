import {
  networkingCounterpartVisible,
  networkingEventAvailable,
  networkingIdentityEmail,
  networkingParticipantAccess,
  networkingWindow,
  type NetworkingDeliveryRow,
} from "@app/db";
import type { NetworkingNotificationContext } from "./notification-rendering";

/** Contacts notices and digests still go out once networking closes (until retention ends). */
const SENT_AFTER_CLOSE = new Set(["POST_EVENT_CONTACTS", "DAILY_DIGEST"]);

/**
 * Why a delivery must not go out now, or undefined to send it. Eligibility is
 * the 4.6 policy: the event gate and window, the recipient's own access (a
 * sign-in code also reaches a consent-pending registrant, K1b) and, for a
 * meeting or connection, the counterpart in `peer` mode.
 */
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
  if (!event || !networkingEventAvailable({ event, client, config }))
    return "event_unavailable";
  const window = networkingWindow(config, event, now.getTime());
  if (window === "RETENTION_ENDED" || (window === "CLOSED" && !SENT_AFTER_CLOSE.has(row.type)))
    return "networking_closed";
  const otp = row.type === "OTP";
  if (!profile || !networkingParticipantAccess({ profile, registration, consentPending: otp && ctx.consentPending }, config, { allowConsentPending: otp }))
    return "participant_ineligible";
  if (
    row.type === "OTP" &&
    (!challenge ||
      challenge.consumedAt ||
      challenge.attempts >= 5 ||
      challenge.expiresAt <= now ||
      networkingIdentityEmail(challenge.email) !== networkingIdentityEmail(profile.email))
  )
    return "code_expired";
  if (row.type === "MATCH" || row.type === "MESSAGE") {
    if (
      !connection ||
      ![connection.profileAId, connection.profileBId].includes(profile.id)
    )
      return "connection_unavailable";
    if (
      row.type === "MESSAGE" &&
      (!config.chatEnabled || !message || message.senderId !== contact?.id)
    )
      return "message_unavailable";
    if (row.type === "MESSAGE" && message) {
      const readAt =
        connection.profileAId === profile.id
          ? connection.readAAt
          : connection.readBAt;
      if (readAt && readAt >= message.createdAt) return "message_already_read";
    }
  }
  if (row.type.startsWith("MEETING_")) {
    if (
      !meeting ||
      ![meeting.requesterId, meeting.recipientId].includes(profile.id) ||
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
  if (meeting || connection) {
    if (ctx.blocked) return "participants_blocked";
    const cancellation = meeting?.status === "CANCELLED" &&
      ["MEETING_CANCEL", "MEETING_CANCELLED"].includes(row.type);
    if (
      !cancellation &&
      !networkingCounterpartVisible(
        { viewer: profile, target: contact, targetRegistration: contactRegistration, blocked: ctx.blocked, connected: !!connection },
        config,
        "peer",
      )
    )
      return "contact_ineligible";
  }
  if (row.type === "DAILY_DIGEST" && profile.emailPreference !== "DAILY")
    return "digest_preference_changed";
  return undefined;
}
