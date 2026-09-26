import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../../../src/client";
import { configureOutbox } from "../../../src/outbox/outbox";
import { networkingDeliveries, networkingNotifications, outboxEvents } from "../../../src/schema";
import { withSerializableTxn } from "../../../src/txn";
import { createNetworkingNotification, queueNetworkingActivation } from "../../../src/queries/networking";
import { setNetworkingNoticePublisher } from "../../../src/queries/networking-notices";
import { networkingNotificationsPage } from "../../../src/queries/networking-participant-read";
import { networkingTransaction } from "../../../src/queries/networking-store";
import { createNetworkingWriteFixture } from "../../helpers/networking-write-fixture";
import { dbTestsEnabled } from "../../helpers/test-env";

// Plan 4.3: every participant notification signals the participant's live
// streams. Outside an api networking transaction the signal is an IDs-only
// `networking.notify` outbox row in the same transaction; inside one (with the
// api's publisher registered) it is published after commit instead.
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
type Fixture = Awaited<ReturnType<typeof createNetworkingWriteFixture>>;

const notice = (fixture: Fixture, index: number, title = "Hello") => ({
  eventId: fixture.event.id,
  profileId: fixture.participants[index]!.profile.id,
  type: "MESSAGE",
  title,
  body: "You have a new message.",
  href: `/e/${fixture.event.slug}/notifications`,
  data: { connectionId: "connection" },
});

async function notifyRows(notificationId: string) {
  return getDb()
    .select({ payload: outboxEvents.payload, eventId: outboxEvents.eventId, status: outboxEvents.status })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.type, "networking.notify"), eq(outboxEvents.aggregateId, notificationId)));
}

describe.runIf(dbTestsEnabled())("networking notices (4.3)", () => {
  let fixture: Fixture;
  beforeAll(async () => {
    fixture = await createNetworkingWriteFixture({
      size: 3,
      slots: [new Date("2031-06-10T09:00:00.000Z")],
      tables: 0,
      hash,
    });
  }, 240_000);

  it("activation (automatic approval) wrote one APPROVAL notification per participant, signalled by one IDs-only row; repeating it writes nothing", async () => {
    const { event, participants } = fixture;
    const profileId = participants[0]!.profile.id;
    const approvals = () =>
      getDb()
        .select()
        .from(networkingNotifications)
        .where(and(eq(networkingNotifications.profileId, profileId), eq(networkingNotifications.type, "APPROVAL")));
    const [approval] = await approvals();
    expect(approval).toMatchObject({ eventId: event.id, title: "Networking is ready", data: { status: "ACTIVE" } });
    expect(await notifyRows(approval!.id)).toEqual([
      {
        payload: { eventId: event.id, profileId, notificationId: approval!.id },
        eventId: event.id,
        status: "PENDING",
      },
    ]);
    const [delivery] = await getDb()
      .select()
      .from(networkingDeliveries)
      .where(eq(networkingDeliveries.dedupeKey, `networking-activation:${profileId}`));
    expect(delivery!.payload).toMatchObject({ notificationId: approval!.id, status: "ACTIVE" });

    await withSerializableTxn((tx) => queueNetworkingActivation(profileId, event.id, tx));
    expect(await approvals()).toHaveLength(1);
    const allSignals = await getDb()
      .select({ n: sql<number>`count(*)::int4` })
      .from(outboxEvents)
      .where(and(eq(outboxEvents.type, "networking.notify"), sql`${outboxEvents.payload}->>'profileId' = ${profileId}`));
    expect(Number(allSignals[0]!.n)).toBe(1);
  });

  it("inside a networking transaction with the api publisher: no outbox row, one notice after commit, none on rollback", async () => {
    const publisher = vi.fn();
    setNetworkingNoticePublisher(publisher);
    try {
      const row = await networkingTransaction(fixture.event.id, async (_store, db) => {
        const created = await createNetworkingNotification(notice(fixture, 1), db);
        await createNetworkingNotification(notice(fixture, 1, "Again"), db);
        expect(publisher).not.toHaveBeenCalled();
        return created;
      });
      expect(publisher).toHaveBeenCalledExactlyOnceWith([
        { eventId: fixture.event.id, profileId: fixture.participants[1]!.profile.id },
      ]);
      expect(await notifyRows(row.id)).toEqual([]);

      publisher.mockClear();
      let rolledBack = "";
      await expect(
        networkingTransaction(fixture.event.id, async (_store, db) => {
          rolledBack = (await createNetworkingNotification(notice(fixture, 1, "Rolled back"), db)).id;
          throw new Error("validation");
        }),
      ).rejects.toThrow("validation");
      expect(publisher).not.toHaveBeenCalled();
      expect(await getDb().select().from(networkingNotifications).where(eq(networkingNotifications.id, rolledBack))).toEqual([]);
    } finally {
      setNetworkingNoticePublisher(null);
    }
  });

  it("under REALTIME_DISABLED writes the notification and its delivery but no networking.notify row", async () => {
    configureOutbox({ realtimeDisabled: true });
    try {
      const row = await createNetworkingNotification(notice(fixture, 2), getDb());
      const deliveries = await getDb()
        .select()
        .from(networkingDeliveries)
        .where(eq(networkingDeliveries.dedupeKey, `notification:${row.id}`));
      expect(deliveries).toHaveLength(1);
      expect(await notifyRows(row.id)).toEqual([]);
    } finally {
      configureOutbox({ realtimeDisabled: false });
    }
  });

  it("the catch-up query pages exactly by id when one transaction's rows share a timestamp, within the participant and the since bound", async () => {
    const profileId = fixture.participants[2]!.profile.id;
    const since = new Date(Date.now() - 60_000);
    await getDb().insert(networkingNotifications).values({
      ...notice(fixture, 2, "Too old"),
      createdAt: new Date(Date.now() - 3_600_000),
    });
    const batch = await withSerializableTxn(async (tx) => {
      const rows = [];
      for (let i = 0; i < 5; i++) rows.push(await createNetworkingNotification(notice(fixture, 2, `Batch ${i}`), tx));
      await createNetworkingNotification(notice(fixture, 0, "Someone else"), tx);
      return rows;
    });
    // One transaction, one now(): the batch shares its created_at on both engines.
    expect(new Set(batch.map((row) => row.createdAt.toISOString())).size).toBe(1);

    const expected = await getDb()
      .select({ id: networkingNotifications.id })
      .from(networkingNotifications)
      .where(and(
        eq(networkingNotifications.eventId, fixture.event.id),
        eq(networkingNotifications.profileId, profileId),
        gte(networkingNotifications.createdAt, since),
      ))
      .orderBy(asc(networkingNotifications.id));
    expect(expected.map((row) => row.id)).toEqual(expect.arrayContaining(batch.map((row) => row.id)));

    const seen: string[] = [];
    for (let afterId: string | null = null; ; ) {
      const page = await networkingNotificationsPage(fixture.event.id, profileId, since, afterId, 2);
      for (const row of page) {
        expect(row.profileId).toBe(profileId);
        expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(since.getTime());
      }
      seen.push(...page.map((row) => row.id));
      if (page.length < 2) break;
      afterId = page.at(-1)!.id;
    }
    expect(seen).toEqual(expected.map((row) => row.id));
  });
});
