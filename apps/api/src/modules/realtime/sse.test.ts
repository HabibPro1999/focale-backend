import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { SseStream } from "./sse";

describe("SseStream response headers", () => {
  it.each([false, true])("preserves Fastify CORS and other headers over HTTP (heartbeat first: %s)", async (heartbeatFirst) => {
    const app = Fastify();
    await app.register(cors, { origin: ["https://admin.example"], credentials: true });
    app.get("/stream", async (_request, reply) => {
      reply.header("X-Test-Header", "preserved");
      reply.header("Set-Cookie", ["a=1", "b=2"]);
      reply.header("Content-Type", "application/json");
      reply.hijack();
      const stream = new SseStream(reply);
      if (heartbeatFirst) stream.keepAlive(60000);
      await stream.send({ event: "ready", data: { ok: true } });
      stream.close();
    });
    try {
      const address = await app.listen({ port: 0, host: "127.0.0.1" });
      const response = await fetch(`${address}/stream`, { headers: { Origin: "https://admin.example" } });
      expect(response.headers.get("access-control-allow-origin")).toBe("https://admin.example");
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("vary")).toContain("Origin");
      expect(response.headers.get("x-test-header")).toBe("preserved");
      expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(await response.text()).toBe('event: ready\ndata: {"ok":true}\n\n');
    } finally {
      await app.close();
    }
  });
});
