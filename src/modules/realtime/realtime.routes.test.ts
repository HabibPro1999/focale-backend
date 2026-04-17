import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import fastifySSE from "@fastify/sse";
import { realtimeRoutes, drainRealtimeConnections } from "./realtime.routes.js";
import { eventBus } from "@core/events/bus.js";
import type { AppInstance } from "@shared/types/fastify.js";

const h = vi.hoisted(() => ({
  currentUser: null as null | Record<string, unknown>,
}));

vi.mock("@shared/middleware/auth.middleware.js", () => ({
  requireAuth: async (request: { user?: unknown }) => {
    request.user = h.currentUser ?? undefined;
  },
}));

const mockUsers = {
  clientAdmin: {
    id: "ca-1",
    role: 1,
    clientId: "client-A",
    email: "ca@x",
    name: "CA",
    active: true,
  },
  superAdmin: {
    id: "sa-1",
    role: 0,
    clientId: null,
    email: "sa@x",
    name: "SA",
    active: true,
  },
  strangeRole: {
    id: "x-1",
    role: 99,
    clientId: null,
    email: "x@x",
    name: "X",
    active: true,
  },
} as const;

async function buildTestApp(): Promise<AppInstance> {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(fastifySSE, { heartbeatInterval: 60000 });
  await app.register(realtimeRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

interface SseMessage {
  event?: string;
  data?: string;
}

function parseBuffer(buf: string): {
  messages: SseMessage[];
  remainder: string;
} {
  const parts = buf.split("\n\n");
  const remainder = parts.pop() ?? "";
  const messages: SseMessage[] = [];
  for (const chunk of parts) {
    if (!chunk.trim()) continue;
    const m: SseMessage = {};
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event: ")) m.event = line.slice(7);
      else if (line.startsWith("data: ")) {
        m.data = (m.data ?? "") + line.slice(6);
      }
    }
    messages.push(m);
  }
  return { messages, remainder };
}

/**
 * Opens an SSE stream and returns a helper that waits for a predicate
 * over the accumulated messages.
 */
async function openStream(url: string): Promise<{
  waitFor: (
    predicate: (msgs: SseMessage[]) => boolean,
    timeoutMs?: number,
  ) => Promise<SseMessage[]>;
  close: () => void;
  response: Response;
}> {
  const ctrl = new AbortController();
  const response = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal: ctrl.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  const messages: SseMessage[] = [];
  let buffer = "";
  let readErr: Error | null = null;
  let done = false;

  const loop = (async () => {
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
    void loop;
  };

  return { waitFor, close, response };
}

describe("GET /api/stream", () => {
  let app: AppInstance | null = null;
  let openConn: { close: () => void } | null = null;

  beforeEach(() => {
    h.currentUser = null;
  });

  afterEach(async () => {
    if (openConn) {
      openConn.close();
      openConn = null;
    }
    drainRealtimeConnections();
    if (app) {
      await app.close();
      app = null;
    }
    // allow onClose hooks + bus.off to settle
    await new Promise((r) => setTimeout(r, 30));
    // reset bus state if anything leaked
    if (eventBus.listenerCount() > 0) {
      // This shouldn't happen; log loudly if it does
      console.warn(
        `[realtime test] bus listener leak: ${eventBus.listenerCount()}`,
      );
    }
  });

  it("client admin receives events scoped to own clientId only", async () => {
    h.currentUser = mockUsers.clientAdmin;
    app = await buildTestApp();
    const addr = await app.listen({ port: 0, host: "127.0.0.1" });

    const conn = await openStream(addr + "/api/stream");
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
    h.currentUser = mockUsers.clientAdmin;
    app = await buildTestApp();
    const addr = await app.listen({ port: 0, host: "127.0.0.1" });

    const conn = await openStream(addr + "/api/stream?eventId=ev-1");
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

  it("super admin without ?clientId receives scope-required and closes", async () => {
    h.currentUser = mockUsers.superAdmin;
    app = await buildTestApp();
    const addr = await app.listen({ port: 0, host: "127.0.0.1" });

    const conn = await openStream(addr + "/api/stream");
    openConn = conn;

    await conn.waitFor((m) => m.some((x) => x.event === "scope-required"));
    expect(eventBus.listenerCount()).toBe(0);
  });

  it("super admin with ?clientId is scoped to the requested client", async () => {
    h.currentUser = mockUsers.superAdmin;
    app = await buildTestApp();
    const addr = await app.listen({ port: 0, host: "127.0.0.1" });

    const conn = await openStream(addr + "/api/stream?clientId=client-Z");
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
    h.currentUser = mockUsers.strangeRole;
    app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/stream" });
    expect(res.statusCode).toBe(403);
  });

  it("disconnect removes the bus listener", async () => {
    h.currentUser = mockUsers.clientAdmin;
    app = await buildTestApp();
    const addr = await app.listen({ port: 0, host: "127.0.0.1" });

    const conn = await openStream(addr + "/api/stream");
    await conn.waitFor((m) => m.some((x) => x.event === "ready"));
    expect(eventBus.listenerCount()).toBe(1);

    conn.close();
    // Give server onClose hook time to fire
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      if (eventBus.listenerCount() === 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(eventBus.listenerCount()).toBe(0);
  });
});
