import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { Prisma } from "@/generated/prisma/client.js";
import { registrationsPublicRoutes } from "./registrations.public.routes.js";

const serviceMocks = vi.hoisted(() => ({
  createRegistration: vi.fn(),
  getRegistrationByIdempotencyKey: vi.fn(),
  getRegistrationForEdit: vi.fn(),
  editRegistrationPublic: vi.fn(),
  verifyEditToken: vi.fn(),
  uploadPaymentProof: vi.fn(),
  selectPaymentMethod: vi.fn(),
}));
const pricingMocks = vi.hoisted(() => ({
  calculatePrice: vi.fn(),
}));
const formMocks = vi.hoisted(() => ({
  getActiveRegistrationFormById: vi.fn(),
  validateFormData: vi.fn(),
  sanitizeFormData: vi.fn(),
}));
const clientMocks = vi.hoisted(() => ({
  assertClientModuleEnabled: vi.fn(),
}));

vi.mock("./registrations.service.js", () => serviceMocks);
vi.mock("@pricing", () => pricingMocks);
vi.mock("@forms", () => formMocks);
vi.mock("@clients", () => clientMocks);

async function buildTestApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible, { sharedSchemaId: "HttpError" });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  await app.register(registrationsPublicRoutes, {
    prefix: "/api/public/forms",
  });
  return app;
}

function prismaUniqueError(meta: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta,
  });
}

describe("registrations public routes", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  const formId = "11111111-1111-4111-8111-111111111111";
  const idempotencyKey = "22222222-2222-4222-8222-222222222222";

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
    formMocks.getActiveRegistrationFormById.mockResolvedValue({
      id: formId,
      eventId: "event-1",
      schema: {},
      event: { clientId: "client-1" },
    });
    formMocks.validateFormData.mockReturnValue({
      valid: true,
      data: { firstName: "Ada" },
      errors: [],
    });
    pricingMocks.calculatePrice.mockResolvedValue({
      basePrice: 100,
      appliedRules: [],
      calculatedBasePrice: 100,
      accessItems: [],
      accessTotal: 0,
      subtotal: 100,
      sponsorships: [],
      sponsorshipTotal: 0,
      total: 100,
      currency: "TND",
    });
  });

  it("returns the existing registration when concurrent idempotent create hits the unique key", async () => {
    const existingRegistration = {
      id: "reg-1",
      editToken: "t".repeat(64),
      priceBreakdown: { total: 100 },
    };
    serviceMocks.getRegistrationByIdempotencyKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingRegistration);
    serviceMocks.createRegistration.mockRejectedValue(
      prismaUniqueError({ target: ["idempotency_key"] }),
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/public/forms/${formId}/register`,
      payload: {
        formData: { firstName: "Ada" },
        email: "ada@example.com",
        idempotencyKey,
        linkBaseUrl: "https://example.com",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      registration: { id: "reg-1", token: "t".repeat(64) },
      priceBreakdown: { total: 100 },
    });
  });
});
