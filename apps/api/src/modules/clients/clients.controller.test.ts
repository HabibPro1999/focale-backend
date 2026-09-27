import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { ErrorCodes, UserRole } from "@app/contracts";
import type { ClientRow } from "@app/db";

// The real AuthGuard runs; we mock only its two side-effecting deps so it does
// the real token->user->tenant-active->role-gate work with our fixtures.
vi.mock("@app/integrations", () => ({
  verifyToken: vi.fn(async () => ({ uid: "u1" })),
}));
vi.mock("@app/db", () => ({
  getUserWithClientById: vi.fn(),
  getUserIdsByClient: vi.fn(async () => []),
  // The exception filter calls these on every caught error; the real
  // implementations return null for non-pg errors, which is all these
  // tests throw.
  pgErrorCode: () => null,
  pgUniqueViolation: () => null,
}));

import { authAs } from "../../testing/auth";
import { createTestApp } from "../../testing/create-test-app";
import { ClientsController } from "./clients.controller";
import { ClientsService } from "./clients.service";

const clientId = "11111111-1111-4111-8111-111111111111";
const otherClientId = "22222222-2222-4222-8222-222222222222";
let AUTH: ReturnType<typeof authAs>;

function makeClient(overrides: Partial<ClientRow> = {}): ClientRow {
  return {
    id: clientId,
    name: "Acme",
    logo: null,
    primaryColor: null,
    email: null,
    phone: null,
    active: true,
    enabledModules: ["pricing"],
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

const service = {
  create: vi.fn(),
  getById: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
};

describe("ClientsController (routes)", () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Default caller: super admin (no client).
    AUTH = authAs(UserRole.SUPER_ADMIN);

    app = await createTestApp({
      controllers: [ClientsController],
      providers: [{ provide: ClientsService, useValue: service }],
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /api/clients/me", () => {
    it("requires a user client ID before trying a fallback lookup", async () => {
      const res = await app.inject({ method: "GET", url: "/api/clients/me", headers: AUTH });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toEqual({ code: ErrorCodes.NOT_FOUND, message: "User is not associated with any client" });
      expect(service.getById).not.toHaveBeenCalled();
    });

    it.each([true, false])("loads a fallback when the attached client is null (exists=%s)", async (exists) => {
      AUTH = authAs(UserRole.SUPER_ADMIN, clientId, { client: null });
      service.getById.mockResolvedValue(exists ? makeClient() : null);
      const res = await app.inject({ method: "GET", url: "/api/clients/me", headers: AUTH });
      expect(service.getById).toHaveBeenCalledExactlyOnceWith(clientId);
      expect(res.statusCode).toBe(exists ? 200 : 404);
      if (exists) expect(res.json().data.id).toBe(clientId);
      else expect(res.json().error).toEqual({ code: ErrorCodes.NOT_FOUND, message: "Client not found" });
    });

    it("returns the attached client without calling the service", async () => {
      const client = makeClient({ active: true });
      authAs(UserRole.CLIENT_ADMIN, clientId, { client });

      const res = await app.inject({
        method: "GET",
        url: "/api/clients/me",
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.id).toBe(clientId);
      expect(service.getById).not.toHaveBeenCalled();
    });

    it("is rejected (403) before the handler when the tenant is inactive", async () => {
      const inactive = makeClient({ active: false });
      authAs(UserRole.CLIENT_ADMIN, clientId, { client: inactive });

      const res = await app.inject({
        method: "GET",
        url: "/api/clients/me",
        headers: AUTH,
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toBe("Client is inactive");
      expect(service.getById).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/clients/:id", () => {
    it("loads the requested client when the attached client is different", async () => {
      AUTH = authAs(UserRole.SUPER_ADMIN, clientId, { client: makeClient() });
      service.getById.mockResolvedValue(makeClient({ id: otherClientId }));
      const res = await app.inject({ method: "GET", url: `/api/clients/${otherClientId}`, headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.id).toBe(otherClientId);
      expect(service.getById).toHaveBeenCalledExactlyOnceWith(otherClientId);
    });

    it("lets a client admin read their own client without a service call", async () => {
      authAs(UserRole.CLIENT_ADMIN, clientId, { client: makeClient() });

      const res = await app.inject({
        method: "GET",
        url: `/api/clients/${clientId}`,
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(service.getById).not.toHaveBeenCalled();
    });

    it("rejects a client admin reading another client (403, no service call)", async () => {
      authAs(UserRole.CLIENT_ADMIN, clientId, { client: makeClient() });

      const res = await app.inject({
        method: "GET",
        url: `/api/clients/${otherClientId}`,
        headers: AUTH,
      });

      expect(res.statusCode).toBe(403);
      expect(service.getById).not.toHaveBeenCalled();
    });

    it("lets a super admin read an inactive client via the service", async () => {
      AUTH = authAs(UserRole.SUPER_ADMIN);
      service.getById.mockResolvedValue(makeClient({ active: false }));

      const res = await app.inject({
        method: "GET",
        url: `/api/clients/${clientId}`,
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(service.getById).toHaveBeenCalledWith(clientId);
    });
  });

  describe("super-admin CRUD", () => {
    it("creates a client (201) with schema-deduped enabledModules", async () => {
      service.create.mockResolvedValue(makeClient({ name: "Acme" }));

      const res = await app.inject({
        method: "POST",
        url: "/api/clients",
        headers: AUTH,
        payload: { name: "Acme", enabledModules: ["pricing", "pricing"] },
      });

      expect(res.statusCode).toBe(201);
      expect(service.create).toHaveBeenCalledWith({
        name: "Acme",
        enabledModules: ["pricing"],
      });
    });

    it("rejects an invalid create payload (400, no service call)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/clients",
        headers: AUTH,
        payload: { name: "" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      expect(service.create).not.toHaveBeenCalled();
    });

    it("lists clients with coerced query filters", async () => {
      service.list.mockResolvedValue({
        data: [],
        meta: {
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/clients?active=false",
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(service.list).toHaveBeenCalledWith({
        page: 1,
        limit: 20,
        active: false,
      });
    });

    it("passes an empty enabledModules list through on PATCH", async () => {
      service.update.mockResolvedValue(makeClient({ enabledModules: [] }));

      const res = await app.inject({
        method: "PATCH",
        url: `/api/clients/${clientId}`,
        headers: AUTH,
        payload: { enabledModules: [] },
      });

      expect(res.statusCode).toBe(200);
      expect(service.update).toHaveBeenCalledWith(clientId, {
        enabledModules: [],
      });
    });

    it("deletes a client (bare 204)", async () => {
      service.remove.mockResolvedValue(undefined);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/clients/${clientId}`,
        headers: AUTH,
      });

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
      expect(service.remove).toHaveBeenCalledWith(clientId);
    });

    it("rejects a client admin from a super-admin-only mutation (403)", async () => {
      authAs(UserRole.CLIENT_ADMIN, clientId, { client: makeClient() });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/clients/${clientId}`,
        headers: AUTH,
        payload: { active: false },
      });

      expect(res.statusCode).toBe(403);
      expect(service.update).not.toHaveBeenCalled();
    });
  });
});
