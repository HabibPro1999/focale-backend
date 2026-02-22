import { z } from "zod";
import {
  requireAuth,
  canAccessClient,
  requireEventAccess,
} from "@shared/middleware/auth.middleware.js";
import {
  createEventAccess,
  updateEventAccess,
  deleteEventAccess,
  listEventAccess,
  getEventAccessById,
  CreateEventAccessSchema,
  UpdateEventAccessSchema,
} from "./access.service.js";
import { AccessTypeSchema } from "./access.schema.js";
import { EventIdParamSchema, IdParamSchema } from "@shared/schemas/params.js";
import type { AppInstance } from "@shared/fastify.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";

// ============================================================================
// Inline Request Schemas
// ============================================================================

const listAccessQuery = z
  .object({
    active: z.preprocess(
      (v) => (v === "true" ? true : v === "false" ? false : undefined),
      z.boolean().optional(),
    ),
    type: AccessTypeSchema.optional(),
  })
  .strict();

// ============================================================================
// Protected Routes (Admin)
// ============================================================================

export async function accessRoutes(app: AppInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  // POST /api/events/:eventId/access - Create access item
  app.post<{
    Params: z.infer<typeof EventIdParamSchema>;
    Body: Omit<z.infer<typeof CreateEventAccessSchema>, "eventId">;
  }>(
    "/:eventId/access",
    {
      schema: {
        params: EventIdParamSchema,
        body: CreateEventAccessSchema.omit({ eventId: true }),
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const input: z.infer<typeof CreateEventAccessSchema> = {
        ...request.body,
        eventId,
      };

      await requireEventAccess(request.user!, eventId);

      const access = await createEventAccess(input);
      return reply.status(201).send(access);
    },
  );

  // GET /api/events/:eventId/access - List access items
  app.get<{
    Params: z.infer<typeof EventIdParamSchema>;
    Querystring: z.infer<typeof listAccessQuery>;
  }>(
    "/:eventId/access",
    {
      schema: {
        params: EventIdParamSchema,
        querystring: listAccessQuery,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const query = request.query;

      await requireEventAccess(request.user!, eventId);

      const access = await listEventAccess(eventId, {
        active: query.active,
        type: query.type,
      });
      return reply.send(access);
    },
  );

  // GET /api/access/:id - Get single access item
  app.get<{ Params: z.infer<typeof IdParamSchema> }>(
    "/access/:id",
    {
      schema: { params: IdParamSchema },
    },
    async (request, reply) => {
      const { id } = request.params;

      const access = await getEventAccessById(id);
      if (!access) {
        throw new AppError(
          "Access item not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (!canAccessClient(request.user!, access.event.clientId)) {
        throw new AppError(
          "Insufficient permissions",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      return reply.send(access);
    },
  );

  // PATCH /api/access/:id - Update access item
  app.patch<{
    Params: z.infer<typeof IdParamSchema>;
    Body: z.infer<typeof UpdateEventAccessSchema>;
  }>(
    "/access/:id",
    {
      schema: {
        params: IdParamSchema,
        body: UpdateEventAccessSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const input = request.body;

      const access = await getEventAccessById(id);
      if (!access) {
        throw new AppError(
          "Access item not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      await requireEventAccess(request.user!, access.eventId);

      const updatedAccess = await updateEventAccess(id, input);
      return reply.send(updatedAccess);
    },
  );

  // DELETE /api/access/:id - Delete access item
  app.delete<{ Params: z.infer<typeof IdParamSchema> }>(
    "/access/:id",
    {
      schema: { params: IdParamSchema },
    },
    async (request, reply) => {
      const { id } = request.params;

      const access = await getEventAccessById(id);
      if (!access) {
        throw new AppError(
          "Access item not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      await requireEventAccess(request.user!, access.eventId);

      await deleteEventAccess(id);
      return reply.status(204).send();
    },
  );
}
