import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Module } from "@nestjs/common";
import { APP_PIPE, NestFactory, Reflector } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";

// The real AuthGuard runs; mock only its side-effecting deps so it does the
// real token->user->tenant-active work with our fixtures (mirrors the clients
// controller test's approach — @nestjs/testing is not a dependency here).
vi.mock("@app/integrations", () => ({
  verifyToken: vi.fn(async () => ({ uid: "u1" })),
}));
vi.mock("@app/db", () => ({
  getUserWithClientById: vi.fn(),
  getUserIdsByClient: vi.fn(async () => []),
}));

import { getUserWithClientById } from "@app/db";
import { clearUserCache } from "../../core/auth/user-cache";
import { ZodValidationPipe } from "../../core/zod";
import { CONFIG, type Config } from "../../core/config";
import { RealtimeController } from "./realtime.controller";
import { RealtimeConnectionRegistry } from "./connections";
import { eventBus } from "./bus";

const getUser = vi.mocked(getUserWithClientById);
const AUTH = { authorization: "Bearer test" };

const testConfig = {
  // heartbeat pushed far out so keep-alive comments never interleave in the
  // sub-second test windows.
  realtime: { disabled: false, heartbeatMs: 60_000, clientRetryMs: 15_000 },
} as unknown as Config;

const TS = new Date("2024-01-01T00:00:00Z");

/** A user row (+ joined client) as getUserWithClientById returns it. */
function dbUser(role: number, clientId: string | null, active = true) {
  return {
    id: "u1",
    email: "u1@example.com",
    name: "User One",
    role,
    clientId,
    active: true,
    createdAt: TS,
    updatedAt: TS,
    client: clientId
      ? {
          id: clientId,
          name: "Client",
          logo: null,
          primaryColor: null,
          email: null,
          phone: null,
          active,
          enabledModules: null,
          createdAt: TS,
          updatedAt: TS,
        }
      : null,
  };
}

@Module({
  controllers: [RealtimeController],
  providers: [
    RealtimeConnectionRegistry,
    { provide: CONFIG, useValue: testConfig },
    Reflector,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
class TestRealtimeModule {}

interface SseMessage {
  event?: string;
  data?: string;
  id?: string;
}

function parseBuffer(buf: string): { messages: SseMessage[]; remainder: string } {
  const parts = buf.split("\n\n");
  const remainder = parts.pop() ?? "";
  const messages: SseMessage[] = [];
  for (const chunk of parts) {
    if (!chunk.trim()) continue;
    const m: SseMessage = {};
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event: ")) m.event = line.slice(7);
      else if (line.startsWith("id: ")) m.id = line.slice(4);
      else if (line.startsWith("data: ")) m.data = (m.data ?? "") + line.slice(6);
    }
    messages.push(m);
  }
  return { messages, remainder };
}

async function openStream(
  url: string,
  headers: Record<string, string> = {},
): Promise<{
  waitFor: (
    predicate: (msgs: SseMessage[]) => boolean,
    timeoutMs?: number,
  ) => Promise<SseMessage[]>;
  close: () => void;
}> {
  const ctrl = new AbortController();
  const response = await fetch(url, {
    headers: {
      Accept: "text/event-stream",
      Authorization: "Bearer test",
      ...headers,
    },
    signal: ctrl.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  const messages: SseMessage[] = [];
  let buffer = "";
  let readErr: Error | null = null;
  let done = false;

  void (async () => {
    try {
      while (!done) {
        const { value, done: rdone } = await reader.read();
        if (rdone) break;
        buffer += decoder.decode(value, { stream: true });
        const { messages: newMsgs, remainder } = parseBuffer(buffer);
        if (newMsgs.length) messages.push(...newMsgs);
        buffer = remainder;
      }
    } catch (e) {
      readErr = e as Error;
    }
  })();

  const waitFor = async (
    predicate: (msgs: SseMessage[]) => boolean,
    timeoutMs = 1000,
  ): Promise<SseMessage[]> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate(messages)) return [...messages];
      if (readErr) throw readErr;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      `Timed out waiting for predicate after ${timeoutMs}ms. Collected: ${JSON.stringify(
        messages,
      )}`,
    );
  };

  const close = () => {
    done = true;
    try {
      ctrl.abort();
    } catch {
      /* noop */
    }
  };

  return { waitFor, close };
}

describe("GET /api/stream", () => {
  let app: NestFastifyApplication | null = null;
  let openConn: { close: () => void } | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    clearUserCache();
  });

  afterEach(async () => {
    if (openConn) {
      openConn.close();
      openConn = null;
    }
    if (app) {
      app.get(RealtimeConnectionRegistry).drainAll();
      await app.close();
      app = null;
    }
    await new Promise((r) => setTimeout(r, 30));
    if (eventBus.listenerCount() > 0) {
      console.warn(
        `[realtime test] bus listener leak: ${eventBus.listenerCount()}`,
      );
    }
  });

  async function buildApp(): Promise<string> {
    app = await NestFactory.create<NestFastifyApplication>(
      TestRealtimeModule,
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port: number };
    return `http://127.0.0.1:${address.port}`;
  }

  it("client admin receives events scoped to own clientId only", async () => {
    getUser.mockResolvedValue(dbUser(1, "client-A"));
    const base = await buildApp();

    const conn = await openStream(base + "/api/stream");
    openConn = conn;

    await conn.waitFor((m) => m.some((x) => x.event === "ready"));
    expect(eventBus.listenerCount()).toBe(1);

    eventBus.emit({
      type: "registration.updated",
      clientId: "client-A",
      eventId: "ev-1",
      payload: { id: "r-1" },
      ts: 1,
    });
    eventBus.emit({
      type: "registration.updated",
      clientId: "client-B",
      eventId: "ev-1",
      payload: { id: "r-2" },
      ts: 2,
    });

    const all = await conn.waitFor(
      (m) => m.filter((x) => !x.event && x.data).length >= 1,
    );
    const dataOnly = all.filter((x) => !x.event && x.data);
    expect(dataOnly).toHaveLength(1);
    expect(JSON.parse(dataOnly[0].data!).payload.id).toBe("r-1");
  });

  it("filters by eventId when provided", async () => {
    getUser.mockResolvedValue(dbUser(1, "client-A"));
    const base = await buildApp();

    const conn = await openStream(base + "/api/stream?eventId=ev-1");
    openConn = conn;
    await conn.waitFor((m) => m.some((x) => x.event === "ready"));

    eventBus.emit({
      type: "registration.updated",
      clientId: "client-A",
      eventId: "ev-1",
      payload: { id: "match" },
      ts: 1,
    });
    eventBus.emit({
      type: "registration.updated",
      clientId: "client-A",
      eventId: "ev-2",
      payload: { id: "skip" },
      ts: 2,
    });

    const all = await conn.waitFor(
      (m) => m.filter((x) => !x.event && x.data).length >= 1,
    );
    const dataOnly = all.filter((x) => !x.event && x.data);
    expect(dataOnly).toHaveLength(1);
    expect(JSON.parse(dataOnly[0].data!).payload.id).toBe("match");
  });

  it("does not deliver client-scoped events to an event-scoped stream", async () => {
    getUser.mockResolvedValue(dbUser(1, "client-A"));
    const base = await buildApp();

    const conn = await openStream(base + "/api/stream?eventId=ev-1");
    openConn = conn;
    await conn.waitFor((m) => m.some((x) => x.event === "ready"));

    eventBus.emit({
      type: "registration.updated",
      clientId: "client-A",
      payload: { id: "client-wide" },
      ts: 1,
    });

    await new Promise((r) => setTimeout(r, 50));
    const noDataFrames = (m: SseMessage[]) =>
      m.filter((x) => x.data && !x.event).length === 0;
    const res = await conn.waitFor((m) => noDataFrames(m), 100).catch(() => null);
    expect(res).not.toBeNull();
  });

  it("super admin without ?clientId receives scope-required and closes", async () => {
    getUser.mockResolvedValue(dbUser(0, null));
    const base = await buildApp();

    const conn = await openStream(base + "/api/stream");
    openConn = conn;

    await conn.waitFor((m) => m.some((x) => x.event === "scope-required"));
    expect(eventBus.listenerCount()).toBe(0);
  });

  it("super admin with ?clientId is scoped to the requested client", async () => {
    getUser.mockResolvedValue(dbUser(0, null));
    const base = await buildApp();

    const conn = await openStream(base + "/api/stream?clientId=client-Z");
    openConn = conn;
    await conn.waitFor((m) => m.some((x) => x.event === "ready"));

    eventBus.emit({
      type: "registration.updated",
      clientId: "client-Z",
      eventId: "e",
      payload: { id: "yes" },
      ts: 1,
    });
    eventBus.emit({
      type: "registration.updated",
      clientId: "client-other",
      eventId: "e",
      payload: { id: "no" },
      ts: 2,
    });

    const all = await conn.waitFor(
      (m) => m.filter((x) => !x.event && x.data).length >= 1,
    );
    const dataOnly = all.filter((x) => !x.event && x.data);
    expect(dataOnly).toHaveLength(1);
    expect(JSON.parse(dataOnly[0].data!).payload.id).toBe("yes");
  });

  it("unrecognized role is forbidden", async () => {
    getUser.mockResolvedValue(dbUser(99, null));
    app = await NestFactory.create<NestFastifyApplication>(
      TestRealtimeModule,
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const res = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "GET", url: "/api/stream", headers: AUTH });
    expect(res.statusCode).toBe(403);
  });

  it("emits an id on every data frame for Last-Event-ID replay", async () => {
    getUser.mockResolvedValue(dbUser(1, "client-A"));
    const base = await buildApp();

    const conn = await openStream(base + "/api/stream");
    openConn = conn;
    await conn.waitFor((m) => m.some((x) => x.event === "ready"));

    eventBus.emit({
      type: "registration.updated",
      clientId: "client-A",
      eventId: "ev-1",
      payload: { id: "r-1" },
      ts: 1,
    });

    const all = await conn.waitFor(
      (m) => m.filter((x) => x.data && !x.event).length >= 1,
    );
    const dataFrames = all.filter((x) => x.data && !x.event);
    expect(dataFrames[0].id).toBeDefined();
    expect(Number(dataFrames[0].id)).toBeGreaterThan(0);
  });

  it("replays buffered events after Last-Event-ID on reconnect", async () => {
    getUser.mockResolvedValue(dbUser(1, "client-A"));
    const base = await buildApp();

    const id1 = eventBus.emit({
      type: "registration.updated",
      clientId: "client-A",
      eventId: "ev-1",
      payload: { id: "early" },
      ts: 1,
    });
    eventBus.emit({
      type: "registration.updated",
      clientId: "client-A",
      eventId: "ev-1",
      payload: { id: "mid" },
      ts: 2,
    });
    eventBus.emit({
      type: "registration.updated",
      clientId: "client-A",
      eventId: "ev-1",
      payload: { id: "late" },
      ts: 3,
    });

    const conn = await openStream(base + "/api/stream", {
      "Last-Event-ID": id1,
    });
    openConn = conn;

    const all = await conn.waitFor(
      (m) => m.filter((x) => x.data && !x.event).length >= 2,
    );
    const dataFrames = all.filter((x) => x.data && !x.event);
    const ids = dataFrames.map((x) => JSON.parse(x.data!).payload.id);
    expect(ids).toEqual(["mid", "late"]);
  });

  it("emits replay-gap when Last-Event-ID predates the retained buffer", async () => {
    getUser.mockResolvedValue(dbUser(1, "client-A"));
    const base = await buildApp();

    const oldId = eventBus.emit({
      type: "registration.updated",
      clientId: "client-A",
      eventId: "ev-1",
      payload: { id: "old" },
      ts: 1,
    });
    for (let i = 0; i < 501; i++) {
      eventBus.emit({
        type: "registration.updated",
        clientId: "client-A",
        eventId: "ev-1",
        payload: { id: `overflow-${i}` },
        ts: i + 2,
      });
    }

    const conn = await openStream(base + "/api/stream", {
      "Last-Event-ID": oldId,
    });
    openConn = conn;

    const all = await conn.waitFor((m) => m.some((x) => x.event === "replay-gap"));
    expect(all.some((x) => x.event === "replay-gap")).toBe(true);
  });

  it("ignores Last-Event-ID for events outside client scope", async () => {
    getUser.mockResolvedValue(dbUser(1, "client-A"));
    const base = await buildApp();

    const id = eventBus.emit({
      type: "registration.updated",
      clientId: "client-OTHER",
      eventId: "ev-1",
      payload: { id: "not-mine" },
      ts: 1,
    });

    const conn = await openStream(base + "/api/stream", {
      "Last-Event-ID": String(Number(id) - 1),
    });
    openConn = conn;
    await conn.waitFor((m) => m.some((x) => x.event === "ready"));

    await new Promise((r) => setTimeout(r, 50));
    const readyOnly = (m: SseMessage[]) =>
      m.filter((x) => x.data && !x.event).length === 0;
    const res = await conn.waitFor((m) => readyOnly(m), 100).catch(() => null);
    expect(res).not.toBeNull();
  });

  it("disconnect removes the bus listener", async () => {
    getUser.mockResolvedValue(dbUser(1, "client-A"));
    const base = await buildApp();

    const conn = await openStream(base + "/api/stream");
    await conn.waitFor((m) => m.some((x) => x.event === "ready"));
    expect(eventBus.listenerCount()).toBe(1);

    conn.close();
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      if (eventBus.listenerCount() === 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(eventBus.listenerCount()).toBe(0);
  });
});
