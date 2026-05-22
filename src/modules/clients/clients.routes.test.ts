import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { createMockClient } from "../../../tests/helpers/factories.js";
import { clientsRoutes } from "./clients.routes.js";
import {
  createClient,
  deleteClient,
  getClientById,
  listClients,
  updateClient,
} from "./clients.service.js";
import type { AppInstance } from "@shared/types/fastify.js";

const h = vi.hoisted(() => ({
  currentUser: null as null | { role: number; clientId: string | null },
  currentClient: null as null | ReturnType<typeof createMockClient>,
  authError: null as null | Error,
}));

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

vi.mock("@shared/middleware/auth.middleware.js", () => ({
  requireAuth: async (request: { user?: unknown }) => {
    if (h.authError) {
      throw h.authError;
    }
    if (!h.currentUser) {
      throw httpError("Authentication required", 401);
    }
    request.user = h.currentUser;
    (request as { client?: unknown }).client = h.currentClient;
  },
  requireSuperAdmin: async (request: {
    user?: { role: number; clientId: string | null };
  }) => {
    if (!request.user) {
      throw httpError("Authentication required", 401);
    }
    if (request.user.role !== 0) {
      throw httpError("Insufficient permissions", 403);
    }
  },
  canAccessClient: (
    user: { role: number; clientId: string | null },
    clientId: string,
  ) => user.role === 0 || (user.role === 1 && user.clientId === clientId),
}));

vi.mock("./clients.service.js", () => ({
  createClient: vi.fn(),
  getClientById: vi.fn(),
  listClients: vi.fn(),
  updateClient: vi.fn(),
  deleteClient: vi.fn(),
}));

const clientId = "11111111-1111-4111-8111-111111111111";
const otherClientId = "22222222-2222-4222-8222-222222222222";

const serviceMocks = {
  createClient: vi.mocked(createClient),
  getClientById: vi.mocked(getClientById),
  listClients: vi.mocked(listClients),
  updateClient: vi.mocked(updateClient),
  deleteClient: vi.mocked(deleteClient),
};

async function buildTestApp(): Promise<AppInstance> {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(sensible);
  await app.register(clientsRoutes, { prefix: "/api/clients" });
  await app.ready();
  return app as unknown as AppInstance;
}

describe("clients routes", () => {
  let app: AppInstance;

  beforeEach(async () => {
    h.currentUser = { role: 0, clientId: null };
    h.currentClient = null;
    h.authError = null;
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /api/clients/me", () => {
    it("returns the current user's active client", async () => {
      const client = createMockClient({ id: clientId, active: true });
      h.currentUser = { role: 1, clientId };
      h.currentClient = client;

      const response = await app.inject({
        method: "GET",
        url: "/api/clients/me",
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).id).toBe(clientId);
      expect(serviceMocks.getClientById).not.toHaveBeenCalled();
    });

    it("returns auth rejections before loading the client", async () => {
      h.currentUser = { role: 1, clientId };
      h.authError = httpError("Client is inactive", 403);

      const response = await app.inject({
        method: "GET",
        url: "/api/clients/me",
      });

      expect(response.statusCode).toBe(403);
      expect(JSON.parse(response.body).message).toBe("Client is inactive");
      expect(serviceMocks.getClientById).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/clients/:id", () => {
    it("allows a client admin to read their own active client", async () => {
      const client = createMockClient({ id: clientId, active: true });
      h.currentUser = { role: 1, clientId };
      h.currentClient = client;

      const response = await app.inject({
        method: "GET",
        url: `/api/clients/${clientId}`,
      });

      expect(response.statusCode).toBe(200);
      expect(serviceMocks.getClientById).not.toHaveBeenCalled();
    });

    it("rejects client admins reading another client", async () => {
      h.currentUser = { role: 1, clientId };

      const response = await app.inject({
        method: "GET",
        url: `/api/clients/${otherClientId}`,
      });

      expect(response.statusCode).toBe(403);
      expect(serviceMocks.getClientById).not.toHaveBeenCalled();
    });

    it("allows super admins to read inactive clients", async () => {
      h.currentUser = { role: 0, clientId: null };
      serviceMocks.getClientById.mockResolvedValue(
        createMockClient({ id: clientId, active: false }),
      );

      const response = await app.inject({
        method: "GET",
        url: `/api/clients/${clientId}`,
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe("super-admin CRUD", () => {
    it("creates clients", async () => {
      const client = createMockClient({ name: "Acme" });
      serviceMocks.createClient.mockResolvedValue(client);

      const response = await app.inject({
        method: "POST",
        url: "/api/clients",
        payload: { name: "Acme", enabledModules: ["pricing", "pricing"] },
      });

      expect(response.statusCode).toBe(201);
      expect(serviceMocks.createClient).toHaveBeenCalledWith({
        name: "Acme",
        enabledModules: ["pricing"],
      });
    });

    it("rejects invalid create payloads", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/clients",
        payload: { name: "" },
      });

      expect(response.statusCode).toBe(400);
      expect(serviceMocks.createClient).not.toHaveBeenCalled();
    });

    it("lists clients with parsed query filters", async () => {
      serviceMocks.listClients.mockResolvedValue({
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

      const response = await app.inject({
        method: "GET",
        url: "/api/clients?active=false",
      });

      expect(response.statusCode).toBe(200);
      expect(serviceMocks.listClients).toHaveBeenCalledWith({
        page: 1,
        limit: 20,
        active: false,
      });
    });

    it("updates clients with replacement module semantics including empty list", async () => {
      const client = createMockClient({ id: clientId, enabledModules: [] });
      serviceMocks.updateClient.mockResolvedValue(client);

      const response = await app.inject({
        method: "PATCH",
        url: `/api/clients/${clientId}`,
        payload: { enabledModules: [] },
      });

      expect(response.statusCode).toBe(200);
      expect(serviceMocks.updateClient).toHaveBeenCalledWith(clientId, {
        enabledModules: [],
      });
    });

    it("deletes clients", async () => {
      serviceMocks.deleteClient.mockResolvedValue(undefined);

      const response = await app.inject({
        method: "DELETE",
        url: `/api/clients/${clientId}`,
      });

      expect(response.statusCode).toBe(204);
      expect(serviceMocks.deleteClient).toHaveBeenCalledWith(clientId);
    });

    it("rejects client admins from super-admin-only mutations", async () => {
      h.currentUser = { role: 1, clientId };

      const response = await app.inject({
        method: "PATCH",
        url: `/api/clients/${clientId}`,
        payload: { active: false },
      });

      expect(response.statusCode).toBe(403);
      expect(serviceMocks.updateClient).not.toHaveBeenCalled();
    });
  });
});
