import {
  requireAuth,
  canAccessClient,
} from "@shared/middleware/auth.middleware.js";
import { requireEventAccess } from "@shared/middleware/access-control.js";
import {
  createEventAccess,
  updateEventAccess,
  deleteEventAccess,
  listEventAccess,
  getEventAccessById,
} from "./access.service.js";
import {
  CreateEventAccessSchema,
  UpdateEventAccessSchema,
  ListEventAccessQuerySchema,
  EventAccessIdParamSchema,
  EventIdParamSchema,
  type CreateEventAccessInput,
  type UpdateEventAccessInput,
} from "./access.schema.js";
import type { AppInstance } from "@shared/types/fastify.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

// ============================================================================
// Protected Routes (Admin)
// ============================================================================

export async function accessRoutes(app: AppInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  // POST /api/events/:eventId/access - Create access item
  app.post<{
    Params: { eventId: string };
    Body: Omit<CreateEventAccessInput, "eventId">;
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
      const input: CreateEventAccessInput = { ...request.body, eventId };

      await requireEventAccess(request.user!, eventId);

      const access = await createEventAccess(input);
      return reply.status(201).send(access);
    },
  );

  // GET /api/events/:eventId/access - List access items
  app.get<{
    Params: { eventId: string };
    Querystring: { active?: boolean; type?: string };
  }>(
    "/:eventId/access",
    {
      schema: {
        params: EventIdParamSchema,
        querystring: ListEventAccessQuerySchema,
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
  app.get<{ Params: { id: string } }>(
    "/access/:id",
    {
      schema: { params: EventAccessIdParamSchema },
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
  app.patch<{ Params: { id: string }; Body: UpdateEventAccessInput }>(
    "/access/:id",
    {
      schema: {
        params: EventAccessIdParamSchema,
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
  app.delete<{ Params: { id: string } }>(
    "/access/:id",
    {
      schema: { params: EventAccessIdParamSchema },
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
