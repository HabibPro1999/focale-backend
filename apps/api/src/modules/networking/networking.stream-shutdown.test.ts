import "reflect-metadata";
import { EventEmitter } from "node:events";
import { HttpException } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

// 3.2: the participant notification stream (GET /api/networking/:slug/stream)
// is drained on shutdown like the admin realtime stream.
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  networkingNotificationsSince: vi.fn(async () => []),
}));

import { ShutdownCoordinator } from "../../core/shutdown";
import { NetworkingPublicController } from "./networking.public.controller";
import type { NetworkingUploadsService } from "./networking.uploads.service";
import type { NetworkingService } from "./networking.service";
import type { NetworkingSocialService } from "./networking.social.service";
import type { NetworkingMeetingsService } from "./networking.meetings.service";
import type { NetworkingExportsService } from "./networking.exports.service";

function setup() {
  const lifecycle = new ShutdownCoordinator();
  const participant = vi.fn(async () => ({ event: { id: "event" }, profile: { id: "profile" } }));
  const controller = new NetworkingPublicController(
    {} as NetworkingUploadsService,
    { participant } as unknown as NetworkingService,
    {} as NetworkingSocialService,
    {} as NetworkingMeetingsService,
    {} as NetworkingExportsService,
    lifecycle,
  );
  const raw = Object.assign(new EventEmitter(), {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    write: vi.fn(),
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
  return { lifecycle, participant, controller, raw, reply, req };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("networking participant stream shutdown", () => {
  it("is tracked while open, gets `event: shutdown` with a reconnect delay on drain, then untracks", async () => {
    vi.useFakeTimers();
    const { lifecycle, controller, raw, reply, req } = setup();
    await controller.stream("demo", req, reply);
    expect(lifecycle.openStreams).toBe(1);

    lifecycle.beforeApplicationShutdown();

    const frame = raw.write.mock.calls.map(([chunk]) => String(chunk)).find((chunk) => chunk.startsWith("event: shutdown"));
    expect(frame).toMatch(/^event: shutdown\nretry: (\d+)\ndata: \{"reconnectInMs":\1\}\n\n$/);
    expect(raw.end).toHaveBeenCalled();
    expect(lifecycle.openStreams).toBe(0);
    expect(vi.getTimerCount()).toBe(0); // poll interval and 60 s cap cleared on close
  });

  it("untracks a stream the client closed", async () => {
    vi.useFakeTimers();
    const { lifecycle, controller, raw, reply, req } = setup();
    await controller.stream("demo", req, reply);
    raw.emit("close");
    expect(lifecycle.openStreams).toBe(0);
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
