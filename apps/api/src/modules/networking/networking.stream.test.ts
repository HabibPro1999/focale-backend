import "reflect-metadata";
import { EventEmitter } from "node:events";
import { UnauthorizedException } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 4.3: the participant notification stream on the in-process hub.
interface Row {
  id: string;
  eventId: string;
  profileId: string;
  type: string;
  title: string;
  createdAt: Date;
}
const mocks = vi.hoisted(() => ({ rows: [] as Row[], page: vi.fn() }));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  networkingNotificationsPage: mocks.page,
}));

import { publishNetworkingNotices } from "@app/db";
import { ErrorCodes } from "@app/contracts";
import type { Config } from "../../core/config";
import { networkingNotificationHub } from "../../core/networking-notification-hub";
import { ShutdownCoordinator } from "../../core/shutdown";
import { NETWORKING_STREAM, NetworkingStreamService } from "./networking.stream";
import type { NetworkingService } from "./networking.service";

const START = new Date("2031-06-10T09:00:00.000Z");
const SESSIONS: Record<string, { event: string; profile: string; session: string }> = {
  "Bearer ada": { event: "event-1", profile: "profile-1", session: "session-1" },
  "Bearer bob": { event: "event-1", profile: "profile-2", session: "session-2" },
  "Bearer ada-elsewhere": { event: "event-2", profile: "profile-1", session: "session-3" },
};

let sequence = 0;
// The hub is a process singleton: every stream a test opens is closed after it.
const opened: Array<{ raw: EventEmitter }> = [];
/** A committed notification; ids sort in creation order like UUIDv7. `ageMs` back-dates it. */
function notify(eventId: string, profileId: string, ageMs = 0): Row {
  const row = {
    id: `n-${String(++sequence).padStart(4, "0")}`,
    eventId,
    profileId,
    type: "MESSAGE",
    title: "New message",
    createdAt: new Date(Date.now() - ageMs),
  };
  mocks.rows.push(row);
  return row;
}

/** The keyset page query: participant rows at/after `since`, id order, after `afterId`. */
function page(eventId: string, profileId: string, since: Date, afterId: string | null, limit: number) {
  return Promise.resolve(
    mocks.rows
      .filter((row) => row.eventId === eventId && row.profileId === profileId)
      .filter((row) => row.createdAt >= since && (afterId === null || row.id > afterId))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit),
  );
}

interface Frame {
  id?: string;
  event?: string;
  data?: unknown;
  retry?: number;
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
  const frames = (): Frame[] =>
    writes
      .filter((chunk) => !chunk.startsWith(":"))
      .map((chunk) => {
        const frame: Frame = {};
        for (const line of chunk.split("\n").filter(Boolean)) {
          const at = line.indexOf(": ");
          const [key, value] = [line.slice(0, at), line.slice(at + 2)];
          if (key === "data") frame.data = JSON.parse(value);
          else if (key === "retry") frame.retry = Number(value);
          else if (key === "id" || key === "event") frame[key] = value;
        }
        return frame;
      });
  const sentIds = () =>
    frames()
      .filter((frame) => frame.event === "notifications")
      .flatMap((frame) => (frame.data as Row[]).map((row) => row.id));
  return { reply, raw, writes, frames, sentIds };
}

function setup(options: { realtimeDisabled?: boolean } = {}) {
  const lifecycle = new ShutdownCoordinator();
  const participant = vi.fn(async (_slug: string, authorization?: string) => {
    const known = authorization ? SESSIONS[authorization] : undefined;
    if (!known) throw new UnauthorizedException({ code: ErrorCodes.NETWORKING_SESSION_EXPIRED });
    return {
      event: { id: known.event, slug: "demo" },
      profile: { id: known.profile },
      session: { id: known.session },
    };
  });
  const config = {
    realtime: { disabled: options.realtimeDisabled ?? false, heartbeatMs: 25_000, clientRetryMs: 15_000 },
  } as unknown as Config;
  const streams = new NetworkingStreamService({ participant } as unknown as NetworkingService, config, lifecycle);
  const open = async (authorization: string, lastEventId?: string) => {
    const client = fakeReply();
    const headers: Record<string, string> = { authorization };
    if (lastEventId !== undefined) headers["last-event-id"] = lastEventId;
    opened.push(client);
    await streams.open("demo", { headers, ip: "127.0.0.1" } as unknown as FastifyRequest, client.reply);
    await vi.advanceTimersByTimeAsync(0);
    return client;
  };
  return { lifecycle, participant, streams, open };
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  mocks.rows.length = 0;
  sequence = 0;
  mocks.page.mockReset();
  mocks.page.mockImplementation(page);
});
afterEach(() => {
  for (const client of opened.splice(0)) client.raw.emit("close");
  // Closed streams leave the hub.
  expect(networkingNotificationHub.size).toBe(0);
  vi.useRealTimers();
});

describe("participant stream: hub isolation", () => {
  it("never delivers another participant's or another event's notice, and reads only its own rows", async () => {
    const { open } = setup();
    const ada = await open("Bearer ada");
    const readsAfterOpen = mocks.page.mock.calls.length;

    notify("event-1", "profile-2");
    notify("event-2", "profile-1");
    networkingNotificationHub.publish({ eventId: "event-1", profileId: "profile-2" });
    networkingNotificationHub.publish({ eventId: "event-2", profileId: "profile-1" });
    await vi.advanceTimersByTimeAsync(0);
    // Other participants' notices do not even wake this stream.
    expect(mocks.page.mock.calls.length).toBe(readsAfterOpen);

    const mine = notify("event-1", "profile-1");
    networkingNotificationHub.publish({ eventId: "event-1", profileId: "profile-1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(ada.sentIds()).toEqual([mine.id]);

    // The safety resync and every catch-up query only ever ask for this participant.
    await vi.advanceTimersByTimeAsync(NETWORKING_STREAM.resyncMs);
    expect(ada.sentIds()).toEqual([mine.id]);
    for (const [eventId, profileId] of mocks.page.mock.calls) expect([eventId, profileId]).toEqual(["event-1", "profile-1"]);
  });

  it("sends ready first, then each row once however many signals arrive", async () => {
    const { open } = setup();
    const ada = await open("Bearer ada");
    expect(ada.frames()[0]).toEqual({ id: String(START.getTime()), event: "ready", retry: 15_000, data: {} });

    const first = notify("event-1", "profile-1");
    for (let i = 0; i < 5; i++) networkingNotificationHub.publish({ eventId: "event-1", profileId: "profile-1" });
    await vi.advanceTimersByTimeAsync(0);
    const second = notify("event-1", "profile-1");
    networkingNotificationHub.publish({ eventId: "event-1", profileId: "profile-1" });
    await vi.advanceTimersByTimeAsync(NETWORKING_STREAM.resyncMs);
    expect(ada.sentIds()).toEqual([first.id, second.id]);
    // Coalesced: a burst of five signals costs at most two passes.
    expect(mocks.page.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("wakes on notices published after commit by api networking transactions (publisher wiring)", async () => {
    const { open, streams } = setup();
    streams.onModuleInit();
    try {
      const ada = await open("Bearer ada");
      const row = notify("event-1", "profile-1");
      publishNetworkingNotices([{ eventId: "event-1", profileId: "profile-1" }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(ada.sentIds()).toEqual([row.id]);
    } finally {
      streams.onModuleDestroy();
    }
  });
});

describe("participant stream: catch-up and Last-Event-ID resume", () => {
  it("resumes after a reconnect: every row created while away, plus late commits inside the overlap, nothing older", async () => {
    const { open } = setup();
    const first = await open("Bearer ada");
    const seen = notify("event-1", "profile-1");
    await vi.advanceTimersByTimeAsync(20_000);
    networkingNotificationHub.publish({ eventId: "event-1", profileId: "profile-1" });
    await vi.advanceTimersByTimeAsync(0);
    const notifications = first.frames().filter((frame) => frame.event === "notifications");
    expect(notifications.map((frame) => (frame.data as Row[]).map((row) => row.id))).toEqual([[seen.id]]);
    const lastEventId = notifications.at(-1)!.id!;
    expect(lastEventId).toBe(String(START.getTime() + 20_000));

    first.raw.emit("close");
    // Committed after that pass but created 5 s before it (a slow transaction).
    const late = notify("event-1", "profile-1", 5_000);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const whileAway = [notify("event-1", "profile-1"), notify("event-1", "profile-1")];

    const second = await open("Bearer ada", lastEventId);
    expect(second.frames()[0]).toMatchObject({ event: "ready", id: lastEventId });
    expect(second.frames().some((frame) => frame.event === "replay-gap")).toBe(false);
    expect(second.sentIds()).toEqual([late.id, ...whileAway.map((row) => row.id)]);
    expect(second.sentIds()).not.toContain(seen.id);
  });

  it("without Last-Event-ID starts at now (with the overlap), and the ready id lets an idle stream resume", async () => {
    const { open } = setup();
    notify("event-1", "profile-1", 60_000);
    const recent = notify("event-1", "profile-1", 5_000);
    const fresh = await open("Bearer ada");
    expect(fresh.sentIds()).toEqual([recent.id]);
    const readyId = fresh.frames()[0]!.id!;

    fresh.raw.emit("close");
    await vi.advanceTimersByTimeAsync(45_000);
    const missed = notify("event-1", "profile-1", 30_000);
    const resumed = await open("Bearer ada", readyId);
    expect(resumed.sentIds()).toContain(missed.id);
  });

  it("answers an unusable Last-Event-ID with replay-gap and starts fresh", async () => {
    const { open } = setup();
    const old = notify("event-1", "profile-1", 60_000);
    for (const lastEventId of ["not-a-cursor", String(START.getTime() - NETWORKING_STREAM.maxResumeAgeMs - 1), String(START.getTime() + 3_600_000)]) {
      const client = await open("Bearer ada", lastEventId);
      expect(client.frames().map((frame) => frame.event)).toEqual(["ready", "replay-gap"]);
      expect(client.frames()[1]!.data).toEqual({ lastEventId });
      expect(client.sentIds()).not.toContain(old.id);
      client.raw.emit("close");
    }
  });

  it("pages the catch-up by id, so more rows than a page (one shared timestamp) all arrive exactly once", async () => {
    const { open } = setup();
    const rows = Array.from({ length: NETWORKING_STREAM.pageSize * 2 + 5 }, () => notify("event-1", "profile-1"));
    const client = await open("Bearer ada");
    expect(client.sentIds()).toEqual(rows.map((row) => row.id));
    const frames = client.frames().filter((frame) => frame.event === "notifications");
    expect(frames.map((frame) => (frame.data as Row[]).length)).toEqual([100, 100, 5]);
    // Only the last frame of the pass moves the client's Last-Event-ID.
    expect(frames.map((frame) => frame.id)).toEqual([undefined, undefined, String(START.getTime())]);
  });
});

describe("participant stream: limits", () => {
  it("keeps at most three streams per session: a fourth replaces the oldest; other sessions are untouched", async () => {
    const { open, streams } = setup();
    const bob = await open("Bearer bob");
    const tabs = [await open("Bearer ada"), await open("Bearer ada"), await open("Bearer ada")];
    expect(streams.openStreams("session-1")).toBe(3);

    const fourth = await open("Bearer ada");
    expect(streams.openStreams("session-1")).toBe(3);
    expect(tabs[0]!.frames().at(-1)).toEqual({ event: "replaced", data: { reason: "stream-limit" } });
    expect(tabs[0]!.raw.end).toHaveBeenCalled();
    for (const client of [tabs[1]!, tabs[2]!, fourth, bob]) expect(client.raw.end).not.toHaveBeenCalled();
    expect(streams.openStreams("session-2")).toBe(1);

    // The replaced stream no longer listens: a notice reaches the three open ones.
    const row = notify("event-1", "profile-1");
    networkingNotificationHub.publish({ eventId: "event-1", profileId: "profile-1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(tabs[0]!.sentIds()).toEqual([]);
    for (const client of [tabs[1]!, tabs[2]!, fourth]) expect(client.sentIds()).toEqual([row.id]);
  });

  it("ends after at most 30 minutes with a reconnect frame", async () => {
    const { open, streams } = setup();
    const client = await open("Bearer ada");
    await vi.advanceTimersByTimeAsync(NETWORKING_STREAM.lifetimeMs - NETWORKING_STREAM.lifetimeJitterMs - 1_000);
    expect(client.raw.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(NETWORKING_STREAM.lifetimeJitterMs + 1_000);
    expect(client.frames().at(-1)).toEqual({ event: "reconnect", data: { reason: "lifetime" } });
    expect(client.raw.end).toHaveBeenCalled();
    expect(streams.openStreams("session-1")).toBe(0);
  });

  it("re-checks the session every 5 minutes and ends with session-ended once it is refused", async () => {
    const { open, participant } = setup();
    const client = await open("Bearer ada");
    expect(participant).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(NETWORKING_STREAM.sessionCheckMs - 1_000);
    expect(participant).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(participant).toHaveBeenCalledTimes(2);
    expect(client.raw.end).not.toHaveBeenCalled();

    participant.mockRejectedValueOnce(new UnauthorizedException({ code: ErrorCodes.NETWORKING_SESSION_EXPIRED }));
    await vi.advanceTimersByTimeAsync(NETWORKING_STREAM.sessionCheckMs);
    expect(client.frames().at(-1)).toEqual({
      event: "session-ended",
      data: { code: ErrorCodes.NETWORKING_SESSION_EXPIRED },
    });
    expect(client.raw.end).toHaveBeenCalled();
  });

  it("refuses to open for a bad bearer with an ordinary HTTP error, before any stream exists", async () => {
    const { streams } = setup();
    const client = fakeReply();
    await expect(
      streams.open("demo", { headers: { authorization: "Bearer nobody" }, ip: "127.0.0.1" } as unknown as FastifyRequest, client.reply),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(client.reply.hijack).not.toHaveBeenCalled();
  });

  it("ends with reconnect (client resumes) when a catch-up read fails", async () => {
    const { open } = setup();
    const client = await open("Bearer ada");
    mocks.page.mockRejectedValueOnce(new Error("connection reset"));
    networkingNotificationHub.publish({ eventId: "event-1", profileId: "profile-1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.frames().at(-1)).toEqual({ event: "reconnect", data: { reason: "error" } });
    expect(client.raw.end).toHaveBeenCalled();
  });
});

describe("participant stream: REALTIME_DISABLED", () => {
  it("stays available and falls back to the 60 s safety resync for notices it is not told about", async () => {
    const { open } = setup({ realtimeDisabled: true });
    const client = await open("Bearer ada");
    expect(client.frames()[0]!.event).toBe("ready");
    // No outbox notice reaches the hub; the resync finds the row.
    const row = notify("event-1", "profile-1");
    await vi.advanceTimersByTimeAsync(NETWORKING_STREAM.resyncMs - 1_000);
    expect(client.sentIds()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.sentIds()).toEqual([row.id]);
  });
});
