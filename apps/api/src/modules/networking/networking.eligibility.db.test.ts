import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { NetworkingConfigSchema } from "@app/contracts";
import {
  claimNetworkingEmbeddingJobs,
  clients,
  countNetworkingConnectionSummaries,
  enqueueChangedNetworkingEmbeddings,
  eventAccess,
  getDb,
  getNetworkingEmbeddingHealth,
  getNetworkingRecommendationProfiles,
  isNetworkingAccessAllowed,
  listNetworkingConnectionSummaries,
  listNetworkingDiscovery,
  networkingDeliveryContext,
  networkingDirectoryFacets,
  networkingEmbeddingJobs,
  networkingEmbeddings,
  networkingIdentityEmail,
  networkingParticipantAccess,
  networkingParticipantExportContacts,
  networkingPostEventReportData,
  networkingStore,
  networkingUnreadMessageCount,
  queueNetworkingDailyDigests,
  queueNetworkingMeetingReminders,
  queueNetworkingPostEventDeliveries,
  rankNetworkingVectorCandidates,
  reindexNetworkingEvent,
  type NetworkingDeliveryRow,
  type NetworkingRow,
} from "@app/db";
import {
  dbTestsEnabled,
  NETWORKING_ELIGIBILITY_MATRIX,
  type NetworkingEligibilityRow,
} from "@app/db/testing";
import {
  networkingDeliverySkipReason,
  networkingMeetingAttachment,
  renderNetworkingNotification,
} from "@app/integrations";
import { networkingAnalytics } from "./networking.analytics";
import { buildEligibilityMatrix, type Matrix, type MatrixScope, type MatrixTarget } from "./__testing__/eligibility-matrix-db";
import { NetworkingAdminService } from "./networking.admin.service";
import { NetworkingExportsService } from "./networking.exports.service";
import type { NetworkingMeetingsService } from "./networking.meetings.service";
import type { NetworkingSocialService } from "./networking.social.service";
import { NetworkingService, type NetworkingContext } from "./networking.service";

/**
 * Plan 4.6: the declarative eligibility matrix, run against every surface that
 * filters participants, in a real database (both engines in CI). One eligible
 * viewer; one target per matrix row. Each surface must agree with the row's
 * declared answer, which the pure policy is held to in unit tests.
 *
 * Two copies of the matrix: an upcoming event (reads, deliveries, analytics,
 * embeddings) and one that ended two days ago with meetings starting within
 * the hour (the maintenance producers: reminders, digests, post-event notices).
 */
const service = new NetworkingService();
const model = "eligibility-matrix-model";
const ids = { client: randomUUID(), event: randomUUID(), ended: randomUUID(), other: randomUUID(), access: randomUUID() };
const config = NetworkingConfigSchema.parse({
  enabled: true,
  approvalMode: "AUTOMATIC",
  timezone: "UTC",
  eligiblePaymentStatuses: ["PAID"],
  requiredAccessId: ids.access,
  fieldMapping: { consent: "consent" },
});
const statuses = config.eligiblePaymentStatuses;
const unit = (dimension: number) => Array.from({ length: 1536 }, (_, i) => (i === dimension ? 1 : 0));
type Target = MatrixTarget;
let upcoming: Matrix;
let ended: Matrix;
let event: NetworkingRow<"events">;
let viewer: NetworkingRow<"profiles">;
let ctx: NetworkingContext;
let targets: Target[];

/** A zone where it is about noon now, so the 08:00 digest window is open whatever time CI runs. */
function middayZone(now = new Date()) {
  const offset = 12 - now.getUTCHours();
  return offset === 0 ? "UTC" : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

const scope: MatrixScope = { clientId: ids.client, otherEventId: ids.other, accessId: ids.access };
const buildMatrix = (input: Parameters<typeof buildEligibilityMatrix>[1]) => buildEligibilityMatrix(scope, input);

describe.runIf(dbTestsEnabled())("networking eligibility matrix on every surface (4.6)", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(clients).values({ id: ids.client, name: `Eligibility ${ids.event}`, enabledModules: ["networking", "registrations", "emails"] });
    await networkingStore().insert("events", {
      id: ids.other,
      clientId: ids.client,
      name: "Eligibility matrix (other event)",
      slug: `eligibility-${ids.other}`,
      status: "OPEN",
      startDate: new Date("2031-05-05T00:00:00Z"),
      endDate: new Date("2031-05-06T00:00:00Z"),
    });
    upcoming = await buildMatrix({
      eventId: ids.event,
      config,
      startDate: new Date("2031-05-05T00:00:00Z"),
      endDate: new Date("2031-05-06T00:00:00Z"),
      meetingAt: (index) => ({ startsAt: new Date(Date.parse("2031-05-05T09:00:00Z") + index * 1_800_000) }),
    });
    ({ event, viewer, targets } = upcoming);
    await db.insert(eventAccess).values({ id: ids.access, eventId: ids.event, name: "Networking area" });
    ctx = { event, config, profile: viewer, session: {} as NetworkingRow<"sessions"> };
    const now = Date.now();
    ended = await buildMatrix({
      eventId: ids.ended,
      config: { ...config, timezone: middayZone() },
      startDate: new Date(now - 3 * 86_400_000),
      endDate: new Date(now - 2 * 86_400_000),
      // Within the next hour, booked well before the one-hour reminder.
      meetingAt: (index) => ({ startsAt: new Date(now + 1_800_000 + index * 10_000), createdAt: new Date(now - 3 * 3_600_000) }),
      profile: { emailPreference: "DAILY" },
    });
    // Yesterday's unread update for everyone in the ended event: digest material.
    for (const profile of [ended.viewer, ...ended.targets.map((target) => target.profile)])
      await networkingStore().insert("notifications", {
        eventId: ids.ended,
        profileId: profile.id,
        type: "MATCH",
        title: "Update",
        body: "Update",
        createdAt: new Date(now - 86_400_000),
      });
    const embeddings: (typeof networkingEmbeddings.$inferInsert)[] = [];
    const embed = (profileId: string, dimension: number) => {
      for (const kind of ["PROFILE", "OFFER", "NEED"] as const)
        embeddings.push({ profileId, eventId: ids.event, kind, model, sourceHash: "matrix", embedding: unit(dimension) });
    };
    embed(viewer.id, 0);
    for (const [index, target] of targets.entries()) embed(target.profile.id, index + 1);
    await db.insert(networkingEmbeddings).values(embeddings);
  });

  const expected = (surface: keyof NetworkingEligibilityRow["expect"], filter: (target: Target) => boolean = () => true, of: Target[] = targets) =>
    Object.fromEntries(of.map((target) => [target.row.name, filter(target) && target.row.expect[surface] === true]));
  const actual = (present: (target: Target) => boolean, of: Target[] = targets) =>
    Object.fromEntries(of.map((target) => [target.row.name, present(target)]));
  const idsOf = (rows: { id: string }[]) => new Set(rows.map((row) => row.id));
  const count = (surface: keyof NetworkingEligibilityRow["expect"], filter: (target: Target) => boolean = () => true) =>
    targets.filter((target) => filter(target) && target.row.expect[surface] === true).length;

  it("builds one target per matrix row", () => {
    for (const matrix of [upcoming, ended])
      expect(matrix.targets.map((target) => target.row.name)).toEqual(NETWORKING_ELIGIBILITY_MATRIX.map((row) => row.name));
  });

  it("participant access: each target's own sign-in (snapshot + policy)", async () => {
    const store = networkingStore();
    const access: Record<string, unknown> = {};
    for (const target of targets) {
      const snapshot = await store.participantSnapshot({ eventId: ids.event, clientId: ids.client, profileId: target.profile.id });
      access[target.row.name] = snapshot ? networkingParticipantAccess(snapshot, snapshot.config) : "missing";
    }
    expect(access).toEqual(Object.fromEntries(targets.map((target) => [target.row.name, target.row.expect.access])));
  });

  it("service target(): profile mode, and discover mode for swipes", async () => {
    const seen = async (visible: boolean) => {
      const result: Record<string, boolean> = {};
      for (const target of targets) {
        try {
          await service.target(ctx, target.profile.id, networkingStore(), visible);
          result[target.row.name] = true;
        } catch (error) {
          if (!(error instanceof NotFoundException)) throw error;
          result[target.row.name] = false;
        }
      }
      return result;
    };
    expect(await seen(false)).toEqual(expected("profile"));
    expect(await seen(true)).toEqual(expected("discover"));
  });

  it("service blockedTarget(): the block list", async () => {
    const result: Record<string, boolean> = {};
    for (const target of targets) result[target.row.name] = (await service.blockedTarget(ctx, target.profile.id)) !== null;
    expect(result).toEqual(expected("blocklist"));
  });

  it("discovery lists, search, facets and fresh discovery", async () => {
    const listed = idsOf((await listNetworkingDiscovery(ids.event, viewer.id, statuses, { limit: 100 })).items);
    expect(actual((target) => listed.has(target.profile.id))).toEqual(expected("discover"));
    const searched = idsOf((await listNetworkingDiscovery(ids.event, viewer.id, statuses, { q: "Target", sort: "recommended", limit: 100 })).items);
    expect(actual((target) => searched.has(target.profile.id))).toEqual(expected("discover"));
    const fresh = idsOf((await listNetworkingDiscovery(ids.event, viewer.id, statuses, { excludeInteracted: true, limit: 100 })).items);
    expect(actual((target) => fresh.has(target.profile.id))).toEqual(expected("fresh"));
    const sectors = new Set((await networkingDirectoryFacets(ids.event, viewer.id, statuses)).sectors.map((facet) => facet.value));
    expect(actual((target) => sectors.has(target.profile.sector))).toEqual(expected("discover"));
  });

  it("recommendations: vector ranking and the recommended profiles", async () => {
    const ranked = new Set((await rankNetworkingVectorCandidates(ids.event, viewer.id, model, statuses, 100)).map((row) => row.profileId));
    expect(actual((target) => ranked.has(target.profile.id))).toEqual(expected("fresh"));
    const profiles = idsOf(await getNetworkingRecommendationProfiles(ids.event, targets.map((target) => target.profile.id), viewer.id, statuses));
    expect(actual((target) => profiles.has(target.profile.id))).toEqual(expected("fresh"));
  });

  it("connections, their count, unread messages and the contacts CSV: peer mode over the viewer's connections", async () => {
    const connected = (target: Target) => target.connected;
    const summaries = await listNetworkingConnectionSummaries(ids.event, viewer.id, statuses);
    const listed = new Set(summaries.map((summary) => summary.profile.id));
    expect(actual((target) => listed.has(target.profile.id))).toEqual(expected("peer", connected));
    expect(summaries.every((summary) => summary.unreadCount === 1)).toBe(true);
    const visible = targets.filter((target) => target.connected && target.row.expect.peer).length;
    expect(await countNetworkingConnectionSummaries(ids.event, viewer.id, statuses)).toBe(visible);
    expect(await networkingUnreadMessageCount(ids.event, viewer.id)).toBe(visible);
    // The post-event contacts CSV (each target's last name is its row name).
    const contacts = new Set((await networkingParticipantExportContacts(ids.event, viewer.id)).map((row) => row.lastName));
    expect(actual((target) => contacts.has(target.row.name))).toEqual(expected("peer", connected));
  });

  it("area admission: the badge and the check-in scan", async () => {
    const badge: Record<string, boolean> = {}, scan: Record<string, boolean> = {};
    for (const target of targets) {
      badge[target.row.name] = await service.areaAccess({ event, config, profile: target.profile });
      scan[target.row.name] = await isNetworkingAccessAllowed(ids.event, target.registrationId, ids.access);
    }
    expect(badge).toEqual(expected("admitted"));
    expect(scan).toEqual(expected("admitted"));
  });

  it("embeddings: reindex, the embedding status, the scheduled enqueue and the worker's claim", async () => {
    const db = getDb();
    const jobs = async () => new Set((await db.select({ id: networkingEmbeddingJobs.profileId }).from(networkingEmbeddingJobs)).map((row) => row.id));
    const clear = () => db.delete(networkingEmbeddingJobs);
    await clear();
    try {
      // Explicit reindex of the event.
      expect(await reindexNetworkingEvent(ids.event)).toBe(1 + count("embedded"));
      let queued = await jobs();
      expect(actual((target) => queued.has(target.profile.id))).toEqual(expected("embedded"));
      // The status counts exactly the embeddable profiles (all PENDING so far).
      const health = (await getNetworkingEmbeddingHealth(ids.event)).map((row) => ({ ...row, count: Number(row.count) }));
      expect(health).toEqual([{ status: "PENDING", count: 1 + count("embedded") }]);
      // The scheduled enqueue (all events: this file's database holds only the matrix).
      await clear();
      await enqueueChangedNetworkingEmbeddings(model, 1000);
      queued = await jobs();
      expect(actual((target) => queued.has(target.profile.id))).toEqual(expected("embedded"));
      // A job left for every target: the worker claims only embeddable ones.
      const due = { status: "PENDING" as const, availableAt: new Date(Date.now() - 60_000), attempts: 0 };
      await db
        .insert(networkingEmbeddingJobs)
        .values(targets.map((target) => ({ profileId: target.profile.id, ...due })))
        .onConflictDoUpdate({ target: networkingEmbeddingJobs.profileId, set: due });
      const claimed = new Set((await claimNetworkingEmbeddingJobs(1000)).map((job) => job.profile.id));
      expect(actual((target) => claimed.has(target.profile.id))).toEqual(expected("embedded"));
    } finally {
      await clear();
    }
  });

  it("deliveries: addressed to each target by its access, naming it to the viewer in peer mode (policy + rendering)", async () => {
    const store = networkingStore();
    const delivery = (type: string, profileId: string, payload: Record<string, unknown> = {}) =>
      ({ id: randomUUID(), eventId: ids.event, profileId, type, payload, status: "PROCESSING", attempts: 1 }) as unknown as NetworkingDeliveryRow;
    const sends = async (row: NetworkingDeliveryRow) => networkingDeliverySkipReason(row, await networkingDeliveryContext(row, { subscriptions: false })) === undefined;
    const approval: Record<string, boolean> = {}, otp: Record<string, boolean> = {};
    for (const target of targets) {
      approval[target.row.name] = await sends(delivery("APPROVAL", target.profile.id));
      const challenge = await store.insert("challenges", {
        eventId: ids.event,
        email: target.profile.email,
        codeHash: "matrix",
        expiresAt: new Date(Date.now() + 600_000),
      });
      otp[target.row.name] = await sends(delivery("OTP", target.profile.id, { challengeId: challenge.id }));
    }
    expect(approval).toEqual(Object.fromEntries(targets.map((target) => [target.row.name, target.row.expect.access === "CONSENTED"])));
    expect(otp).toEqual(Object.fromEntries(targets.map((target) => [target.row.name, target.row.expect.access !== null])));

    const match: Record<string, boolean> = {}, matchNamed: Record<string, boolean> = {};
    const reminder: Record<string, boolean> = {}, calendarNamed: Record<string, boolean> = {};
    for (const target of targets) {
      if (target.connectionId) {
        const row = delivery("MATCH", viewer.id, { connectionId: target.connectionId });
        const context = await networkingDeliveryContext(row, { subscriptions: false });
        match[target.row.name] = networkingDeliverySkipReason(row, context) === undefined;
        matchNamed[target.row.name] = renderNetworkingNotification("MATCH", {}, context).plainText.includes(`Target ${target.row.name}`);
      }
      if (target.meeting) {
        const row = delivery("MEETING_REMINDER_HOUR", viewer.id, { meetingId: target.meeting.id, revision: target.meeting.revision });
        const context = await networkingDeliveryContext(row, { subscriptions: false });
        reminder[target.row.name] = networkingDeliverySkipReason(row, context) === undefined;
        const [ics] = networkingMeetingAttachment(context);
        calendarNamed[target.row.name] = Buffer.from(ics!.content, "base64").toString().replace(/\r\n /g, "").includes("Target");
      }
    }
    const withConnection = targets.filter((target) => target.connectionId);
    const withMeeting = targets.filter((target) => target.meeting);
    expect(match).toEqual(expected("peer", () => true, withConnection));
    expect(matchNamed).toEqual(expected("peer", () => true, withConnection));
    expect(reminder).toEqual(expected("peer", () => true, withMeeting));
    expect(calendarNamed).toEqual(expected("peer", () => true, withMeeting));
  });

  it("organizer analytics, the post-event report, the admin list and the admin export: listed profiles", async () => {
    const analytics = await networkingAnalytics(ids.event);
    expect(analytics.profiles).toBe(1 + count("listed"));
    expect(analytics.activeProfiles).toBe(1 + count("active"));
    expect(analytics.visibleProfiles).toBe(1 + count("active", (target) => target.profile.visible));
    const sectorsOf = (rows: { sector: string }[]) => new Set(rows.map((row) => row.sector));
    let sectors = sectorsOf(analytics.sectors);
    expect(actual((target) => sectors.has(target.profile.sector))).toEqual(expected("listed"));

    const report = await networkingPostEventReportData(ids.event);
    expect(Number(report.summary.participants)).toBe(1 + count("listed"));
    sectors = sectorsOf(report.sectors);
    expect(actual((target) => sectors.has(target.profile.sector))).toEqual(expected("listed"));

    const admin = new NetworkingAdminService(service, {} as NetworkingMeetingsService);
    const listed = idsOf((await admin.profiles(ids.event, { page: 1, limit: 100 })).items);
    expect(listed.has(viewer.id)).toBe(true);
    expect(actual((target) => listed.has(target.profile.id))).toEqual(expected("listed"));

    const exports = new NetworkingExportsService(admin, {} as NetworkingSocialService, {} as NetworkingMeetingsService);
    const csv = String((await exports.admin(event, "participants", "csv")).body);
    // Target addresses are unique (the same-person row is the viewer's in upper case).
    expect(actual((target) => csv.includes(target.profile.email))).toEqual(expected("listed"));
  });

  it("personal analytics: the participant's own listed profiles", async () => {
    const own = (await networkingStore().personalAnalyticsProfiles(ids.client, networkingIdentityEmail(viewer.email)))
      .filter((profile) => profile.eventId === ids.event);
    const found = new Set(own.map((profile) => profile.id));
    expect(found.has(viewer.id)).toBe(true);
    expect(actual((target) => found.has(target.profile.id))).toEqual(expected("listed", (target) => !!target.row.profile?.sameEmailAsViewer));
  });

  it("maintenance producers: reminders in peer mode both ways, digests and post-event notices by access", async () => {
    const db = getDb();
    await queueNetworkingMeetingReminders(db, ids.ended);
    await queueNetworkingDailyDigests(db, ids.ended);
    await queueNetworkingPostEventDeliveries(db, ids.ended);
    const rows = await networkingStore().all("deliveries", { eventId: ids.ended });
    const queued = (type: string, profileId: string, meetingId?: string) =>
      rows.some((row) => row.type === type && row.profileId === profileId && (meetingId === undefined || row.payload.meetingId === meetingId));
    const of = ended.targets;
    const withMeeting = of.filter((target) => target.meeting);
    const peer = expected("peer", () => true, withMeeting);
    // The hour reminder of each confirmed meeting, to the target and to the viewer.
    expect(actual((target) => queued("MEETING_REMINDER_HOUR", target.profile.id, target.meeting!.id), withMeeting)).toEqual(peer);
    expect(actual((target) => queued("MEETING_REMINDER_HOUR", ended.viewer.id, target.meeting!.id), withMeeting)).toEqual(peer);
    const consented = Object.fromEntries(of.map((target) => [target.row.name, target.row.expect.access === "CONSENTED"]));
    expect(actual((target) => queued("DAILY_DIGEST", target.profile.id), of)).toEqual(consented);
    expect(actual((target) => queued("POST_EVENT_CONTACTS", target.profile.id), of)).toEqual(consented);
    for (const type of ["DAILY_DIGEST", "POST_EVENT_CONTACTS"]) expect(queued(type, ended.viewer.id)).toBe(true);
    expect(rows.filter((row) => row.type === "POST_EVENT_REPORT")).toHaveLength(1);
  });

  it("refuses every counterpart to a viewer who lost eligibility", async () => {
    const store = networkingStore();
    const eligibleTarget = targets.find((target) => target.row.name === "eligible")!;
    await store.update("profiles", { eventId: ids.event, id: viewer.id }, { status: "SUSPENDED" });
    try {
      await expect(service.target(ctx, eligibleTarget.profile.id)).rejects.toMatchObject({
        status: 403,
        response: { code: "NETWORKING_NOT_ELIGIBLE" },
      });
      await expect(service.blockedTarget(ctx, eligibleTarget.profile.id)).rejects.toMatchObject({ status: 403 });
    } finally {
      await store.update("profiles", { eventId: ids.event, id: viewer.id }, { status: "ACTIVE" });
    }
  });
});
