import {
  requireAuth,
  requireSuperAdmin,
  canAccessClient,
} from "@shared/middleware/auth.middleware.js";
import {
  createClient,
  getClientById,
  listClients,
  updateClient,
  deleteClient,
} from "./clients.service.js";
import {
  CreateClientSchema,
  UpdateClientSchema,
  ListClientsQuerySchema,
  ClientIdParamSchema,
  type CreateClientInput,
  type UpdateClientInput,
  type ListClientsQuery,
} from "./clients.schema.js";
import type { AppInstance } from "@shared/types/fastify.js";

export async function clientsRoutes(app: AppInstance): Promise<void> {
  // All routes require authentication
  app.addHook("onRequest", requireAuth);

  // GET /api/clients/me - Get current user's client (any authenticated user)
  app.get("/me", async (request, reply) => {
    // requireAuth middleware guarantees user exists
    const { clientId } = request.user!;

    if (!clientId) {
      throw app.httpErrors.notFound("User is not associated with any client");
    }

    const client = await getClientById(clientId);
    if (!client) {
      throw app.httpErrors.notFound("Client not found");
    }

    return reply.send(client);
  });

  // POST /api/clients - Create client (super_admin only)
  app.post<{ Body: CreateClientInput }>(
    "/",
    {
      preHandler: [requireSuperAdmin],
      schema: { body: CreateClientSchema },
    },
    async (request, reply) => {
      const client = await createClient(request.body, request.user!.id);
      return reply.status(201).send(client);
    },
  );

  // GET /api/clients - List clients (super_admin only)
  app.get<{ Querystring: ListClientsQuery }>(
    "/",
    {
      preHandler: [requireSuperAdmin],
      schema: { querystring: ListClientsQuerySchema },
    },
    async (request, reply) => {
      const result = await listClients(request.query);
      return reply.send(result);
    },
  );

  // GET /api/clients/:id - Get client (super_admin or own client)
  app.get<{ Params: { id: string } }>(
    "/:id",
    {
      schema: { params: ClientIdParamSchema },
    },
    async (request, reply) => {
      // Check if user is super_admin or requesting their own client
      if (!canAccessClient(request.user!, request.params.id)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to access this client",
        );
      }

      const client = await getClientById(request.params.id);
      if (!client) {
        throw app.httpErrors.notFound("Client not found");
      }

      return reply.send(client);
    },
  );

  // PATCH /api/clients/:id - Update client (super_admin only)
  app.patch<{ Params: { id: string }; Body: UpdateClientInput }>(
    "/:id",
    {
      preHandler: [requireSuperAdmin],
      schema: { params: ClientIdParamSchema, body: UpdateClientSchema },
    },
    async (request, reply) => {
      const client = await updateClient(
        request.params.id,
        request.body,
        request.user!.id,
      );
      return reply.send(client);
    },
  );

  // DELETE /api/clients/:id - Delete client (super_admin only)
  app.delete<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: [requireSuperAdmin],
      schema: { params: ClientIdParamSchema },
    },
    async (request, reply) => {
      await deleteClient(request.params.id, request.user!.id);
      return reply.status(204).send();
    },
  );
}
