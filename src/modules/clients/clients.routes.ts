import { z } from "zod";
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
import { Client, MODULE_IDS } from "./clients.schema.js";
import { IdParamSchema } from "@shared/schemas/params.js";
import { listQuery } from "@shared/schemas/common.js";
import type { AppInstance } from "@shared/fastify.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";

export async function clientsRoutes(app: AppInstance): Promise<void> {
  // All routes require authentication
  app.addHook("onRequest", requireAuth);

  const createBody = Client.extend({
    adminName: z.string().min(1).max(100),
    adminEmail: z.string().email(),
    adminPassword: z
      .string()
      .min(12, "Password must be at least 12 characters")
      .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
      .regex(/[a-z]/, "Password must contain at least one lowercase letter")
      .regex(/[0-9]/, "Password must contain at least one number")
      .regex(
        /[!@#$%^&*(),.?":{}|<>]/,
        "Password must contain at least one special character",
      ),
  }).strict();

  const updateBody = Client.omit({ enabledModules: true })
    .partial()
    .extend({
      active: z.boolean().optional(),
      enabledModules: z.array(z.enum(MODULE_IDS)).optional(),
    })
    .strict();

  const listParams = listQuery({
    active: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
  });

  // GET /api/clients/me - Get current user's client (any authenticated user)
  app.get("/me", async (request, reply) => {
    // requireAuth middleware guarantees user exists
    const { clientId } = request.user!;

    if (!clientId) {
      throw new AppError(
        "User is not associated with any client",
        404,
        true,
        ErrorCodes.NOT_FOUND,
      );
    }

    const client = await getClientById(clientId);
    if (!client) {
      throw new AppError("Client not found", 404, true, ErrorCodes.NOT_FOUND);
    }

    return reply.send(client);
  });

  // POST /api/clients - Create client (super_admin only)
  app.post<{ Body: z.infer<typeof createBody> }>(
    "/",
    {
      preHandler: [requireSuperAdmin],
      schema: { body: createBody },
    },
    async (request, reply) => {
      const client = await createClient(request.body, request.user!.id);
      return reply.status(201).send(client);
    },
  );

  // GET /api/clients - List clients (super_admin only)
  app.get<{ Querystring: z.infer<typeof listParams> }>(
    "/",
    {
      preHandler: [requireSuperAdmin],
      schema: { querystring: listParams },
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
      schema: { params: IdParamSchema },
    },
    async (request, reply) => {
      // Check if user is super_admin or requesting their own client
      if (!canAccessClient(request.user!, request.params.id)) {
        throw new AppError(
          "Insufficient permissions to access this client",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      const client = await getClientById(request.params.id, {
        includeAdmin: true,
      });
      if (!client) {
        throw new AppError("Client not found", 404, true, ErrorCodes.NOT_FOUND);
      }

      return reply.send(client);
    },
  );

  // PATCH /api/clients/:id - Update client (super_admin only)
  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateBody> }>(
    "/:id",
    {
      preHandler: [requireSuperAdmin],
      schema: { params: IdParamSchema, body: updateBody },
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
      schema: { params: IdParamSchema },
    },
    async (request, reply) => {
      await deleteClient(request.params.id, request.user!.id);
      return reply.status(204).send();
    },
  );
}
