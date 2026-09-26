import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { count, eq, getTableColumns, getTableName, inArray, is, sql } from "drizzle-orm";
import { PgTable, type PgColumn } from "drizzle-orm/pg-core";
import { getDb } from "../../../src/client";
import * as schema from "../../../src/schema";
import { emailLogs, networkingAllocationLocks, networkingEmbeddingJobs, networkingEmbeddings, networkingSecondFactors } from "../../../src/schema";
import { networkingStore } from "../../../src/queries/networking-store";
import {
  networkingEventsToPurge,
  purgeExpiredNetworkingEvents,
  purgeNetworkingEvent,
} from "../../../src/queries/networking-retention";
import { createNetworkingWriteFixture } from "../../helpers/networking-write-fixture";
import { dbTestsEnabled } from "../../helpers/test-env";

// Plan 4.4: the retention purge against a migrated database (both engines in CI).
// The table list is derived from the Drizzle schema, so a new networking table
// fails here until it is seeded below and covered by the purge.
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const slot = new Date("2031-08-01T09:00:00.000Z");
const networkingTables = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .filter((table) => getTableName(table).startsWith("networking_"));
type Fixture = Awaited<ReturnType<typeof createNetworkingWriteFixture>>;

/** One or more rows in every networking table for the fixture's event. */
async function seed(fixture: Fixture) {
  const db = getDb();
  const store = networkingStore(getDb());
  const eventId = fixture.event.id;
  const [a, b, c] = fixture.participants.map((participant) => participant.profile.id);
  const [low, high] = [a, b].sort();
  await store.update("profiles", { eventId, id: a }, { photoUrl: `https://cdn.test/networking/${eventId}/profiles/${a}/photo.webp` });
  await store.insert("challenges", { eventId, email: "seed@example.invalid", codeHash: "x", expiresAt: slot });
  await store.insert("interests", { eventId, profileId: a, targetId: b, action: "LIKE" });
  const connection = await store.insert("connections", { eventId, profileAId: low, profileBId: high });
  const message = await store.insert("messages", { eventId, connectionId: connection.id, senderId: a, body: "hello", clientMessageId: randomUUID() });
  await store.insert("blocks", { eventId, profileId: c, targetId: a });
  await store.insert("reports", { eventId, reporterId: b, profileId: c, messageId: message.id, reason: "seeded report" });
  const space = await store.insert("spaces", { eventId, name: "Hall" });
  const table = await store.insert("tables", { eventId, spaceId: space.id, name: "Stand", capacity: 2, ownerProfileId: c });
  const meeting = await store.insert("meetings", {
    eventId, requesterId: a, recipientId: b, startsAt: slot, endsAt: new Date(+slot + 1_800_000),
    tableId: table.id, status: "CONFIRMED", expiresAt: slot,
  });
  await store.insert("reservations", { eventId, meetingId: meeting.id, resourceKey: `table:${table.id}`, startsAt: slot });
  await store.insert("notifications", { eventId, profileId: a, type: "MATCH", title: "t", body: "b" });
  await store.insert("deliveries", { eventId, profileId: a, type: "MATCH", payload: {}, dedupeKey: randomUUID() });
  await store.insert("pushSubscriptions", { eventId, profileId: a, endpoint: `https://push.test/${randomUUID()}`, keys: { p256dh: "k", auth: "a" } });
  await store.insert("audit", { eventId, actorId: "admin", action: "CONFIG_UPDATED", data: {} });
  await store.insert("audit", { eventId, actorId: "networking-worker", action: "POST_EVENT_REPORT", targetId: eventId, data: { summary: { participants: 3 } } });
  await db.insert(networkingAllocationLocks).values({ eventId, bucketStart: slot });
  await db.insert(networkingEmbeddings).values({
    profileId: a, eventId, kind: "PROFILE", model: "seed", sourceHash: "seed",
    embedding: Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)),
  });
  await db.insert(networkingEmbeddingJobs).values({ profileId: a });
  await db.insert(networkingSecondFactors).values({ profileId: b });
  await db.insert(emailLogs).values([
    { recipientEmail: "a@example.invalid", subject: "Networking", contextSnapshot: { dispatchOwner: "networking", eventId, profileId: a } },
    // Not a networking row: registration emails of the same event are kept.
    { recipientEmail: "a@example.invalid", subject: "Registration", contextSnapshot: { eventId } },
  ]);
}

/** Rows per networking table scoped to the event (or its profiles for tables without an event_id). */
async function networkingCounts(eventId: string, profileIds: string[]) {
  const db = getDb();
  const counts: Record<string, number> = {};
  for (const table of networkingTables) {
    const columns = getTableColumns(table) as Record<string, PgColumn>;
    const scope = columns.eventId ? eq(columns.eventId, eventId) : columns.profileId ? inArray(columns.profileId, profileIds) : null;
    if (!scope) throw new Error(`${getTableName(table)} has neither event_id nor profile_id: extend purge coverage and this test`);
    const [row] = await db.select({ n: count() }).from(table).where(scope);
    counts[getTableName(table)] = Number(row.n);
  }
  return counts;
}
const networkingEmailLogs = async (eventId: string) => Number((await getDb().execute(sql`
  SELECT count(*)::int4 AS n FROM email_logs
  WHERE (context_snapshot ->> 'dispatchOwner') = 'networking' AND (context_snapshot ->> 'eventId') = ${eventId}`)).rows[0].n);
const eventEmailLogs = async (eventId: string) => Number((await getDb().execute(sql`
  SELECT count(*)::int4 AS n FROM email_logs WHERE (context_snapshot ->> 'eventId') = ${eventId}`)).rows[0].n);

describe.runIf(dbTestsEnabled())("networking retention purge", () => {
  let expired: Fixture;
  let live: Fixture;
  const ids = (fixture: Fixture) => fixture.participants.map((participant) => participant.profile.id);

  beforeAll(async () => {
    [expired, live] = await Promise.all([1, 2].map(() => createNetworkingWriteFixture({
      size: 3, slots: [slot], tables: 1, hash, config: { retentionDays: 1 },
    })));
    await seed(expired);
    await seed(live);
    // The expired event ended long ago; the live one is still inside its retention.
    await getDb().execute(sql`UPDATE events SET end_date = now() - interval '30 days', start_date = now() - interval '31 days' WHERE id = ${expired.event.id}`);
  }, 240_000);

  it("finds only events past retention, removes every networking row of the event in batches, and nothing else", async () => {
    const before = await networkingCounts(expired.event.id, ids(expired));
    const liveBefore = await networkingCounts(live.event.id, ids(live));
    // Every networking table holds seeded rows, so "0 after purge" means something for each.
    expect(Object.entries(before).filter(([, n]) => n === 0).map(([name]) => name)).toEqual([]);
    expect(await networkingEmailLogs(expired.event.id)).toBe(1);
    expect(await networkingEventsToPurge()).toContain(expired.event.id);
    expect(await networkingEventsToPurge()).not.toContain(live.event.id);

    // A run out of budget only disables the event and marks the purge started.
    expect(await purgeNetworkingEvent(expired.event.id, { deadline: Date.now() - 1 })).toMatchObject({ done: false, deleted: {} });
    const [started] = await networkingStore(getDb()).all("configs", { eventId: expired.event.id });
    expect(started.purgeStartedAt).toBeInstanceOf(Date);
    expect(started.purgedAt).toBeNull();
    expect(started.config.enabled).toBe(false);
    expect(await networkingCounts(expired.event.id, ids(expired))).toEqual(before);

    // The maintenance entry point resumes it; a batch size of 2 exercises multi-batch tables.
    const [result] = await purgeExpiredNetworkingEvents({ batchSize: 2 });
    expect(result).toMatchObject({ eventId: expired.event.id, done: true });
    const after = await networkingCounts(expired.event.id, ids(expired));
    expect(after).toEqual(Object.fromEntries(Object.keys(before).map((name) => [name,
      name === "networking_configs" ? 1 : name === "networking_audit" ? 1 : 0])));
    const [kept] = await networkingStore(getDb()).all("audit", { eventId: expired.event.id });
    expect(kept.action).toBe("POST_EVENT_REPORT");
    const [config] = await networkingStore(getDb()).all("configs", { eventId: expired.event.id });
    expect(config.purgedAt).toBeInstanceOf(Date);
    expect(config.purgeStartedAt).toEqual(started.purgeStartedAt);
    // Networking email logs go; the event's other email logs and its registrations stay.
    expect(await networkingEmailLogs(expired.event.id)).toBe(0);
    expect(await eventEmailLogs(expired.event.id)).toBe(1);
    expect(await networkingStore(getDb()).all("registrations", { eventId: expired.event.id })).toHaveLength(3);
    // The photo is queued for durable deletion with its profile.
    const queued = (await getDb().execute(sql`
      SELECT payload FROM outbox_events WHERE type = 'storage.delete' AND event_id = ${expired.event.id}`)).rows as Array<{ payload: Record<string, string> }>;
    const photoOwner = ids(expired)[0];
    expect(queued.map((row) => row.payload)).toEqual([{
      url: `https://cdn.test/networking/${expired.event.id}/profiles/${photoOwner}/photo.webp`,
      ownerPrefix: `networking/${expired.event.id}/profiles/${photoOwner}`,
      reason: "networking.retention",
    }]);

    // The live event is untouched, and a finished purge is not selected again.
    expect(await networkingCounts(live.event.id, ids(live))).toEqual(liveBefore);
    expect(await networkingEmailLogs(live.event.id)).toBe(1);
    expect(await networkingEventsToPurge(expired.event.id)).toEqual([]);
    expect(await purgeExpiredNetworkingEvents({ eventId: expired.event.id })).toEqual([]);
  });
});
