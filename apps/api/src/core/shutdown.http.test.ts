import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { ErrorCodes, UserRole } from "@app/contracts";

// 3.2 through the real app (buildApp: CoreModule, guards, filter, realtime):
// app.close() used to hang behind open SSE streams, because streams were only
// drained in onApplicationShutdown, which Nest runs after Fastify has closed.
// Only token verification and the user lookup are stubbed.
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getUserWithClientById: vi.fn(async () => ({
    id: "u1",
    email: "admin@example.com",
    name: "Admin",
    role: UserRole.CLIENT_ADMIN,
    clientId: "client-A",
    active: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    client: {
      id: "client-A",
      name: "Client",
      logo: null,
      primaryColor: null,
      email: null,
      phone: null,
      active: true,
      enabledModules: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  })),
}));
vi.mock("@app/integrations", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifyToken: vi.fn(async () => ({ uid: "u1" })),
}));

import { buildApp } from "../app.factory";
import { clearUserCache } from "./auth/user-cache";
import { NetworkingStreamService } from "../modules/networking/networking.stream";
import { ShutdownCoordinator } from "./shutdown";

interface Frame {
  event?: string;
  data?: string;
  retry?: string;
}

/** Minimal SSE reader: collects frames until the server ends the stream. */
async function openStream(url: string) {
  const response = await fetch(url, {
    headers: { Accept: "text/event-stream", Authorization: "Bearer token" },
  });
  const frames: Frame[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const ended = (async () => {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const frame: Frame = {};
        for (const line of part.split("\n")) {
          const [field, ...rest] = line.split(": ");
          if (field === "event" || field === "data" || field === "retry") frame[field] = rest.join(": ");
        }
        if (frame.event || frame.data) frames.push(frame);
      }
    }
  })();
  const waitFor = async (event: string, timeoutMs = 2_000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = frames.find((frame) => frame.event === event);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no "${event}" frame; got ${JSON.stringify(frames)}`);
  };
  return { status: response.status, frames, ended, waitFor };
}

describe("API shutdown with open SSE streams (real app)", () => {
  let app: NestFastifyApplication | undefined;

  beforeEach(() => {
    clearUserCache();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(): Promise<string> {
    app = await buildApp();
    app.useLogger(false);
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as { port: number };
    return `http://127.0.0.1:${port}`;
  }

  it("app.close() resolves in < 2 s and the open stream receives `shutdown` with a 1-5 s reconnect", async () => {
    const base = await start();
    const stream = await openStream(`${base}/api/stream`);
    expect(stream.status).toBe(200);
    await stream.waitFor("ready");
    expect(app!.get(ShutdownCoordinator).openStreams).toBe(1);

    const startedAt = Date.now();
    await app!.close();
    const elapsed = Date.now() - startedAt;
    app = undefined;

    expect(elapsed).toBeLessThan(2_000);
    const shutdown = await stream.waitFor("shutdown");
    const { reconnectInMs } = JSON.parse(shutdown.data!) as { reconnectInMs: number };
    expect(reconnectInMs).toBeGreaterThanOrEqual(1_000);
    expect(reconnectInMs).toBeLessThan(5_000);
    expect(Number(shutdown.retry)).toBe(reconnectInMs);
    await stream.ended; // the server ended the response
  });

  it("injects the same coordinator into the networking participant stream", async () => {
    await start();
    const streams = app!.get(NetworkingStreamService) as unknown as { lifecycle?: unknown };
    expect(streams.lifecycle).toBe(app!.get(ShutdownCoordinator));
  });

  it("while draining: new streams get 503 SRV_5003 + Retry-After and /health/ready reports draining", async () => {
    const base = await start();
    app!.get(ShutdownCoordinator).startDraining();

    const refused = await fetch(`${base}/api/stream`, {
      headers: { Accept: "text/event-stream", Authorization: "Bearer token" },
    });
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("5");
    expect(await refused.json()).toMatchObject({
      ok: false,
      error: { code: ErrorCodes.SERVER_SHUTTING_DOWN },
    });

    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: "draining" });

    const live = await fetch(`${base}/health/live`);
    expect(live.status).toBe(200);
  });
});
