import "reflect-metadata";
import { EventEmitter } from "node:events";
import { HttpException } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

// 3.2 + 4.3: the participant notification stream (GET /api/networking/:slug/stream)
// is registered with the ShutdownCoordinator and drained on shutdown like the
// admin realtime stream.
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  networkingNotificationsPage: vi.fn(async () => []),
}));

import type { Config } from "../../core/config";
import { networkingNotificationHub } from "../../core/networking-notification-hub";
import { ShutdownCoordinator } from "../../core/shutdown";
import { NetworkingStreamController } from "./networking.stream.controller";
import { NetworkingStreamService } from "./networking.stream";
import type { NetworkingService } from "./networking.service";

function setup() {
  const lifecycle = new ShutdownCoordinator();
  const participant = vi.fn(async () => ({
    event: { id: "event" },
    profile: { id: "profile" },
    session: { id: "session" },
  }));
  const config = { realtime: { disabled: false, heartbeatMs: 25_000, clientRetryMs: 15_000 } } as unknown as Config;
  const streams = new NetworkingStreamService({ participant } as unknown as NetworkingService, config, lifecycle);
  const controller = new NetworkingStreamController(streams);
  const raw = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn(function (this: EventEmitter) {
      this.emit("close");
    }),
  });
  const reply = {
    hijack: vi.fn(),
    getHeaders: () => ({}),
    header: vi.fn(),
    raw,
  } as unknown as FastifyReply;
  const req = { headers: { authorization: "Bearer token" }, ip: "127.0.0.1" } as FastifyRequest;
  return { lifecycle, participant, streams, controller, raw, reply, req };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("networking participant stream shutdown", () => {
  it("is tracked while open, gets `event: shutdown` with a reconnect delay on drain, then untracks and stops everything", async () => {
    vi.useFakeTimers();
    const { lifecycle, streams, controller, raw, reply, req } = setup();
    await controller.stream("demo", req, reply);
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.openStreams).toBe(1);
    expect(networkingNotificationHub.size).toBe(1);

    lifecycle.beforeApplicationShutdown();
    await vi.advanceTimersByTimeAsync(0);

    const frame = raw.write.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .find((chunk) => chunk.startsWith("event: shutdown"));
    expect(frame).toMatch(/^event: shutdown\ndata: \{"reconnectInMs":(\d+)\}\nretry: \1\n\n$/);
    expect(raw.end).toHaveBeenCalled();
    expect(lifecycle.openStreams).toBe(0);
    expect(streams.openStreams("session")).toBe(0);
    expect(networkingNotificationHub.size).toBe(0);
    // Heartbeat, resync, session check and lifetime timers all cleared on close.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("untracks a stream the client closed", async () => {
    vi.useFakeTimers();
    const { lifecycle, streams, controller, raw, reply, req } = setup();
    await controller.stream("demo", req, reply);
    raw.emit("close");
    expect(lifecycle.openStreams).toBe(0);
    expect(streams.openStreams("session")).toBe(0);
    expect(networkingNotificationHub.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses a new stream with 503 while draining, before authenticating", async () => {
    const { lifecycle, participant, controller, reply, req } = setup();
    lifecycle.startDraining();
    await expect(controller.stream("demo", req, reply)).rejects.toBeInstanceOf(HttpException);
    expect(participant).not.toHaveBeenCalled();
    expect(reply.hijack).not.toHaveBeenCalled();
    expect(reply.header).toHaveBeenCalledWith("Retry-After", "5");
  });
});
