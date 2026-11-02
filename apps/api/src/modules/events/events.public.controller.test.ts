import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Module } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";

vi.mock("@app/db", () => ({
  getEventWithPricingAndClient: vi.fn(),
  // The exception filter calls these on every caught error; the real
  // implementations return null for non-pg errors, which is all these
  // tests throw.
  pgErrorCode: () => null,
  pgUniqueViolation: () => null,
}));

import * as db from "@app/db";
import { EventsPublicController } from "./events.public.controller";
import { EventsService } from "./events.service";
import { EnvelopeInterceptor } from "../../core/envelope.interceptor";
import { HttpExceptionFilter } from "../../core/http-exception.filter";
import { ZodValidationPipe } from "../../core/zod";

@Module({ controllers: [EventsPublicController], providers: [EventsService] })
class PublicTestModule {}

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    name: "Event",
    slug: "event",
    description: null,
    status: "OPEN",
    startDate: new Date("2026-06-01T00:00:00.000Z"),
    endDate: new Date("2026-06-02T00:00:00.000Z"),
    location: "Tunis",
    bannerUrl: null,
    client: {
      id: "client-1",
      name: "Client",
      logo: null,
      primaryColor: null,
      phone: "+216 71 000 000",
      active: true,
      enabledModules: ["registrations", "pricing"],
    },
    pricing: {
      basePrice: 100,
      currency: "TND",
      rules: [],
      onlinePaymentEnabled: false,
      onlinePaymentUrl: null,
      cashPaymentEnabled: false,
      bankName: "Bank",
      bankAccountName: "Client",
      bankAccountNumber: "TN59",
    },
    ...overrides,
  };
}

describe("events public routes", () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await NestFactory.create<NestFastifyApplication>(
      PublicTestModule,
      new FastifyAdapter(),
      { logger: false },
    );
    app.useGlobalPipes(new ZodValidationPipe());
    app.useGlobalInterceptors(new EnvelopeInterceptor(app.get(Reflector)));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns payment config for open events with an active client", async () => {
    vi.mocked(db.getEventWithPricingAndClient).mockResolvedValue(makeEvent() as never);

    const res = await app.inject({
      method: "GET",
      url: `/api/public/events/${EVENT_ID}/payment-config`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.data.event).toMatchObject({
      id: EVENT_ID,
      status: "OPEN",
      client: { id: "client-1", name: "Client", phone: "+216 71 000 000" },
    });
    expect(body.data.pricing.bankDetails).toMatchObject({ bic: "", iban: "TN59" });
  });

  it("404s closed events instead of exposing metadata", async () => {
    vi.mocked(db.getEventWithPricingAndClient).mockResolvedValue(
      makeEvent({ status: "CLOSED" }) as never,
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/public/events/${EVENT_ID}/payment-config`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s inactive-client events instead of exposing metadata", async () => {
    vi.mocked(db.getEventWithPricingAndClient).mockResolvedValue(
      makeEvent({
        client: {
          id: "client-1",
          name: "Client",
          logo: null,
          primaryColor: null,
          active: false,
          enabledModules: ["registrations", "pricing"],
        },
      }) as never,
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/public/events/${EVENT_ID}/payment-config`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s a missing event", async () => {
    vi.mocked(db.getEventWithPricingAndClient).mockResolvedValue(null);
    const res = await app.inject({
      method: "GET",
      url: `/api/public/events/${EVENT_ID}/payment-config`,
    });
    expect(res.statusCode).toBe(404);
  });
});
