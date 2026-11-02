import { describe, expect, it } from "vitest";
import { NetworkingConfigSchema } from "@app/contracts";
import type { NetworkingDeliveryRow } from "@app/db";
import { NETWORKING_ELIGIBILITY_MATRIX, networkingEligibilityRowFacts } from "@app/db/testing";
import { networkingDeliverySkipReason } from "./delivery-policy";
import { networkingMeetingAttachment, renderNetworkingNotification, type NetworkingNotificationContext } from "./notification-rendering";

const now = new Date("2099-04-19T10:00:00.000Z");
const context = (consentPending: boolean) => ({
  event: { id: "event", status: "OPEN", clientId: "client", endDate: new Date("2099-04-20T00:00:00.000Z") },
  client: { active: true, enabledModules: ["networking", "registrations", "emails"] },
  config: NetworkingConfigSchema.parse({ enabled: true }),
  profile: { id: "p", eventId: "event", status: "ACTIVE", consent: false, withdrawnAt: null, erasedAt: null, email: "ann@example.test", emailPreference: "IMMEDIATE" },
  registration: { id: "r", eventId: "event", networkingOptIn: null, paymentStatus: "PAID" },
  challenge: { consumedAt: null, attempts: 0, expiresAt: new Date(now.getTime() + 600_000), email: "ann@example.test" },
  subscriptions: [], blocked: false, consentPending,
}) as unknown as NetworkingNotificationContext;
const row = (type: string) => ({ id: "d", type, eventId: "event", profileId: "p", payload: {} }) as unknown as NetworkingDeliveryRow;

describe("OTP delivery for undecided registrants (K1b)", () => {
  it("delivers the sign-in code to a consent-pending registrant", () => {
    expect(networkingDeliverySkipReason(row("OTP"), context(true), now)).toBeUndefined();
  });
  it("still refuses a registrant who is not consent-pending", () => {
    expect(networkingDeliverySkipReason(row("OTP"), context(false), now)).toBe("participant_ineligible");
  });
  it("never extends the exception beyond sign-in codes", () => {
    expect(networkingDeliverySkipReason(row("APPROVAL"), context(true), now)).toBe("participant_ineligible");
  });
});

describe("the eligibility matrix through the delivery policy and rendering (4.6)", () => {
  const viewer = {
    id: "viewer", eventId: "event", status: "ACTIVE", consent: true, withdrawnAt: null, erasedAt: null,
    email: "viewer@example.invalid", emailPreference: "IMMEDIATE", language: "en", firstName: "Viewer", lastName: "Test",
  };
  const viewerRegistration = { id: "viewer-registration", eventId: "event", networkingOptIn: true, paymentStatus: "PAID" };
  const base = context(false);
  const skip = (type: string, ctx: Record<string, unknown>, payload: Record<string, unknown> = {}) =>
    networkingDeliverySkipReason({ ...row(type), payload } as NetworkingDeliveryRow, { ...base, ...ctx } as NetworkingNotificationContext, now);
  it.each(NETWORKING_ELIGIBILITY_MATRIX.map((entry, index) => [entry.name, entry, index] as const))("%s", (_name, entry, index) => {
    const facts = networkingEligibilityRowFacts(entry, { eventId: "event", otherEventId: "other-event", targetId: `target-${index}`, viewer });
    // Addressed to the target: its own access (a sign-in code also reaches CONSENT_PENDING).
    const own = { profile: { ...facts.profile, emailPreference: "IMMEDIATE" }, registration: facts.registration, consentPending: facts.consentPending };
    expect(skip("APPROVAL", own) === undefined).toBe(entry.expect.access === "CONSENTED");
    expect(skip("OTP", { ...own, challenge: { ...base.challenge!, email: facts.profile.email } }) === undefined).toBe(entry.expect.access !== null);
    // Naming the target to the viewer: counterpart in `peer` mode.
    const connection = { id: "c", profileAId: viewer.id, profileBId: facts.profile.id, readAAt: null, readBAt: null };
    const startsAt = new Date(now.getTime() + 3_600_000);
    const meeting = {
      id: "m", status: "CONFIRMED", requesterId: viewer.id, recipientId: facts.profile.id, revision: 1, startsAt,
      endsAt: new Date(startsAt.getTime() + 1_800_000), expiresAt: startsAt, updatedAt: now, proposedStartsAt: null, message: "", cancellationNote: "",
    };
    const counterpart = {
      profile: viewer, registration: viewerRegistration, contact: facts.profile, contactRegistration: facts.registration, blocked: facts.blocked,
    };
    expect(skip("MATCH", { ...counterpart, connection }) === undefined).toBe(entry.expect.peer);
    expect(skip("MEETING_REMINDER_HOUR", { ...counterpart, meeting }, { revision: 1 }) === undefined).toBe(entry.expect.peer);
    const rendered = renderNetworkingNotification("MATCH", {}, { ...base, ...counterpart, connection } as unknown as NetworkingNotificationContext);
    expect(rendered.plainText.includes(`Target ${entry.name}`)).toBe(entry.expect.peer);
    const [ics] = networkingMeetingAttachment({ ...base, ...counterpart, meeting } as unknown as NetworkingNotificationContext);
    expect(Buffer.from(ics!.content, "base64").toString().replace(/\r\n /g, "").includes("Target")).toBe(entry.expect.peer);
  });
  it("skips everything once retention ends, and only live notices once networking closes", () => {
    const own = { profile: { ...viewer }, registration: viewerRegistration };
    const closed = { config: NetworkingConfigSchema.parse({ enabled: true, closesAt: "2099-04-19T09:00:00.000Z" }) };
    expect(skip("APPROVAL", { ...own, ...closed })).toBe("networking_closed");
    expect(skip("DAILY_DIGEST", { ...own, ...closed, profile: { ...viewer, emailPreference: "DAILY" } })).toBeUndefined();
    const ended = { event: { ...base.event!, endDate: new Date("2099-01-01T00:00:00.000Z") } };
    expect(skip("DAILY_DIGEST", { ...own, ...ended, profile: { ...viewer, emailPreference: "DAILY" } })).toBe("networking_closed");
    expect(skip("POST_EVENT_CONTACTS", { ...own, ...ended })).toBe("networking_closed");
  });
  it("still sends a cancellation about a counterpart who lost eligibility, never across a block", () => {
    const cancelled = {
      id: "m", status: "CANCELLED", requesterId: viewer.id, recipientId: "gone", revision: 1, startsAt: new Date(now.getTime() + 3_600_000),
      expiresAt: now,
    };
    const gone = { ...viewer, id: "gone", email: "gone@example.invalid", status: "SUSPENDED" };
    const ctx = { profile: viewer, registration: viewerRegistration, meeting: cancelled, contact: gone, contactRegistration: viewerRegistration };
    expect(skip("MEETING_CANCELLED", ctx, { revision: 1 })).toBeUndefined();
    expect(skip("MEETING_CANCELLED", { ...ctx, blocked: true }, { revision: 1 })).toBe("participants_blocked");
  });
});
