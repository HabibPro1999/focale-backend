import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { getDb, getDbSettings, networkingStore } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { createNetworkingWriteFixture } from "../../../../../packages/db/tests/helpers/networking-write-fixture";
import { NetworkingService, type NetworkingContext } from "./networking.service";
import { NetworkingSocialService } from "./networking.social.service";
import { NetworkingMeetingsService } from "./networking.meetings.service";
import { NetworkingAdminService } from "./networking.admin.service";
import { NetworkingExportsService } from "./networking.exports.service";
import { NetworkingMfaService } from "./networking.mfa.service";
import { NetworkingUploadsService } from "./networking.uploads.service";
import { NetworkingPublicController } from "./networking.public.controller";
import { networkingHash, networkingTotp, openNetworkingSecret } from "./networking.security";

// Plan 4.1: one pool connection per networking transaction. With a pool of
// one, any helper that takes a second connection inside a transaction waits
// for the only connection and fails after the pool's 5 s connect timeout, so
// every write below must finish. Resolved lazily by the first getDb().
const previousPoolMax = process.env.DB_POOL_MAX;
process.env.DB_POOL_MAX = "1";
afterAll(() => {
  if (previousPoolMax === undefined) delete process.env.DB_POOL_MAX;
  else process.env.DB_POOL_MAX = previousPoolMax;
});

const service = new NetworkingService();
const social = new NetworkingSocialService(service);
const meetings = new NetworkingMeetingsService(service);
const admin = new NetworkingAdminService(service, meetings);
const mfa = new NetworkingMfaService();
const controller = new NetworkingPublicController(
  new NetworkingUploadsService(), service, social, meetings, new NetworkingExportsService(social, meetings),
);
const slots = ["09:00", "09:30", "10:00", "10:30"].map((time) => new Date(`2031-06-10T${time}:00.000Z`));
let fixture: Awaited<ReturnType<typeof createNetworkingWriteFixture>>;
let people: NetworkingContext[];
const request = (index: number) =>
  ({ headers: { authorization: `Bearer ${fixture.participants[index].token}` }, ip: "127.0.0.1" }) as unknown as FastifyRequest;

describe.runIf(dbTestsEnabled())("networking writes on a pool of one connection", () => {
  beforeAll(async () => {
    process.env.NETWORKING_TOKEN_SECRET ??= "test-networking-secret-at-least-32-characters";
    expect(getDbSettings().poolMax).toBe(1);
    fixture = await createNetworkingWriteFixture({ size: 6, slots, tables: 2, hash: networkingHash });
    people = fixture.participants.map(({ profile, session }) => ({
      event: fixture.event, config: fixture.config, profile, session,
    }));
  }, 240_000);

  it("signs in with a code", async () => {
    const { challengeId } = await service.requestCode(fixture.event.slug, people[0].profile.email);
    const delivery = await networkingStore().one("deliveries", { dedupeKey: `otp:${challengeId}` });
    const code = openNetworkingSecret(String(delivery!.payload.encryptedCode));
    expect((await service.verifyCode(fixture.event.slug, challengeId, code)).token).toHaveLength(64);
  });

  it("swipes, matches, messages and edits a profile", async () => {
    await social.interest(people[0], people[1].profile.id, "LIKE");
    const match = await social.interest(people[1], people[0].profile.id, "LIKE");
    expect(match).toMatchObject({ matched: true });
    const message = await social.sendMessage(people[0], match.connectionId!, "Hello", "pool-message");
    expect((await social.sendMessage(people[0], match.connectionId!, "Hello", "pool-message")).id).toBe(message.id);
    await service.updateMe(people[0], { bio: "Pool of one" });
    await service.updateMe(people[0], { resetFields: ["company"] });
    await meetings.saveAvailability(people[0], slots.map((slot) => slot.toISOString()));
  });

  it("requests, reschedules, accepts, assigns and cancels meetings", async () => {
    const pending = await meetings.create(people[0], { profileId: people[1].profile.id, startsAt: slots[0].toISOString() });
    await meetings.respond(people[0], pending.id, { action: "RESCHEDULE", startsAt: slots[1].toISOString() });
    const confirmed = await meetings.respond(people[1], pending.id, { action: "ACCEPT" });
    expect(confirmed.status).toBe("CONFIRMED");
    await admin.updateMeeting(fixture.event.id, pending.id, { action: "ASSIGN", tableId: fixture.tables[1].id }, "organizer");
    await admin.updateMeeting(fixture.event.id, pending.id, { action: "CANCEL" }, "organizer");
    const declined = await meetings.create(people[0], { profileId: people[1].profile.id, startsAt: slots[2].toISOString() });
    await meetings.respond(people[1], declined.id, { action: "DECLINE" });
  });

  it("enrolls an authenticator and subscribes to push", async () => {
    const { secret } = await mfa.enroll(people[2]);
    expect((await mfa.verify(people[2], networkingTotp(secret), "CONFIRM")).recoveryCodes).toHaveLength(10);
    const body = { endpoint: "https://fcm.googleapis.com/fcm/send/pool-one", keys: { p256dh: "key", auth: "auth" } };
    await controller.subscribe(fixture.event.slug, request(3), body as never);
    expect((await controller.subscribe(fixture.event.slug, request(4), body as never)).profileId).toBe(people[4].profile.id);
  });

  it("blocks a participant and withdraws another, cancelling their meetings", async () => {
    await social.interest(people[3], people[4].profile.id, "LIKE");
    await social.interest(people[4], people[3].profile.id, "LIKE");
    await meetings.create(people[3], { profileId: people[4].profile.id, startsAt: slots[3].toISOString() });
    await social.block(people[4], people[3].profile.id);
    await meetings.create(people[0], { profileId: people[1].profile.id, startsAt: slots[3].toISOString() });
    const photoUrl = `https://cdn.test/networking/${fixture.event.id}/profiles/${people[1].profile.id}/photo.webp`;
    await networkingStore().update("profiles", { eventId: fixture.event.id, id: people[1].profile.id }, { photoUrl });
    expect(await controller.withdraw(fixture.event.slug, request(1))).toEqual({ withdrawn: true });
    const active = (await networkingStore().all("meetings", { eventId: fixture.event.id }))
      .filter((row) => ["PENDING", "CONFIRMED", "PENDING_ALLOCATION"].includes(row.status));
    expect(active).toEqual([]);
    // 4.4: the photo's storage.delete outbox row rides the withdrawal transaction's connection.
    const { rows: queued } = await getDb().$client.query(
      "SELECT payload FROM outbox_events WHERE type = 'storage.delete' AND event_id = $1", [fixture.event.id],
    );
    expect(queued.map((row: { payload: unknown }) => row.payload)).toEqual([{
      url: photoUrl, ownerPrefix: `networking/${fixture.event.id}/profiles/${people[1].profile.id}`, reason: "networking.withdrawal",
    }]);
  });

  it("runs organizer configuration, moderation and inventory writes", async () => {
    const saved = await admin.config(fixture.event.id, { enabled: true, meetingsEnabled: true }, "organizer");
    expect(saved.enabled).toBe(true);
    await admin.updateProfile(fixture.event.id, people[5].profile.id, { status: "SUSPENDED" }, "organizer");
    await admin.updateProfile(fixture.event.id, people[5].profile.id, { status: "ACTIVE" }, "organizer");
    const report = await social.report(people[2], { profileId: people[5].profile.id, reason: "Spam" });
    await admin.moderate(fixture.event.id, report.id, { action: "SUSPEND", note: "Pool" }, "organizer");
    const space = await admin.inventory.saveSpace(fixture.event.id, { name: "Hall", kind: "TABLE", capacity: 2 }, "organizer");
    await admin.inventory.saveSpace(fixture.event.id, { capacity: 1 }, "organizer", space.id);
    const [table] = await networkingStore().all("tables", { eventId: fixture.event.id, spaceId: space.id });
    await admin.inventory.removeTable(fixture.event.id, table.id, "organizer");
    await admin.inventory.removeSpace(fixture.event.id, space.id, "organizer");
  });
});
