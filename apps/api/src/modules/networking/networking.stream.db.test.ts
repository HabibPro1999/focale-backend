import "reflect-metadata";
import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createNetworkingNotification, getDb, networkingStore } from "@app/db";
import { dbTestsEnabled } from "@app/db/testing";
import { createNetworkingWriteFixture } from "../../../../../packages/db/tests/helpers/networking-write-fixture";
import type { Config } from "../../core/config";
import { networkingNotificationHub } from "../../core/networking-notification-hub";
import { ShutdownCoordinator } from "../../core/shutdown";
import { RealtimePumpService } from "../realtime/realtime.pump";
import { NetworkingService } from "./networking.service";
import { NETWORKING_STREAM, NetworkingStreamService } from "./networking.stream";
import { networkingHash } from "./networking.security";

// Plan 4.3, end to end on a migrated database (both engines in CI): a
// notification written outside an api networking transaction (worker and
// db-level producers) leaves an IDs-only `networking.notify` outbox row; the
// api's realtime pump claims it and wakes the hub; the participant's open
// stream then reads the row from the database and sends it, well before the
// 60 s safety resync could have.
const config = {
  realtime: { disabled: false, heartbeatMs: 25_000, clientRetryMs: 15_000 },
} as unknown as Config;

/** The networking.notify outbox row signalling this notification. */
async function signalRow(notificationId: string) {
  const { rows } = await getDb().$client.query(
    "SELECT payload, status FROM outbox_events WHERE type = 'networking.notify' AND aggregate_id = $1",
    [notificationId],
  );
  return rows as Array<{ payload: unknown; status: string }>;
}

/**
 * Drops the event's networking.notify rows written so far. The fixture's
 * automatic approval leaves one activation signal per participant; the pump
 * would relay those first, and a stream woken by one already reads any newer
 * row of its participant (correct, but it would no longer prove which signal
 * delivered what).
 */
async function dropSignals(eventId: string) {
  await getDb().$client.query("DELETE FROM outbox_events WHERE type = 'networking.notify' AND event_id = $1", [
    eventId,
  ]);
}

function fakeReply() {
  const writes: string[] = [];
  const raw = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: vi.fn(function (this: EventEmitter) {
      this.emit("close");
    }),
  });
  const reply = { hijack: vi.fn(), getHeaders: () => ({}), header: vi.fn(), raw } as unknown as FastifyReply;
  const sentIds = () =>
    writes
      .filter((chunk) => chunk.includes("event: notifications\n"))
      .flatMap((chunk) => JSON.parse(chunk.slice(chunk.indexOf("data: ") + 6).split("\n")[0]!) as Array<{ id: string }>)
      .map((row) => row.id);
  return { reply, raw, writes, sentIds };
}

describe.runIf(dbTestsEnabled())("participant stream through the realtime pump", () => {
  let fixture: Awaited<ReturnType<typeof createNetworkingWriteFixture>>;
  const pump = new RealtimePumpService(config);

  beforeAll(async () => {
    process.env.NETWORKING_TOKEN_SECRET ??= "test-networking-secret-at-least-32-characters";
    fixture = await createNetworkingWriteFixture({
      size: 2,
      slots: [new Date("2031-06-10T09:00:00.000Z")],
      tables: 0,
      hash: networkingHash,
    });
  }, 240_000);
  afterAll(async () => {
    await pump.beforeApplicationShutdown();
  });

  it("delivers a networking.notify outbox row to exactly its participant's stream", async () => {
    const streams = new NetworkingStreamService(new NetworkingService(), config, new ShutdownCoordinator());
    // No onModuleInit: no in-process publisher, so the write below goes through the outbox.
    const request = (index: number) =>
      ({
        headers: { authorization: `Bearer ${fixture.participants[index]!.token}` },
        ip: "127.0.0.1",
      }) as unknown as FastifyRequest;
    // The row written below must be the only signal these streams can get.
    await dropSignals(fixture.event.id);
    // One notice per participant inserted without a signal (no outbox row):
    // each stream's first catch-up sends it, which shows that catch-up is over,
    // so from then on only a signal can deliver a new row before the resync.
    const store = networkingStore(getDb());
    const baseline: string[] = [];
    for (const participant of fixture.participants.slice(0, 2)) {
      const notice = await store.insert("notifications", {
        eventId: fixture.event.id,
        profileId: participant.profile.id,
        type: "MESSAGE",
        title: "Earlier message",
        body: "Sent before the stream opened.",
      });
      baseline.push(notice.id);
    }
    const mine = fakeReply();
    const other = fakeReply();
    await streams.open(fixture.event.slug, request(0), mine.reply);
    await streams.open(fixture.event.slug, request(1), other.reply);
    try {
      expect(mine.writes[0]).toMatch(/^id: \d+\nevent: ready\n/);
      await vi.waitFor(() => {
        expect(mine.sentIds()).toContain(baseline[0]);
        expect(other.sentIds()).toContain(baseline[1]);
      }, { timeout: 15_000, interval: 50 });
      const publish = vi.spyOn(networkingNotificationHub, "publish");

      const row = await createNetworkingNotification({
        eventId: fixture.event.id,
        profileId: fixture.participants[0]!.profile.id,
        type: "MESSAGE",
        title: "New message",
        body: "Someone sent you a message.",
        href: `/e/${fixture.event.slug}/notifications`,
        data: {},
      }, getDb());
      const [signal] = await signalRow(row.id);
      expect(signal!.payload).toEqual({
        eventId: fixture.event.id,
        profileId: fixture.participants[0]!.profile.id,
        notificationId: row.id,
      });

      const startedAt = Date.now();
      pump.onApplicationBootstrap();
      await vi.waitFor(() => expect(mine.sentIds()).toContain(row.id), { timeout: 15_000, interval: 50 });
      expect(Date.now() - startedAt).toBeLessThan(NETWORKING_STREAM.resyncMs);
      // The only notice the pump relayed is this row's: it is what woke the stream.
      expect(publish.mock.calls).toEqual([
        [{ eventId: fixture.event.id, profileId: fixture.participants[0]!.profile.id, notificationId: row.id }],
      ]);
      expect(other.sentIds()).not.toContain(row.id);
      await vi.waitFor(async () => {
        const [processed] = await signalRow(row.id);
        expect(processed!.status).toBe("PROCESSED");
      }, { timeout: 10_000, interval: 100 });
    } finally {
      vi.restoreAllMocks();
      mine.raw.emit("close");
      other.raw.emit("close");
    }
    expect(networkingNotificationHub.size).toBe(0);
  });
});
