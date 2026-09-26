import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Controller, Get, Module } from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory, Reflector } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { z } from "zod";

import { EnvelopeInterceptor, SkipEnvelope } from "./envelope.interceptor";
import { HttpExceptionFilter } from "./http-exception.filter";
import { logger } from "./logger.service";
import { ResponseContract } from "./response-contract";

const Registration = z.object({
  id: z.string(),
  email: z.string(),
  event: z.object({ id: z.string(), name: z.string() }),
});

// What a service returns once a column is added and flows into the result.
const withNewColumn = () => ({
  id: "r1",
  email: "ada@example.com",
  internalScore: 42,
  event: { id: "e1", name: "Summit", clientId: "c1" },
});

@Controller("t")
class TestController {
  @Get("contract")
  @ResponseContract(Registration)
  contract() {
    return withNewColumn() as z.input<typeof Registration>;
  }

  @Get("exact")
  @ResponseContract(Registration)
  exact() {
    return { event: { name: "Summit", id: "e1" }, email: "ada@example.com", id: "r1" };
  }

  @Get("plain")
  plain() {
    return withNewColumn();
  }

  @Get("mismatch")
  @ResponseContract(Registration)
  mismatch() {
    return { id: 7, email: "ada@example.com", event: { id: "e1", name: "Summit" } } as never;
  }

  @Get("raw")
  @SkipEnvelope()
  @ResponseContract(Registration)
  raw() {
    return withNewColumn() as z.input<typeof Registration>;
  }
}

async function makeApp(
  config: { isProduction: boolean } | "di-without-config",
): Promise<NestFastifyApplication> {
  @Module({
    controllers: [TestController],
    providers:
      config === "di-without-config"
        ? [Reflector, { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor }]
        : [],
  })
  class TestModule {}

  const app = await NestFactory.create<NestFastifyApplication>(
    TestModule,
    new FastifyAdapter(),
    { logger: false },
  );
  if (config !== "di-without-config") {
    app.useGlobalInterceptors(new EnvelopeInterceptor(app.get(Reflector), config));
  }
  app.useGlobalFilters(
    new HttpExceptionFilter(config === "di-without-config" ? undefined : config),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe("EnvelopeInterceptor response contracts", () => {
  let app: NestFastifyApplication | undefined;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  describe.each([
    ["production", { isProduction: true }],
    ["development/test", { isProduction: false }],
    ["no injected config (bare fixtures)", "di-without-config"],
  ] as const)("%s", (_env, config) => {
    beforeEach(async () => {
      app = await makeApp(config);
    });

    it("strips keys the contract does not declare, at every depth", async () => {
      const res = await app!.inject({ method: "GET", url: "/t/contract" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(
        JSON.stringify({
          ok: true,
          data: {
            id: "r1",
            email: "ada@example.com",
            event: { id: "e1", name: "Summit" },
          },
        }),
      );
    });

    it("returns a matching payload byte for byte, key order included", async () => {
      const res = await app!.inject({ method: "GET", url: "/t/exact" });
      expect(res.body).toBe(
        JSON.stringify({ ok: true, data: new TestController().exact() }),
      );
    });

    it("leaves routes without a contract unchanged", async () => {
      const res = await app!.inject({ method: "GET", url: "/t/plain" });
      expect(res.body).toBe(JSON.stringify({ ok: true, data: withNewColumn() }));
    });

    it("applies the contract to a route that skips the envelope", async () => {
      const res = await app!.inject({ method: "GET", url: "/t/raw" });
      expect(res.json()).toEqual({
        id: "r1",
        email: "ada@example.com",
        event: { id: "e1", name: "Summit" },
      });
    });
  });

  describe("outside production", () => {
    beforeEach(async () => {
      app = await makeApp({ isProduction: false });
    });

    it("logs the stripped key paths with the handler, never the values", async () => {
      await app!.inject({ method: "GET", url: "/t/contract" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        {
          handler: "TestController.contract",
          strippedKeys: ["internalScore", "event.clientId"],
        },
        "Response contract stripped undeclared keys",
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("42");
      expect(JSON.stringify(warn.mock.calls)).not.toContain('"c1"');
    });

    it("does not log when nothing is stripped", async () => {
      await app!.inject({ method: "GET", url: "/t/exact" });
      await app!.inject({ method: "GET", url: "/t/plain" });
      expect(warn).not.toHaveBeenCalled();
    });

    it("fails the request with a 500 when the payload does not match its contract", async () => {
      const res = await app!.inject({ method: "GET", url: "/t/mismatch" });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({
        ok: false,
        error: {
          code: "SRV_5001",
          message:
            "Response of TestController.mismatch does not match its contract: id (invalid_type)",
        },
      });
    });
  });

  describe.each([
    ["production", { isProduction: true }],
    ["no injected config", "di-without-config"],
  ] as const)("%s", (_env, config) => {
    beforeEach(async () => {
      app = await makeApp(config);
    });

    it("strips without logging", async () => {
      await app!.inject({ method: "GET", url: "/t/contract" });
      expect(warn).not.toHaveBeenCalled();
    });

    it("does not validate: a mismatched payload is still returned, stripped", async () => {
      const res = await app!.inject({ method: "GET", url: "/t/mismatch" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({
        id: 7,
        email: "ada@example.com",
        event: { id: "e1", name: "Summit" },
      });
    });
  });
});
