import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

// Health probes call pingDb (SELECT 1). Override just that one export so the
// suite is DB-independent; everything else in @app/db stays real (lazy client).
const pingDbMock = vi.hoisted(() => vi.fn());
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pingDb: pingDbMock,
}));

import { buildApp } from "./app.factory";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("api e2e", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // Legacy /health parity: RAW body (no envelope), DB-gated status + code.
  it("GET /health returns the raw legacy healthy body + 200 (DI works under SWC)", async () => {
    pingDbMock.mockResolvedValue(true);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      status: "healthy",
      timestamp: expect.any(String),
      checks: { database: { status: "healthy" } },
    });
    expect(body.ok).toBeUndefined(); // not enveloped
    expect(res.headers["x-request-id"]).toMatch(UUID);
  });

  it("GET /health returns the raw legacy unhealthy body + 503 when the DB is down", async () => {
    pingDbMock.mockResolvedValue(false);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: "unhealthy",
      timestamp: expect.any(String),
      checks: { database: { status: "unhealthy" } },
    });
  });

  it("GET /health/live is always 200 { status: 'ok' } with zero I/O", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("GET /health/ready reflects DB readiness (200 ready / 503 not ready), raw body", async () => {
    pingDbMock.mockResolvedValue(true);
    const ok = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ status: "ready" });

    pingDbMock.mockResolvedValue(false);
    const down = await app.inject({ method: "GET", url: "/health/ready" });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ status: "not ready" });
  });

  it("echoes an incoming x-request-id header on a health probe", async () => {
    pingDbMock.mockResolvedValue(true);
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "test-123" },
    });
    expect(res.headers["x-request-id"]).toBe("test-123");
  });

  it("POST /health/echo with a bad body returns a VALIDATION_ERROR envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/health/echo",
      payload: { msg: "" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("VAL_2001");
    // Target-spec details contract: zod error.flatten() → { formErrors, fieldErrors }.
    expect(body.error.details).toMatchObject({
      formErrors: expect.any(Array),
      fieldErrors: { msg: expect.arrayContaining([expect.any(String)]) },
    });
    expect(body.requestId).toMatch(UUID);
  });

  it("POST /health/echo with a valid body echoes msg inside the envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/health/echo",
      payload: { msg: "hi" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ok: true, data: { msg: "hi" } });
  });

  it("registers @fastify/multipart (multipart/form-data content-type parser)", () => {
    const fastify = app.getHttpAdapter().getInstance();
    expect(fastify.hasContentTypeParser("multipart/form-data")).toBe(true);
  });

  it("unknown route returns a NOT_FOUND envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("RES_3001");
  });
});
