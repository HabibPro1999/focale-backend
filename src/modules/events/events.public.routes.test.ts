import { beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { prismaMock } from "../../../tests/mocks/prisma.js";
import { eventsPublicRoutes } from "./events.public.routes.js";

async function buildTestApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible, { sharedSchemaId: "HttpError" });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  await app.register(eventsPublicRoutes, { prefix: "/api/public/events" });
  return app;
}

function makePaymentConfigEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
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
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  it("returns payment config for open events with an active client", async () => {
    const event = makePaymentConfigEvent();
    prismaMock.event.findUnique.mockResolvedValue(event as never);

    const response = await app.inject({
      method: "GET",
      url: `/api/public/events/${event.id}/payment-config`,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).event).toMatchObject({
      id: event.id,
      status: "OPEN",
      client: { id: "client-1", name: "Client" },
    });
  });

  it("404s closed events instead of exposing metadata", async () => {
    const event = makePaymentConfigEvent({ status: "CLOSED" });
    prismaMock.event.findUnique.mockResolvedValue(event as never);

    const response = await app.inject({
      method: "GET",
      url: `/api/public/events/${event.id}/payment-config`,
    });

    expect(response.statusCode).toBe(404);
  });

  it("404s inactive-client events instead of exposing metadata", async () => {
    const event = makePaymentConfigEvent({
      client: {
        id: "client-1",
        name: "Client",
        logo: null,
        primaryColor: null,
        active: false,
        enabledModules: ["registrations", "pricing"],
      },
    });
    prismaMock.event.findUnique.mockResolvedValue(event as never);

    const response = await app.inject({
      method: "GET",
      url: `/api/public/events/${event.id}/payment-config`,
    });

    expect(response.statusCode).toBe(404);
  });
});
