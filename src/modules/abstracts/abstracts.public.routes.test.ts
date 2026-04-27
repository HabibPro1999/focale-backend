import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { faker } from "@faker-js/faker";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import { abstractsPublicRoutes } from "./abstracts.public.routes.js";

// Mock the service layer
vi.mock("./abstracts.service.js", () => ({
  getPublicConfig: vi.fn(),
  submitAbstract: vi.fn(),
  getAbstractByToken: vi.fn(),
  editAbstract: vi.fn(),
}));

// Mock token extraction — let through for route tests
vi.mock("./abstract-token.js", () => ({
  extractAbstractToken: vi.fn().mockReturnValue("a".repeat(64)),
  generateAbstractToken: vi.fn().mockReturnValue("a".repeat(64)),
  verifyAbstractToken: vi.fn().mockReturnValue(true),
}));

import {
  getPublicConfig,
  submitAbstract,
  getAbstractByToken,
  editAbstract,
} from "./abstracts.service.js";

async function buildTestApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible, { sharedSchemaId: "HttpError" });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  await app.register(abstractsPublicRoutes, { prefix: "/api/public" });
  return app;
}

describe("abstracts public routes", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  describe("GET /api/public/events/:slug/abstracts/config", () => {
    it("returns 200 with config", async () => {
      (getPublicConfig as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: true,
        submissionMode: "FREE_TEXT",
        themes: [],
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/public/events/test-slug/abstracts/config",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.enabled).toBe(true);
      expect(getPublicConfig).toHaveBeenCalledWith("test-slug");
    });
  });

  describe("POST /api/public/events/:slug/abstracts/submit", () => {
    it("returns 201 on valid submission", async () => {
      const themeId = faker.string.uuid();
      (submitAbstract as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: faker.string.uuid(),
        token: "a".repeat(64),
        status: "SUBMITTED",
        createdAt: new Date().toISOString(),
        statusUrl: "https://example.com/abstracts/abc/token",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/public/events/test-slug/abstracts/submit",
        payload: {
          authorFirstName: "Ahmed",
          authorLastName: "Salah",
          authorEmail: "ahmed@test.com",
          authorPhone: "+21612345678",
          coAuthors: [],
          requestedType: "ORAL_COMMUNICATION",
          themeIds: [themeId],
          content: { mode: "FREE_TEXT", title: "Test", body: "Body text" },
          additionalFieldsData: {},
          linkBaseUrl: "https://example.com",
        },
      });

      expect(response.statusCode).toBe(201);
      expect(submitAbstract).toHaveBeenCalled();
    });

    it("returns 400 on missing required fields", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/public/events/test-slug/abstracts/submit",
        payload: {
          authorFirstName: "Ahmed",
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /api/public/abstracts/:id", () => {
    it("returns 200 with abstract data", async () => {
      const abstractId = faker.string.uuid();
      (getAbstractByToken as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: abstractId,
        status: "SUBMITTED",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/public/abstracts/${abstractId}?token=${"a".repeat(64)}`,
      });

      expect(response.statusCode).toBe(200);
      expect(getAbstractByToken).toHaveBeenCalled();
    });
  });

  describe("PATCH /api/public/abstracts/:id", () => {
    it("returns 200 on valid edit", async () => {
      const abstractId = faker.string.uuid();
      const themeId = faker.string.uuid();
      (editAbstract as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: abstractId,
        status: "SUBMITTED",
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/public/abstracts/${abstractId}?token=${"a".repeat(64)}`,
        payload: {
          authorFirstName: "Ahmed",
          authorLastName: "Salah",
          authorEmail: "ahmed@test.com",
          authorPhone: "+21612345678",
          coAuthors: [],
          requestedType: "POSTER",
          themeIds: [themeId],
          content: { mode: "FREE_TEXT", title: "Updated", body: "New body" },
          additionalFieldsData: {},
          linkBaseUrl: "https://example.com",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(editAbstract).toHaveBeenCalled();
    });
  });
});
