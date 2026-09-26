import { withSerializableTxn } from "@app/db";
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { and, count, eq, inArray, is, or, sql, type SQL } from "drizzle-orm";
import { PgTable, getTableConfig, type PgColumn } from "drizzle-orm/pg-core";
import { getDb } from "../../../src/client";
import * as schema from "../../../src/schema";
import { emailLogs, networkingEmbeddingJobs, networkingEmbeddings, networkingProfiles, networkingSecondFactors } from "../../../src/schema";
import { networkingStore, networkingTransaction } from "../../../src/queries/networking-store";
import { syncNetworkingEvent, syncNetworkingRegistration } from "../../../src/queries/networking";
import {
  NETWORKING_PROFILE_TOMBSTONE,
  eraseWithdrawnNetworkingProfiles,
  withdrawNetworkingProfile,
} from "../../../src/queries/networking-erasure";
import { createNetworkingWriteFixture } from "../../helpers/networking-write-fixture";
import { dbTestsEnabled } from "../../helpers/test-env";

// Plan 4.4b: withdrawal scrubs at once; after the window the rest is erased and
// the profile row stays as a tombstone that registration sync never rewrites.
// The tables checked are derived from the schema's foreign keys to networking_profiles.
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const future = new Date("2031-08-01T09:00:00.000Z");
const past = new Date("2020-03-01T09:00:00.000Z");
const halfHour = (start: Date) => new Date(+start + 1_800_000);
type Fixture = Awaited<ReturnType<typeof createNetworkingWriteFixture>>;
const profileForeignKeys = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .flatMap((table) => getTableConfig(table).foreignKeys
    .map((foreignKey) => foreignKey.reference())
    .filter((reference) => reference.foreignTable === networkingProfiles)
    .map((reference) => ({ table, columns: reference.columns as PgColumn[] })));

async function rowsReferencing(profileId: string) {
  const counts: Record<string, number> = {};
  for (const { table, columns } of profileForeignKeys) {
    const [row] = await getDb().select({ n: count() }).from(table)
      .where(or(...columns.map((column) => eq(column, profileId))));
    const name = `${getTableConfig(table).name}.${columns.map((column) => column.name).join(",")}`;
    counts[name] = Number(row.n);
  }
  return counts;
}
const countWhere = async (table: PgTable, where: SQL | undefined) =>
  Number((await getDb().select({ n: count() }).from(table).where(where))[0].n);
const profileRow = async (id: string) => (await getDb().select().from(networkingProfiles).where(eq(networkingProfiles.id, id)))[0];

describe.runIf(dbTestsEnabled())("networking withdrawal and erasure", () => {
  let fixture: Fixture;
  let eventId: string;
  let a: string, b: string, c: string, d: string;
  const seeded: Record<string, string> = {};

  beforeAll(async () => {
    fixture = await createNetworkingWriteFixture({ size: 4, slots: [future], tables: 1, hash });
    eventId = fixture.event.id;
    [a, b, c, d] = fixture.participants.map((participant) => participant.profile.id);
    const store = networkingStore(getDb());
    const db = getDb();
    const profileA = fixture.participants[0].profile;
    const sorted = (x: string, y: string) => (x < y ? [x, y] : [y, x]);
    await store.update("profiles", { eventId, id: a }, {
      photoUrl: `https://cdn.test/networking/${eventId}/profiles/${a}/photo.webp`,
      company: "Override Co", bio: "Personal bio", website: "https://person.example.invalid", interests: ["robotics"],
      offers: "Advice", seeks: "Investors", overrides: { company: "Override Co" }, lastActiveAt: new Date(),
      standTableId: fixture.tables[0].id,
    });
    await store.update("tables", { eventId, id: fixture.tables[0].id }, { ownerProfileId: a });
    // Codes are keyed by address: the erasure matches it case-insensitively.
    await store.insert("challenges", { eventId, email: profileA.email.toUpperCase(), codeHash: "x", expiresAt: future });
    await store.insert("challenges", { eventId, email: fixture.participants[1].profile.email, codeHash: "x", expiresAt: future });
    await store.insert("interests", { eventId, profileId: a, targetId: b, action: "LIKE" });
    await store.insert("interests", { eventId, profileId: c, targetId: a, action: "PASS" });
    await store.insert("interests", { eventId, profileId: b, targetId: c, action: "LIKE" });
    const [ab1, ab2] = sorted(a, b), [bc1, bc2] = sorted(b, c);
    const ab = await store.insert("connections", { eventId, profileAId: ab1, profileBId: ab2 });
    const bc = await store.insert("connections", { eventId, profileAId: bc1, profileBId: bc2 });
    const fromA = await store.insert("messages", { eventId, connectionId: ab.id, senderId: a, body: "hi from a", clientMessageId: randomUUID() });
    await store.insert("messages", { eventId, connectionId: ab.id, senderId: b, body: "hi a", clientMessageId: randomUUID() });
    await store.insert("messages", { eventId, connectionId: bc.id, senderId: b, body: "hi c", clientMessageId: randomUUID() });
    await store.insert("blocks", { eventId, profileId: c, targetId: a });
    await store.insert("blocks", { eventId, profileId: b, targetId: d });
    const aboutA = await store.insert("reports", { eventId, reporterId: b, profileId: a, messageId: fromA.id, reason: "about a" });
    const byA = await store.insert("reports", { eventId, reporterId: a, profileId: c, reason: "by a" });
    await store.insert("reports", { eventId, reporterId: c, profileId: d, reason: "unrelated" });
    const upcoming = await store.insert("meetings", {
      eventId, requesterId: a, recipientId: b, startsAt: future, endsAt: halfHour(future),
      tableId: fixture.tables[0].id, status: "CONFIRMED", expiresAt: future,
    });
    await store.insert("reservations", { eventId, meetingId: upcoming.id, resourceKey: `table:${fixture.tables[0].id}`, startsAt: future });
    const history = await store.insert("meetings", {
      eventId, requesterId: c, recipientId: a, startsAt: past, endsAt: halfHour(past), status: "COMPLETED", expiresAt: past,
    });
    const others = await store.insert("meetings", {
      eventId, requesterId: b, recipientId: c, startsAt: future, endsAt: halfHour(future), status: "CONFIRMED", expiresAt: future,
    });
    await store.insert("reservations", { eventId, meetingId: others.id, resourceKey: `participant:${b}`, startsAt: future });
    await store.insert("notifications", { eventId, profileId: a, type: "MATCH", title: "t", body: "b" });
    await store.insert("notifications", { eventId, profileId: b, type: "MESSAGE", title: "New message", body: "A sent you a message.", data: { connectionId: ab.id, counterpartName: "A" } });
    await store.insert("notifications", { eventId, profileId: c, type: "MEETING_ACCEPT", title: "t", body: "b", data: { meetingId: history.id } });
    await store.insert("notifications", { eventId, profileId: c, type: "MATCH", title: "t", body: "b", data: { connectionId: bc.id } });
    await store.insert("deliveries", { eventId, profileId: a, type: "MATCH", payload: {}, dedupeKey: randomUUID() });
    await store.insert("deliveries", { eventId, profileId: a, type: "MATCH", payload: {}, status: "SENT", dedupeKey: randomUUID() });
    await store.insert("deliveries", { eventId, profileId: b, type: "MESSAGE", payload: { connectionId: ab.id, body: "A sent you a message." }, status: "SENT", dedupeKey: randomUUID() });
    await store.insert("deliveries", { eventId, profileId: c, type: "MATCH", payload: { connectionId: bc.id }, status: "SENT", dedupeKey: randomUUID() });
    for (const profileId of [a, b])
      await store.insert("pushSubscriptions", { eventId, profileId, endpoint: `https://push.test/${randomUUID()}`, keys: { p256dh: "k", auth: "a" } });
    await store.insert("audit", { eventId, actorId: a, action: "SWIPE_LIKE", targetId: b, data: {} });
    await store.insert("audit", { eventId, actorId: c, action: "PROFILE_VIEW", targetId: a, data: {} });
    await store.insert("audit", { eventId, actorId: "admin", action: "MEETING_CANCEL", targetId: history.id, data: {} });
    await store.insert("audit", { eventId, actorId: "admin", action: "REPORT_DISMISS", targetId: aboutA.id, data: { note: "about a" } });
    await store.insert("audit", { eventId, actorId: "admin", action: "REPORT_RESOLVE", targetId: byA.id, data: {} });
    await store.insert("audit", { eventId, actorId: "admin", action: "CONFIG_UPDATED", data: {} });
    await store.insert("audit", { eventId, actorId: "networking-worker", action: "POST_EVENT_REPORT", targetId: eventId, data: {} });
    await store.insert("audit", { eventId, actorId: b, action: "SWIPE_LIKE", targetId: c, data: {} });
    for (const profileId of [a, b]) {
      await db.insert(networkingEmbeddings).values({
        profileId, eventId, kind: "PROFILE", model: "seed", sourceHash: "seed",
        embedding: Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
      });
      await db.insert(networkingEmbeddingJobs).values({ profileId });
      await db.insert(networkingSecondFactors).values({ profileId });
    }
    await db.insert(emailLogs).values([
      { recipientEmail: profileA.email, subject: "Networking", contextSnapshot: { dispatchOwner: "networking", eventId, profileId: a } },
      { recipientEmail: profileA.email.toUpperCase(), subject: "Code", contextSnapshot: { dispatchOwner: "networking", eventId, profileId: null } },
      { recipientEmail: fixture.participants[1].profile.email, subject: "Networking", contextSnapshot: { dispatchOwner: "networking", eventId, profileId: b } },
      // Registration emails of the same event are not networking data.
      { recipientEmail: profileA.email, subject: "Registration", contextSnapshot: { eventId } },
    ]);
    Object.assign(seeded, { ab: ab.id, bc: bc.id, upcoming: upcoming.id, history: history.id, others: others.id, aboutA: aboutA.id, byA: byA.id });
  }, 240_000);

  it("withdrawal scrubs the content at once, and sync never restores it", async () => {
    const before = await profileRow(a);
    expect(before.company).toBe("Override Co");
    await networkingTransaction(eventId, (_store, db) =>
      withdrawNetworkingProfile(db, { eventId, profileId: a, slug: fixture.event.slug }));

    const withdrawn = await profileRow(a);
    expect(withdrawn).toMatchObject({
      company: "", jobTitle: "", sector: "", bio: "", website: null, photoUrl: null, interests: [], offers: "", seeks: "",
      overrides: {}, consent: false, visible: false, meetingsEnabled: false, availabilitySet: false, emailPreference: "OFF",
      email: before.email, firstName: before.firstName, lastName: before.lastName, erasedAt: null,
    });
    expect(withdrawn.withdrawnAt).toBeInstanceOf(Date);
    const n = schema;
    expect(await countWhere(n.networkingPushSubscriptions, eq(n.networkingPushSubscriptions.profileId, a))).toBe(0);
    expect(await countWhere(n.networkingAvailability, eq(n.networkingAvailability.profileId, a))).toBe(0);
    expect(await countWhere(networkingEmbeddings, eq(networkingEmbeddings.profileId, a))).toBe(0);
    expect(await countWhere(networkingEmbeddingJobs, eq(networkingEmbeddingJobs.profileId, a))).toBe(0);
    // Unsent deliveries go (the cancellation notice's own copy included); sent history waits for the erasure.
    expect(await countWhere(n.networkingDeliveries, and(eq(n.networkingDeliveries.profileId, a), inArray(n.networkingDeliveries.status, ["PENDING", "PROCESSING", "FAILED"])))).toBe(0);
    expect(await countWhere(n.networkingDeliveries, and(eq(n.networkingDeliveries.profileId, a), eq(n.networkingDeliveries.status, "SENT")))).toBe(1);
    expect(await countWhere(n.networkingSessions, and(eq(n.networkingSessions.profileId, a), sql`${n.networkingSessions.revokedAt} IS NULL`))).toBe(0);
    const [upcoming] = await networkingStore(getDb()).all("meetings", { eventId, id: seeded.upcoming });
    expect(upcoming.status).toBe("CANCELLED");
    // Other participants keep theirs.
    expect(await countWhere(n.networkingPushSubscriptions, eq(n.networkingPushSubscriptions.profileId, b))).toBe(1);
    expect(await countWhere(n.networkingAvailability, eq(n.networkingAvailability.profileId, b))).toBe(1);
    expect(await countWhere(networkingEmbeddings, eq(networkingEmbeddings.profileId, b))).toBe(1);
    const queued = (await getDb().execute(sql`
      SELECT payload FROM outbox_events WHERE type = 'storage.delete' AND event_id = ${eventId}`)).rows as Array<{ payload: Record<string, string> }>;
    expect(queued.map((row) => row.payload)).toEqual([{
      url: `https://cdn.test/networking/${eventId}/profiles/${a}/photo.webp`,
      ownerPrefix: `networking/${eventId}/profiles/${a}`,
      reason: "networking.withdrawal",
    }]);

    // The registration still maps company/jobTitle/sector: sync must not copy them back.
    expect(await withSerializableTxn((tx) => syncNetworkingRegistration(withdrawn.registrationId, tx))).toEqual({ created: 0, updated: 0 });
    await syncNetworkingEvent(eventId);
    expect(await profileRow(a)).toEqual(withdrawn);
    // Inside the window nothing more is erased.
    expect(await eraseWithdrawnNetworkingProfiles({ eraseDays: 30, eventId })).toEqual([]);
  });

  it("erases the rest after the window, in batches, leaving a tombstone that sync never rewrites", async () => {
    const withdrawn = await profileRow(a);
    await getDb().execute(sql`UPDATE networking_profiles SET withdrawn_at = now() - interval '31 days' WHERE id = ${a}`);
    const [result] = await eraseWithdrawnNetworkingProfiles({ eraseDays: 30, eventId, batchSize: 2 });
    expect(result).toMatchObject({ profileId: a, eventId, done: true, erased: true });

    // Every foreign key to networking_profiles, from the schema: nothing references the tombstone.
    const references = await rowsReferencing(a);
    expect(Object.keys(references).length).toBeGreaterThanOrEqual(17);
    expect(Object.entries(references).filter(([, rows]) => rows > 0)).toEqual([]);
    const n = schema;
    // Rows keyed otherwise: audit about them, their codes, their networking email logs, notices naming them.
    expect(await countWhere(n.networkingAudit, eq(n.networkingAudit.eventId, eventId))).toBe(3);
    expect((await networkingStore(getDb()).all("audit", { eventId })).map((row) => row.action).sort())
      .toEqual(["CONFIG_UPDATED", "POST_EVENT_REPORT", "SWIPE_LIKE"]);
    expect(await countWhere(n.networkingChallenges, eq(n.networkingChallenges.eventId, eventId))).toBe(1);
    const logs = (await getDb().execute(sql`
      SELECT subject, context_snapshot->>'profileId' AS profile_id FROM email_logs WHERE context_snapshot->>'eventId' = ${eventId} ORDER BY subject`)).rows;
    expect(logs).toEqual([{ subject: "Networking", profile_id: b }, { subject: "Registration", profile_id: null }]);
    expect(await countWhere(n.networkingNotifications, sql`${n.networkingNotifications.eventId}=${eventId} AND (
      ${n.networkingNotifications.data}->>'connectionId' = ${seeded.ab} OR ${n.networkingNotifications.data}->>'meetingId' IN (${seeded.upcoming}, ${seeded.history}))`)).toBe(0);
    expect(await countWhere(n.networkingDeliveries, sql`${n.networkingDeliveries.payload}->>'connectionId' = ${seeded.ab}`)).toBe(0);
    // Everyone else's data stays; the stand stays without its representative.
    expect(await countWhere(n.networkingConnections, eq(n.networkingConnections.id, seeded.bc))).toBe(1);
    expect(await countWhere(n.networkingMessages, eq(n.networkingMessages.connectionId, seeded.bc))).toBe(1);
    expect(await countWhere(n.networkingMeetings, eq(n.networkingMeetings.id, seeded.others))).toBe(1);
    expect(await countWhere(n.networkingReservations, eq(n.networkingReservations.meetingId, seeded.others))).toBe(1);
    expect(await countWhere(n.networkingInterests, and(eq(n.networkingInterests.profileId, b), eq(n.networkingInterests.targetId, c)))).toBe(1);
    expect(await countWhere(n.networkingBlocks, eq(n.networkingBlocks.profileId, b))).toBe(1);
    expect(await countWhere(n.networkingReports, eq(n.networkingReports.reporterId, c))).toBe(1);
    expect(await countWhere(n.networkingNotifications, sql`${n.networkingNotifications.data}->>'connectionId' = ${seeded.bc}`)).toBe(1);
    expect(await countWhere(n.networkingDeliveries, sql`${n.networkingDeliveries.payload}->>'connectionId' = ${seeded.bc}`)).toBe(1);
    expect(await countWhere(networkingEmbeddings, eq(networkingEmbeddings.profileId, b))).toBe(1);
    expect(await countWhere(networkingSecondFactors, eq(networkingSecondFactors.profileId, b))).toBe(1);
    const [stand] = await networkingStore(getDb()).all("tables", { eventId, id: fixture.tables[0].id });
    expect(stand.ownerProfileId).toBeNull();

    // The tombstone: kept columns unchanged, every other column at its erased value.
    const tombstone = await profileRow(a);
    expect(tombstone.erasedAt).toBeInstanceOf(Date);
    for (const [column, fate] of Object.entries(NETWORKING_PROFILE_TOMBSTONE)) {
      const key = column as keyof typeof tombstone;
      if (fate !== "keep") expect(tombstone[key], column).toEqual(fate.scrub);
      else if (!["withdrawnAt", "erasedAt", "updatedAt"].includes(column)) expect(tombstone[key], column).toEqual(withdrawn[key]);
    }

    // Sync never recreates or rewrites it; the maintenance does not pick it again.
    expect(await withSerializableTxn((tx) => syncNetworkingRegistration(tombstone.registrationId, tx))).toEqual({ created: 0, updated: 0 });
    await syncNetworkingEvent(eventId);
    expect(await profileRow(a)).toEqual(tombstone);
    expect(await countWhere(networkingProfiles, eq(networkingProfiles.registrationId, tombstone.registrationId))).toBe(1);
    expect(await eraseWithdrawnNetworkingProfiles({ eraseDays: 30, eventId })).toEqual([]);
    // Only the withdrawal queued a photo delete: the tombstone had no photo left.
    expect(Number((await getDb().execute(sql`
      SELECT count(*)::int4 AS n FROM outbox_events WHERE type = 'storage.delete' AND event_id = ${eventId}`)).rows[0].n)).toBe(1);
  });
});
