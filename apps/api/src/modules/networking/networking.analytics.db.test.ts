import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NetworkingConfigSchema } from "@app/contracts";
import { clients, getDb, networkingPostEventReportData, networkingStore, type NetworkingRow } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { NETWORKING_ENGAGEMENT_LIMIT, networkingAnalytics } from "./networking.analytics";
import { networkingAnalyticsV1 } from "./__testing__/networking-analytics-v1";
import { buildEligibilityMatrix, insertMatrixParticipant, type Matrix, type MatrixScope } from "./__testing__/eligibility-matrix-db";

/**
 * Plan 4.9 golden test: the organizer analytics as SQL aggregates against the
 * pre-4.9 in-memory calculator (kept verbatim in `__testing__`), on the
 * eligibility-matrix fixtures (4.6: every profile state, erased tombstones
 * included) plus activity touching every figure, in a timezone where the UTC
 * and local days differ. The only intended differences are checked
 * separately: `engagement` is the top rows plus `engagementTotal`, and likes
 * and passes are the interests as they stand (the post-event report's
 * definition), not every swipe gesture.
 */
const ids = { client: randomUUID(), other: randomUUID(), access: randomUUID(), rich: randomUUID(), gestures: randomUUID() };
const scope: MatrixScope = { clientId: ids.client, otherEventId: ids.other, accessId: ids.access };
const timezone = "Africa/Tunis";
const config = NetworkingConfigSchema.parse({
  enabled: true,
  approvalMode: "AUTOMATIC",
  timezone,
  eligiblePaymentStatuses: ["PAID"],
  // 09:00–12:00 in Tunis (08:00–11:00 UTC): the table-occupancy inventory.
  openingHours: [{ date: "2031-05-05", start: "09:00", end: "12:00" }],
});
const eventDates = { startDate: new Date("2031-05-05T00:00:00Z"), endDate: new Date("2031-05-06T22:00:00Z") };
const now = new Date("2031-05-05T10:00:00Z");
const minutes = (count: number) => count * 60_000;
let rich: Matrix;

const byKey = <T>(rows: T[], key: (row: T) => string) => [...rows].sort((a, b) => key(a).localeCompare(key(b)));
function comparable<T extends { sectors: { sector: string }[]; zones: { zone: string }[]; tableUsage: { tableId: string }[]; engagement: { profileId: string }[] }>(result: T) {
  return {
    ...result,
    sectors: byKey(result.sectors, (row) => row.sector),
    zones: byKey(result.zones, (row) => row.zone),
    tableUsage: byKey(result.tableUsage, (row) => row.tableId),
    engagement: byKey(result.engagement, (row) => row.profileId),
  };
}

async function audit(eventId: string, actorId: string, action: string, targetId: string, createdAt: Date) {
  await networkingStore(getDb()).insert("audit", { eventId, actorId, action, targetId, data: {}, createdAt });
}

/** Activity on top of the matrix: every analytics figure gets non-zero input, around local midnight. */
async function addActivity(matrix: Matrix) {
  const store = networkingStore(getDb());
  const eventId = matrix.event.id;
  const { viewer, targets } = matrix;
  const stamp = (index: number) => new Date(Date.parse("2031-05-04T22:30:00Z") + minutes(index * 13));
  const hall = await store.insert("spaces", { eventId, name: "Hall A", location: "North", active: true });
  const closed = await store.insert("spaces", { eventId, name: "Hall B", active: false });
  const table1 = await store.insert("tables", { eventId, name: "T1", spaceId: hall.id, location: "Zone 1" });
  const table2 = await store.insert("tables", { eventId, name: "T2", location: "Zone 2" });
  const table3 = await store.insert("tables", { eventId, name: "T3", spaceId: closed.id, location: "Zone 3" });
  // One stand per target, owned by it: a station only while its representative is active.
  const stands = new Map<string, NetworkingRow<"tables">>();
  for (const target of targets)
    stands.set(target.profile.id, await store.insert("tables", { eventId, name: `Stand ${target.row.name}`, kind: "STAND", ownerProfileId: target.profile.id }));
  // The matrix meetings (viewer → target) spread over every status, place and arrival.
  for (const [index, target] of targets.entries()) {
    if (!target.meeting) continue;
    const startsAt = target.meeting.startsAt;
    const plan: Array<Partial<NetworkingRow<"meetings">>> = [
      { tableId: table1.id, status: "CONFIRMED", requesterCheckedInAt: new Date(+startsAt + minutes(3)), recipientCheckedInAt: new Date(+startsAt + minutes(5)) },
      { tableId: table2.id, status: "COMPLETED", requesterCheckedInAt: new Date(+startsAt - minutes(2)) },
      { tableId: stands.get(target.profile.id)!.id, status: "NO_SHOW", recipientCheckedInAt: new Date(+startsAt + minutes(12)) },
      { tableId: table3.id, status: "CANCELLED" },
      { status: "PENDING" },
      { status: "PENDING_ALLOCATION" },
      { tableId: stands.get(target.profile.id)!.id, status: "CONFIRMED" },
    ];
    await store.update("meetings", { eventId, id: target.meeting.id }, { ...plan[index % plan.length], createdAt: stamp(index) });
  }
  // Booked meetings between two targets too (sectors on both sides, a converted connection).
  const [first, second, third] = targets;
  await store.insert("meetings", {
    eventId, requesterId: first.profile.id, recipientId: second.profile.id, status: "COMPLETED", tableId: table1.id,
    startsAt: new Date("2031-05-05T09:30:00Z"), endsAt: new Date("2031-05-05T10:00:00Z"), expiresAt: new Date("2031-05-05T09:30:00Z"),
    createdAt: stamp(40),
  });
  // In the closed hall: its zone still counts the meeting, the table offers no station.
  await store.insert("meetings", {
    eventId, requesterId: first.profile.id, recipientId: third.profile.id, status: "CONFIRMED", tableId: table3.id,
    startsAt: new Date("2031-05-05T10:30:00Z"), endsAt: new Date("2031-05-05T11:00:00Z"), expiresAt: new Date("2031-05-05T10:30:00Z"),
    createdAt: stamp(44),
  });
  // With an erased participant, in the opening hours: counted as a meeting, occupying no station.
  const erased = targets.find((target) => target.row.name === "erased tombstone")!;
  await store.insert("meetings", {
    eventId, requesterId: viewer.id, recipientId: erased.profile.id, status: "CONFIRMED", tableId: table2.id,
    startsAt: new Date("2031-05-05T09:00:00Z"), endsAt: new Date("2031-05-05T09:30:00Z"), expiresAt: new Date("2031-05-05T09:00:00Z"),
    createdAt: stamp(45),
  });
  const pair = [first.profile.id, second.profile.id].sort();
  const connection = await store.insert("connections", { eventId, profileAId: pair[0], profileBId: pair[1], createdAt: stamp(41) });
  await store.insert("messages", { eventId, connectionId: connection.id, senderId: first.profile.id, body: "Hi", clientMessageId: randomUUID(), createdAt: stamp(42) });
  // The viewer answers some conversations: responsive ones.
  for (const target of targets.filter((target) => target.connectionId).slice(0, 3))
    await store.insert("messages", { eventId, connectionId: target.connectionId!, senderId: viewer.id, body: "Hello back", clientMessageId: randomUUID(), createdAt: stamp(43) });
  // Swipes, each with its gesture: the viewer passes on twelve targets (ten-swipe engagement), some targets like the viewer.
  const liked = new Set((await store.all("interests", { eventId, profileId: viewer.id })).map((row) => row.targetId));
  let swipes = 0;
  for (const target of targets) {
    if (liked.has(target.profile.id) || swipes >= 12) continue;
    swipes++;
    await store.insert("interests", { eventId, profileId: viewer.id, targetId: target.profile.id, action: "PASS", createdAt: stamp(50 + swipes) });
    await audit(eventId, viewer.id, "SWIPE_PASS", target.profile.id, stamp(50 + swipes));
  }
  for (const target of targets.slice(0, 6)) {
    await store.insert("interests", { eventId, profileId: target.profile.id, targetId: viewer.id, action: "LIKE", createdAt: stamp(70) });
    await audit(eventId, target.profile.id, "SWIPE_LIKE", viewer.id, stamp(70));
  }
  await store.insert("interests", { eventId, profileId: second.profile.id, targetId: third.profile.id, action: "PASS" });
  await audit(eventId, second.profile.id, "SWIPE_PASS", third.profile.id, stamp(71));
  for (const [index, target] of targets.slice(0, 5).entries()) await audit(eventId, viewer.id, "PROFILE_VIEW", target.profile.id, stamp(80 + index));
  await audit(eventId, first.profile.id, "PROFILE_VIEW", viewer.id, stamp(90));
  await audit(eventId, viewer.id, "CONFIG_UPDATED", viewer.id, stamp(91));
  await store.insert("reports", { eventId, reporterId: viewer.id, profileId: first.profile.id, reason: "Spam" });
  await store.insert("reports", { eventId, reporterId: second.profile.id, profileId: viewer.id, reason: "Rude" });
  await store.insert("reports", { eventId, reporterId: viewer.id, profileId: third.profile.id, reason: "Other", status: "RESOLVED" });
  for (const profile of [viewer, first.profile, third.profile]) await store.update("profiles", { eventId, id: profile.id }, { lastActiveAt: stamp(95) });
  // Two connected, met participants of one sector: counted once for it.
  await store.update("profiles", { eventId, id: second.profile.id }, { sector: first.profile.sector });
  // A blank sector ("Unspecified" in analytics, a dash in the PDF).
  await store.update("profiles", { eventId, id: third.profile.id }, { sector: "" });
}

describe.runIf(dbTestsEnabled())("organizer analytics as SQL aggregates (4.9)", () => {
  beforeAll(async () => {
    await getDb().insert(clients).values({ id: ids.client, name: `Analytics ${ids.rich}`, enabledModules: ["networking", "registrations", "emails"] });
    await networkingStore(getDb()).insert("events", {
      id: ids.other, clientId: ids.client, name: "Other", slug: `analytics-${ids.other}`, status: "OPEN", ...eventDates,
    });
    rich = await buildEligibilityMatrix(scope, {
      eventId: ids.rich,
      config,
      ...eventDates,
      // 08:00 UTC onwards: 09:00 in Tunis, inside the opening hours for the first six.
      meetingAt: (index) => ({ startsAt: new Date(Date.parse("2031-05-05T08:00:00Z") + index * 1_800_000) }),
    });
    await addActivity(rich);
  });

  it("gives every figure of the pre-4.9 calculator on the eligibility matrix with activity", async () => {
    const before = await networkingAnalyticsV1(ids.rich, now);
    const { engagementTotal, ...after } = await networkingAnalytics(ids.rich, now);
    // Non-vacuous: the fixture drives every figure.
    for (const key of [
      "profiles", "activeProfiles", "visibleProfiles", "profileViews", "activationRate", "conversations", "responseRate",
      "meetingConversionRate", "likes", "passes", "matches", "matchRate", "interestReciprocityRate", "matchedParticipantsRate",
      "messagedParticipantsRate", "messages", "meetings", "plannedMeetings", "todayMeetings", "confirmedMeetings",
      "completedMeetings", "cancelledMeetings", "noShowMeetings", "pendingMeetings", "tableOccupancyRate",
      "engagementTenSwipes", "reports",
    ] as const)
      expect([key, before[key]]).not.toEqual([key, 0]);
    expect(before.punctuality.onTime).toBeGreaterThan(0);
    expect(before.punctuality.checkins).toBeGreaterThan(before.punctuality.onTime);
    expect(new Set(before.timeSeries.map((day) => day.date)).size).toBeGreaterThan(1);
    expect(before.zones.length).toBeGreaterThan(2);
    expect(before.sectors.some((row) => row.sector === "Unspecified")).toBe(true);

    expect(comparable(after)).toEqual(comparable(before));
    expect(engagementTotal).toBe(before.engagement.length);
    expect(after.engagement.length).toBe(Math.min(NETWORKING_ENGAGEMENT_LIMIT, before.engagement.length));
  });

  it("orders engagement by booked meetings, then matches, messages and swipes", async () => {
    const { engagement } = await networkingAnalytics(ids.rich, now);
    const key = (row: (typeof engagement)[number]) => [row.meetings, row.matches, row.messages, row.swipes];
    for (let index = 1; index < engagement.length; index++) {
      const [previous, current] = [key(engagement[index - 1]), key(engagement[index])];
      const first = previous.findIndex((value, position) => value !== current[position]);
      if (first >= 0) expect(previous[first]).toBeGreaterThan(current[first]);
      else expect(engagement[index - 1].profileId < engagement[index].profileId).toBe(true);
    }
    expect(engagement[0].profileId).toBe(rich.viewer.id);
  });

  it("gives a stand a meeting station only for an active representative (4.6 matrix)", async () => {
    const { tableUsage } = await networkingAnalytics(ids.rich, now);
    const usage = new Map(tableUsage.map((row) => [row.name, row.availableMinutes > 0]));
    expect(Object.fromEntries(rich.targets.map((target) => [target.row.name, usage.get(`Stand ${target.row.name}`)]))).toEqual(
      Object.fromEntries(rich.targets.map((target) => [target.row.name, target.row.expect.active])),
    );
  });

  it("shares its definitions with the post-event report", async () => {
    const analytics = await networkingAnalytics(ids.rich, now);
    const report = await networkingPostEventReportData(ids.rich, timezone);
    expect(report.summary).toMatchObject({
      participants: analytics.profiles,
      profile_views: analytics.profileViews,
      interests: analytics.likes,
      connections: analytics.matches,
      messages: analytics.messages,
      meeting_requests: analytics.meetings,
      meetings: analytics.plannedMeetings,
      pending_meetings: analytics.pendingMeetings,
      conversations: analytics.conversations,
      completed_meetings: analytics.completedMeetings,
      no_shows: analytics.noShowMeetings,
      cancelled_meetings: analytics.cancelledMeetings,
    });
    expect(report.summary.active_participants / report.summary.participants).toBe(analytics.activationRate);
    expect(report.summary.responsive_conversations / report.summary.conversations).toBe(analytics.responseRate);
    expect(report.timeSeries).toEqual(
      analytics.timeSeries
        .filter((day) => day.matches || day.messages || day.meetings)
        .map((day) => ({ date: day.date, connections: day.matches, messages: day.messages, meetings: day.meetings })),
    );
    expect(byKey(report.sectors.map((row) => ({ ...row, sector: row.sector || "Unspecified" })), (row) => row.sector)).toEqual(
      byKey(analytics.sectors.map((row) => ({ sector: row.sector, participants: row.participants, connections: row.matches, meetings: row.meetings })), (row) => row.sector),
    );
  });

  it("counts likes and passes as the interests stand, where the old calculator counted every gesture", async () => {
    const store = networkingStore(getDb());
    const event = await store.insert("events", {
      id: ids.gestures, clientId: ids.client, name: "Gestures", slug: `analytics-${ids.gestures}`, status: "OPEN", ...eventDates,
    });
    await store.insert("configs", { eventId: event.id, config });
    const formId = rich.formId;
    const people: NetworkingRow<"profiles">[] = [];
    for (const name of ["a", "b", "c", "d"]) {
      const id = randomUUID();
      people.push((await insertMatrixParticipant(scope, {
        eventId: event.id,
        formId,
        id,
        email: `${name}-${id}@example.invalid`,
        registration: { eventId: event.id, paymentStatus: "PAID", networkingOptIn: true },
        profile: { status: "ACTIVE", consent: true, firstName: name },
      })).profile);
    }
    const [a, b, c, d] = people;
    const at = new Date("2031-05-05T08:00:00Z");
    // a likes b, then changes it into a pass: one interest (PASS), two gestures.
    await store.upsertInterest(event.id, a.id, b.id, "LIKE");
    await audit(event.id, a.id, "SWIPE_LIKE", b.id, at);
    await store.upsertInterest(event.id, a.id, b.id, "PASS");
    await audit(event.id, a.id, "SWIPE_PASS", b.id, at);
    // c passes on d, then resets its passes: no interest, one gesture.
    await store.upsertInterest(event.id, c.id, d.id, "PASS");
    await audit(event.id, c.id, "SWIPE_PASS", d.id, at);
    await store.remove("interests", { eventId: event.id, profileId: c.id, action: "PASS" });
    // d likes c: one interest, one gesture.
    await store.upsertInterest(event.id, d.id, c.id, "LIKE");
    await audit(event.id, d.id, "SWIPE_LIKE", c.id, at);

    const before = await networkingAnalyticsV1(event.id, now);
    const after = await networkingAnalytics(event.id, now);
    const report = await networkingPostEventReportData(event.id, timezone);
    expect([before.likes, before.passes]).toEqual([2, 2]);
    expect([after.likes, after.passes, report.summary.interests]).toEqual([1, 1, 1]);
    const swipes = (rows: { profileId: string; swipes: number }[]) => Object.fromEntries(rows.map((row) => [row.profileId, row.swipes]));
    expect(swipes(before.engagement)).toEqual({ [a.id]: 2, [b.id]: 0, [c.id]: 1, [d.id]: 1 });
    expect(swipes(after.engagement)).toEqual({ [a.id]: 1, [b.id]: 0, [c.id]: 0, [d.id]: 1 });
    // Swipe activity by hour still counts every gesture.
    expect(after.hourlyActivity).toEqual(before.hourlyActivity);
  });
});
