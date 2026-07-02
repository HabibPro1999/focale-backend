import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "./app.factory";
import { loadConfig } from "./core/config";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("api e2e", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildApp(loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns a success envelope with x-request-id header (DI works under SWC)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
    expect(typeof body.data.uptimeSec).toBe("number");
    expect(body.requestId).toMatch(UUID);
    expect(res.headers["x-request-id"]).toMatch(UUID);
  });

  it("echoes an incoming x-request-id header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "test-123" },
    });
    expect(res.headers["x-request-id"]).toBe("test-123");
    expect(res.json().requestId).toBe("test-123");
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
    expect(body.error.details).toBeDefined();
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

  it("unknown route returns a NOT_FOUND envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("RES_3001");
  });
});
