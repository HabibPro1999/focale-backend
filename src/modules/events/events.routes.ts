import { z } from "zod";
import {
  requireAuth,
  canAccessClient,
  requireEventAccess,
} from "@shared/middleware/auth.middleware.js";
import {
  createEvent,
  listEvents,
  updateEvent,
  deleteEvent,
} from "./events.service.js";
import { Event, EventStatusEnum } from "./events.schema.js";
import { IdParamSchema } from "@shared/schemas/params.js";
import { listQuery } from "@shared/schemas/common.js";
import type { AppInstance } from "@shared/fastify.js";
import { UserRole } from "@shared/constants.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";

export async function eventsRoutes(app: AppInstance): Promise<void> {
  // All routes require authentication
  app.addHook("onRequest", requireAuth);

  const createBody = Event.extend({
    clientId: z.string().uuid(),
  })
    .strict()
    .refine((d) => d.endDate >= d.startDate, {
      message: "End date must be greater than or equal to start date",
      path: ["endDate"],
    });

  const updateBody = Event.partial()
    .strict()
    .refine(
      (d) => {
        if (d.startDate && d.endDate) return d.endDate >= d.startDate;
        return true;
      },
      {
        message: "End date must be greater than or equal to start date",
        path: ["endDate"],
      },
    );

  const listParams = listQuery({
    clientId: z.string().uuid().optional(),
    status: EventStatusEnum.optional(),
  });

  // POST /api/events - Create event
  app.post<{ Body: z.infer<typeof createBody> }>(
    "/",
    {
      schema: { body: createBody },
    },
    async (request, reply) => {
      // Check if user is super_admin or creating event for their own client
      if (!canAccessClient(request.user!, request.body.clientId)) {
        throw new AppError(
          "Insufficient permissions to create event for this client",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      const event = await createEvent(request.body, request.user!.id);
      return reply.status(201).send(event);
    },
  );

  // GET /api/events - List events
  app.get<{ Querystring: z.infer<typeof listParams> }>(
    "/",
    {
      schema: { querystring: listParams },
    },
    async (request, reply) => {
      const query = { ...request.query };

      // Force clientId filter for client_admin users
      if (request.user!.role === UserRole.CLIENT_ADMIN) {
        if (!request.user!.clientId) {
          throw new AppError(
            "User is not associated with any client",
            400,
            true,
            ErrorCodes.VALIDATION_ERROR,
          );
        }
        query.clientId = request.user!.clientId;
      }

      const result = await listEvents(query);
      return reply.send(result);
    },
  );

  // GET /api/events/:id - Get event
  app.get<{ Params: { id: string } }>(
    "/:id",
    {
      schema: { params: IdParamSchema },
    },
    async (request, reply) => {
      const event = await requireEventAccess(request.user!, request.params.id);

      return reply.send(event);
    },
  );

  // PATCH /api/events/:id - Update event
  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateBody> }>(
    "/:id",
    {
      schema: { params: IdParamSchema, body: updateBody },
    },
    async (request, reply) => {
      // requireEventAccess fetches the event (with pricing) for ownership check.
      // Pass it to updateEvent to avoid a redundant DB read.
      const event = await requireEventAccess(request.user!, request.params.id);

      const updatedEvent = await updateEvent(
        request.params.id,
        request.body,
        request.user!.id,
        event,
      );
      return reply.send(updatedEvent);
    },
  );

  // DELETE /api/events/:id - Delete event
  app.delete<{ Params: { id: string } }>(
    "/:id",
    {
      schema: { params: IdParamSchema },
    },
    async (request, reply) => {
      await requireEventAccess(request.user!, request.params.id);

      await deleteEvent(request.params.id, request.user!.id);
      return reply.status(204).send();
    },
  );
}
