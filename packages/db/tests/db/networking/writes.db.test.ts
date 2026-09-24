import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "../../../src/client";
import {
  NetworkingAllocationLockError,
  networkingAllocationTransaction,
  networkingStore,
  networkingTransaction,
} from "../../../src/queries/networking-store";
import { createNetworkingWriteFixture } from "../../helpers/networking-write-fixture";
import { dbTestsEnabled } from "../../helpers/test-env";

// Every ON CONFLICT write of plan 4.1 against a migrated database (both engines in CI).
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const at = (time: string) => new Date(`2031-07-01T${time}:00.000Z`);
let fixture: Awaited<ReturnType<typeof createNetworkingWriteFixture>>;
const id = (index: number) => fixture.participants[index].profile.id;

describe.runIf(dbTestsEnabled())("networking unique-index writes", () => {
  beforeAll(async () => {
    fixture = await createNetworkingWriteFixture({ size: 4, slots: [at("09:00")], tables: 1, hash });
  }, 240_000);

  it("upserts the hour locks and claims resources all-or-nothing", async () => {
    const eventId = fixture.event.id;
    const meeting = (requester: number, recipient: number, startsAt: Date) => networkingStore().insert("meetings", {
      eventId, requesterId: id(requester), recipientId: id(recipient), startsAt,
      endsAt: new Date(+startsAt + 1_800_000), expiresAt: startsAt,
    });
    const lockRows = async () => (await getDb().execute(
      sql`SELECT bucket_start FROM networking_allocation_locks WHERE event_id = ${eventId} ORDER BY bucket_start`,
    )).rows;
    const first = await meeting(0, 1, at("09:50"));
    const second = await meeting(2, 3, at("09:55"));
    const window = [{ startsAt: at("09:50"), endsAt: at("10:25") }];
    await networkingAllocationTransaction(eventId, window, async (store) => {
      expect(await store.claimResource(eventId, first.id, "table:t", [at("09:50"), at("09:55")])).toBe(true);
    });
    expect(await lockRows()).toHaveLength(2);
    await networkingAllocationTransaction(eventId, window, async (store) => {
      // 09:55 is taken: the 10:00 row this claim inserted is removed again and the transaction stays usable.
      expect(await store.claimResource(eventId, second.id, "table:t", [at("09:55"), at("10:00")])).toBe(false);
      expect(await store.claimResource(eventId, second.id, "table:u", [at("09:55"), at("10:00")])).toBe(true);
    });
    // Re-locking the same hours updates the existing rows (ON CONFLICT DO UPDATE).
    expect(await lockRows()).toHaveLength(2);
    await expect(networkingAllocationTransaction(eventId, window, (store) =>
      store.claimResource(eventId, second.id, "table:v", [at("11:00")]))).rejects.toBeInstanceOf(NetworkingAllocationLockError);
    const held = (await networkingStore().all("reservations", { eventId }))
      .map((row) => `${row.meetingId === first.id ? "first" : "second"} ${row.resourceKey} ${row.startsAt.toISOString().slice(11, 16)}`)
      .sort();
    expect(held).toEqual(["first table:t 09:50", "first table:t 09:55", "second table:u 09:55", "second table:u 10:00"]);
  });

  it("makes swipes, connections, messages, blocks and push subscriptions idempotent", async () => {
    const eventId = fixture.event.id;
    await networkingTransaction(eventId, async (store) => {
      await store.upsertInterest(eventId, id(0), id(1), "PASS");
      const liked = await store.upsertInterest(eventId, id(0), id(1), "LIKE");
      expect(liked.action).toBe("LIKE");
      // Fixture ids are ordered by name, not by id: pass the pair in both orders.
      const [low, high] = [id(0), id(1)].sort();
      const created = await store.ensureConnection(eventId, high, low);
      const again = await store.ensureConnection(eventId, low, high);
      expect([created.created, again.created]).toEqual([true, false]);
      expect(again.connection.id).toBe(created.connection.id);
      expect(created.connection).toMatchObject({ profileAId: low, profileBId: high });
      const clientMessageId = randomUUID();
      const message = { eventId, connectionId: created.connection.id, senderId: id(0), body: "Hi", clientMessageId };
      expect(await store.insertMessageOnce(message)).toMatchObject({ clientMessageId });
      expect(await store.insertMessageOnce({ ...message, body: "Other" })).toBeNull();
      await store.insertBlockOnce(eventId, id(2), id(3));
      await store.insertBlockOnce(eventId, id(2), id(3));
      const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
      const push = { endpoint, keys: { p256dh: "k", auth: "a" }, expirationTime: null };
      const firstOwner = await store.upsertPushSubscription({ ...push, eventId, profileId: id(2) });
      const moved = await store.upsertPushSubscription({ ...push, eventId, profileId: id(3), keys: { p256dh: "k2", auth: "a2" } });
      expect(moved).toMatchObject({ id: firstOwner.id, profileId: id(3), keys: { p256dh: "k2", auth: "a2" } });
    });
    const store = networkingStore();
    expect(await store.all("interests", { eventId, profileId: id(0), targetId: id(1) })).toMatchObject([{ action: "LIKE" }]);
    expect(await store.all("connections", { eventId })).toHaveLength(1);
    expect(await store.all("messages", { eventId })).toMatchObject([{ body: "Hi" }]);
    expect(await store.all("blocks", { eventId })).toHaveLength(1);
    expect(await store.all("pushSubscriptions", { eventId })).toMatchObject([{ profileId: id(3) }]);
  });
});
