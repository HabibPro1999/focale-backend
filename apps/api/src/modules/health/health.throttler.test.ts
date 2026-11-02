import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { ErrorCodes } from "@app/contracts";

// Every probe the controller serves, through the real app (buildApp: CoreModule,
// NetworkingThrottlerGuard, the exception filter) with a lowered default limit.
// The probe queries are stubbed so the suite stays DB-independent.
const db = vi.hoisted(() => {
  const healthy = () => vi.fn(async () => ({ isHealthy: true }));
  return {
    pingDb: vi.fn(async () => true),
    getEmailQueueHealth: healthy(),
    getAbstractBookQueueHealth: healthy(),
    getOutboxHealth: healthy(),
    getWorkerHealth: vi.fn(async () => ({
      isHealthy: true,
      reasons: [],
      counts: { live: 1, disabled: 0, overdueJobs: 0 },
    })),
    getNetworkingVectorIndexHealth: healthy(),
  };
});
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...db,
}));

import { buildApp } from "../../app.factory";
import { getConfig } from "../../core/config";

const LIMIT = 3;

const DATABASE_PROBES = [
  "/health",
  "/health/email-queue",
  "/health/abstract-book-jobs",
  "/health/outbox",
  "/health/worker",
  "/health/networking-vector-index",
];

describe("health probe throttling", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const base = getConfig();
    app = await buildApp({
      ...base,
      security: { ...base.security, rateLimit: { ...base.security.rateLimit, max: LIMIT } },
    });
    app.useLogger(false);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const probe = (url: string, remoteAddress = "198.51.100.10") =>
    app.inject({ method: "GET", url, remoteAddress });

  it.each(DATABASE_PROBES)("%s answers 429 past the per-IP default limit", async (url) => {
    for (let i = 0; i < LIMIT; i++) expect((await probe(url)).statusCode).toBe(200);

    const refused = await probe(url);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe(ErrorCodes.RATE_LIMITED);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);

    // The bucket is per client IP: another monitor is still answered.
    expect((await probe(url, "198.51.100.20")).statusCode).toBe(200);
  });

  it.each(["/health/live", "/health/ready"])("%s is never throttled", async (url) => {
    for (let i = 0; i < LIMIT * 5; i++) {
      const res = await probe(url);
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
    }
  });
});
