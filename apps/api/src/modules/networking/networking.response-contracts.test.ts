import "reflect-metadata";
import { PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import * as contracts from "@app/contracts";
import type { NetworkingRow } from "@app/db";
import { SKIP_ENVELOPE } from "../../core/envelope.interceptor";
import { projectOntoContract, RESPONSE_CONTRACT } from "../../core/response-contract";
import { NetworkingAdminController } from "./networking.admin.controller";
import { NetworkingPublicController } from "./networking.public.controller";
import { NetworkingMfaController } from "./networking.mfa.controller";
import { NetworkingRecommendationAdminController, NetworkingRecommendationsController } from "./networking-recommendations.controller";
import { NetworkingStreamController } from "./networking.stream.controller";
import { networkingPublicProfile } from "./networking.policy";
import { NetworkingService } from "./networking.service";

const date = new Date("2026-09-01T12:30:00Z");
const profile = {
  id: "profile", eventId: "event", registrationId: "registration", email: "person@example.test",
  firstName: "First", lastName: "Last", company: "Company", jobTitle: "Director", sector: "Health",
  bio: "Bio", city: "Tunis", country: "Tunisia", website: null, photoUrl: null,
  interests: ["Research"], offers: "Support", seeks: "Partners", status: "ACTIVE",
  visible: true, meetingsEnabled: true, consent: true, availabilitySet: true, featured: false,
  emailPreference: "IMMEDIATE", language: "fr", createdAt: date, updatedAt: date,
  consentAt: date, lastActiveAt: date, withdrawnAt: null, erasedAt: null, standTableId: null,
  overrides: { company: "Company" },
} satisfies NetworkingRow<"profiles">;
const visible = networkingPublicProfile(profile);
const space = { id: "space", eventId: "event", name: "Hall", kind: "TABLE", capacity: 2, location: "Floor 1", active: true, createdAt: date, updatedAt: date } satisfies NetworkingRow<"spaces">;
const table = { ...space, id: "table", spaceId: space.id, ownerProfileId: null } satisfies NetworkingRow<"tables">;
const tableWithSpace = { ...table, space };
const tableWithPeople = { ...tableWithSpace, representativeIds: [profile.id], representatives: [{ id: profile.id, firstName: profile.firstName, lastName: profile.lastName, company: profile.company }] };
const meeting = {
  id: "meeting", eventId: "event", requesterId: profile.id, recipientId: "other", tableId: table.id,
  message: "Meet?", status: "CONFIRMED", createdAt: date, updatedAt: date, expiresAt: date,
  startsAt: date, endsAt: date, cancellationNote: "", proposedStartsAt: null, proposalBy: null,
  revision: 1, requesterCheckedInAt: null, recipientCheckedInAt: null,
} satisfies NetworkingRow<"meetings">;
const adminMeeting = { ...meeting, requester: profile, recipient: null, table: tableWithSpace };
const participantMeeting = { ...meeting, requester: visible, recipient: null, table: tableWithSpace };
const message = { id: "message", eventId: "event", connectionId: "connection", senderId: profile.id, body: "Hello", clientMessageId: "client-message", createdAt: date } satisfies NetworkingRow<"messages">;
const report = { id: "report", eventId: "event", profileId: "other", reporterId: profile.id, messageId: message.id, reason: "Spam", status: "OPEN", note: null, resolvedBy: null, resolvedAt: null, createdAt: date, updatedAt: date } satisfies NetworkingRow<"reports">;
const connection = { id: "connection", profile: visible, createdAt: date, unreadCount: 1, lastMessage: { id: message.id, connectionId: message.connectionId, senderId: message.senderId, body: message.body, createdAt: date } };
const config = { ...contracts.NetworkingConfigSchema.parse({ enabled: true }), revision: "revision" };
const sync = { runId: "run", status: "RUNNING", total: 3, processed: 1, created: 1, updated: 0, failed: 0, requestedAt: date, finishedAt: null, lastError: null };
const page = (row: unknown) => ({ items: [row], total: 1 });
const cursorPage = (row: unknown) => ({ ...page(row), nextCursor: null });

type Controller = { prototype: object; name: string };
const families = [
  NetworkingAdminController, NetworkingPublicController, NetworkingMfaController,
  NetworkingRecommendationsController, NetworkingRecommendationAdminController, NetworkingStreamController,
];
function assertPayload(controller: Controller, method: string, payload: unknown) {
  const handler = (controller.prototype as Record<string, object>)[method];
  const schema = Reflect.getMetadata(RESPONSE_CONTRACT, handler) as ZodType;
  expect(schema, `${controller.name}.${method}`).toBeDefined();
  const projected = projectOntoContract(schema, payload);
  expect(projected.stripped, method).toEqual([]);
  expect(JSON.stringify(projected.value), method).toBe(JSON.stringify(payload));
  expect(schema.safeParse(projected.value).error?.issues ?? [], method).toEqual([]);
}

// Explicit route fixtures use database row types and the actual public mapper;
// they are independent of the response schemas and exercise nested values.
const payloads: [Controller, Record<string, unknown>][] = [
  [NetworkingAdminController, {
    config, updateConfig: config, uploadLogo: { url: "https://example.test/logo", resource: config },
    sync, syncState: sync, profiles: page({ ...profile, matchCount: 1, meetingCount: 2 }),
    updateProfile: profile, spaces: page({ ...space, allocatedCount: 1 }), createSpace: space, updateSpace: space,
    removeSpace: { deleted: true }, tables: page(tableWithPeople),
    table: { ...tableWithSpace, representativeIds: [profile.id] }, updateTable: { ...tableWithSpace, representativeIds: [] },
    removeTable: { deleted: true }, meetings: page(adminMeeting), updateMeeting: adminMeeting,
    calendar: { date: "2026-09-01", timezone: "UTC", items: [{ ...adminMeeting, table: tableWithPeople }] },
    reports: page({ ...report, reporter: profile, profile: null, message }), moderate: report,
    audit: page({ id: "audit", eventId: "event", actorId: profile.id, action: "UPDATE", targetId: null, data: { field: { old: null, next: "new" } }, createdAt: date }),
    verifyBadge: { accessAllowed: true, profile: visible, accessId: null },
    regeneratePostEventReport: { deliveryId: "delivery", availableAt: date, version: "v1" },
    postEventReport: { available: true, url: "https://example.test/report", generatedAt: date.toISOString(), summary: { profiles: 1 } },
    analytics: {
      profileViews: 1, activationRate: 1, conversations: 1, responseRate: 1, meetingConversionRate: 1,
      profiles: 1, activeProfiles: 1, visibleProfiles: 1, likes: 1, passes: 0, matches: 1, matchRate: 1,
      messages: 1, meetings: 1, confirmedMeetings: 1, completedMeetings: 0, cancelledMeetings: 0,
      noShowMeetings: 0, pendingMeetings: 0, tableOccupancyRate: 1, reports: 0,
      emailSent: 1, emailDelivered: 1, emailOpened: 1, emailClicked: 0, emailFailed: 0,
      hourlyActivity: [{ hour: "12", activity: 1 }], timeSeries: [{ date: "2026-09-01", bookingRequests: 1, matches: 1, messages: 1, meetings: 1 }],
      sectors: [{ sector: "Health", participants: 1, matches: 1, meetings: 1 }],
      engagement: [{ profileId: profile.id, name: "First Last", matches: 1, messages: 1, meetings: 1 }], engagementTotal: 1,
    },
  }],
  [NetworkingPublicController, {
    registration: { enabled: true, opensAt: null, closesAt: null, approvalMode: "MANUAL", fieldMapping: { company: null }, networkingUrl: "https://example.test/e/event" },
    requestCode: { challengeId: "challenge" }, verifyCode: { token: "session", expiresAt: date, profile, requiresSecondFactor: true, mfaEnrollmentRequired: false },
    logout: { loggedOut: true }, me: profile, updateMe: profile,
    personalAnalytics: { currentEventId: "event", events: [{ eventId: "event", eventName: "Event", startsAt: date.toISOString(), endsAt: date.toISOString(), profileViews: 1, matches: 1, sentMessages: 1, plannedMeetings: 1, completedMeetings: 0 }] },
    uploadPhoto: { url: "https://example.test/photo", resource: profile },
    incomingInterests: cursorPage({ id: "interest", profile: visible, createdAt: date }),
    facets: { sectors: [{ value: "Health", count: 1 }], companies: [], cities: [], countries: [] },
    profiles: page(visible), representatives: { ...page(visible), exhibitor: { id: table.id, name: table.name, spaceName: null } },
    profile: visible, interest: { matched: true, connectionId: connection.id }, resetInterests: { reset: true },
    connections: cursorPage(connection), connectionWith: { connection }, connection,
    messages: { ...page(message), nextCursor: { before: date.toISOString(), beforeId: message.id } }, message,
    read: { read: true }, blocks: page({ id: "block", eventId: "event", profileId: profile.id, targetId: "other", createdAt: date, profile: null }),
    block: { blocked: true }, unblock: { unblocked: true }, report,
    availability: { slots: [date.toISOString()], freeSlots: [], bookedSlots: [], availableSlots: [] },
    updateAvailability: { slots: [] }, profileAvailability: { slots: [], availableSlots: [] },
    listMeetings: cursorPage(participantMeeting), meeting: participantMeeting, createMeeting: participantMeeting, respond: participantMeeting, checkin: participantMeeting,
    badge: { accessAllowed: true, token: "badge", expiresAt: date.toISOString(), profileId: profile.id },
    notifications: { ...page({ id: "notification", eventId: "event", profileId: profile.id, type: "MESSAGE", title: "Hello", body: "Message", href: "/messages", data: { connectionId: connection.id }, readAt: null, createdAt: date }), unreadCount: 1, unreadMessageCount: 1 },
    readNotifications: { read: true }, subscribe: { id: "push", eventId: "event", profileId: profile.id, endpoint: "https://push.example.test", keys: { p256dh: "key", auth: "auth" }, expirationTime: null, createdAt: date },
    unsubscribe: { unsubscribed: true }, withdraw: { withdrawn: true },
  }],
  [NetworkingMfaController, {
    state: { enabled: true, required: true, verified: false }, enroll: { secret: "secret", otpauthUri: "otpauth://totp/test" },
    confirm: { verified: true, recoveryCodes: ["recovery"] }, verify: { verified: true, recoveryCodesOutdated: true },
    regenerateRecoveryCodes: { verified: true, recoveryCodes: ["new-recovery"] }, disable: { verified: true },
  }],
  [NetworkingRecommendationsController, { recommendations: { ...page({ ...visible, score: 0.5, reasons: ["Health"] }), strategy: "VECTOR", model: "model" } }],
  [NetworkingRecommendationAdminController, { status: { configured: true, model: "model", dimensions: 1536, jobs: [{ status: "PENDING", count: 1 }] }, reindex: { queued: 1 } }],
];

describe("networking response compatibility", () => {
  for (const [controller, samples] of payloads) for (const [method, payload] of Object.entries(samples)) {
    it(`${controller.name}.${method} preserves existing values and serialized bytes`, () => assertPayload(controller, method, payload));
  }

  it("validates the actual public-config builder and accounts for every JSON route", async () => {
    const service = new NetworkingService();
    vi.spyOn(service, "publicContext").mockResolvedValue({ event: { id: "event", name: "Event", slug: "event", startDate: date, endDate: date, location: null, bannerUrl: null }, config: contracts.NetworkingConfigSchema.parse({ enabled: true }) } as never);
    const result = await service.publicConfig("event");
    assertPayload(NetworkingPublicController, "config", result);
    expect(Object.values(Object.fromEntries(payloads.map(([c, p]) => [c.name, p]))).reduce((sum, p) => sum + Object.keys(p).length, 1)).toBe(74);
  });

  it("preserves omitted optionals, disabled and empty branches", () => {
    assertPayload(NetworkingPublicController, "registration", { enabled: false });
    assertPayload(NetworkingPublicController, "representatives", { items: [], total: 0, exhibitor: null });
    assertPayload(NetworkingPublicController, "interest", { matched: false });
    assertPayload(NetworkingPublicController, "connectionWith", { connection: null });
    assertPayload(NetworkingPublicController, "connections", { items: [], nextCursor: null });
    assertPayload(NetworkingAdminController, "postEventReport", { available: false });
    assertPayload(NetworkingRecommendationsController, "recommendations", { items: [], total: 0, strategy: "PROFILE_RULES" });
  });

  it("drops future columns and private nested profile fields from participant meetings", () => {
    const injected = { ...participantMeeting, internalLease: "private", requester: { ...profile, otpHash: "private" }, table: { ...tableWithSpace, internalLock: true, space: { ...space, billingKey: "private" } } };
    const result = projectOntoContract(contracts.NetworkingPublicMeetingResponseSchema, injected);
    expect(JSON.stringify(result.value)).toBe(JSON.stringify(participantMeeting));
    expect(result.stripped).toEqual(expect.arrayContaining(["internalLease", "requester.email", "requester.registrationId", "requester.overrides", "requester.otpHash", "table.internalLock", "table.space.billingKey"]));
  });

  it("does not expose future auth state while retaining the intentional OTP and MFA credentials", () => {
    const payload = { token: "session", expiresAt: date, profile, requiresSecondFactor: false, mfaEnrollmentRequired: false };
    const result = projectOntoContract(contracts.NetworkingPublicVerifyCodeResponseSchema, { ...payload, tokenHash: "private", profile: { ...profile, mfaSecret: "private" } });
    expect(JSON.stringify(result.value)).toBe(JSON.stringify(payload));
    expect(result.stripped).toEqual(["profile.mfaSecret", "tokenHash"]);
  });
});

it("covers all networking JSON routes, with an explicit raw-download/SSE exemption list", () => {
  const covered: string[] = [], raw: string[] = [], missing: string[] = [];
  for (const controller of families) {
    const proto = controller.prototype as unknown as Record<string, object>;
    for (const key of Object.getOwnPropertyNames(proto)) {
      const handler = proto[key];
      if (key === "constructor" || typeof handler !== "function" || Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
      const name = `${controller.name}.${key}`;
      if (Reflect.getMetadata(SKIP_ENVELOPE, handler)) raw.push(name);
      else if (Reflect.getMetadata(RESPONSE_CONTRACT, handler)) covered.push(name);
      else missing.push(name);
    }
  }
  expect(missing).toEqual([]);
  expect(covered).toHaveLength(74);
  expect(raw.sort()).toEqual([
    "NetworkingAdminController.export", "NetworkingPublicController.calendar",
    "NetworkingPublicController.exportConnections", "NetworkingPublicController.exportMe",
    "NetworkingStreamController.stream",
  ]);
});
