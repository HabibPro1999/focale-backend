import {
  requireAuth,
  canAccessClient,
} from "@shared/middleware/auth.middleware.js";
import {
  createEvent,
  getEventById,
  listEvents,
  updateEvent,
  deleteEvent,
} from "./events.service.js";
import {
  CreateEventSchema,
  UpdateEventSchema,
  ListEventsQuerySchema,
  EventIdParamSchema,
  type CreateEventInput,
  type UpdateEventInput,
  type ListEventsQuery,
} from "./events.schema.js";
import type { AppInstance } from "@shared/types/fastify.js";
import { UserRole } from "@identity";

export async function eventsRoutes(app: AppInstance): Promise<void> {
  // All routes require authentication
  app.addHook("onRequest", requireAuth);

  // POST /api/events - Create event
  app.post<{ Body: CreateEventInput }>(
    "/",
    {
      schema: { body: CreateEventSchema },
    },
    async (request, reply) => {
      // Check if user is super_admin or creating event for their own client
      if (!canAccessClient(request.user!, request.body.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to create event for this client",
        );
      }

      const event = await createEvent(request.body, request.user!.id);
      return reply.status(201).send(event);
    },
  );

  // GET /api/events - List events
  app.get<{ Querystring: ListEventsQuery }>(
    "/",
    {
      schema: { querystring: ListEventsQuerySchema },
    },
    async (request, reply) => {
      const query = { ...request.query };

      // Force clientId filter for client_admin users
      if (request.user!.role === UserRole.CLIENT_ADMIN) {
        if (!request.user!.clientId) {
          throw app.httpErrors.badRequest(
            "User is not associated with any client",
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
      schema: { params: EventIdParamSchema },
    },
    async (request, reply) => {
      const event = await getEventById(request.params.id);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      // Check if user is super_admin or accessing their own client's event
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to access this event",
        );
      }

      return reply.send(event);
    },
  );

  // PATCH /api/events/:id - Update event
  app.patch<{ Params: { id: string }; Body: UpdateEventInput }>(
    "/:id",
    {
      schema: { params: EventIdParamSchema, body: UpdateEventSchema },
    },
    async (request, reply) => {
      // Get event to check ownership
      const event = await getEventById(request.params.id);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      // Check if user is super_admin or updating their own client's event
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to update this event",
        );
      }

      const updatedEvent = await updateEvent(
        request.params.id,
        request.body,
        request.user!.id,
      );
      return reply.send(updatedEvent);
    },
  );

  // DELETE /api/events/:id - Delete event
  app.delete<{ Params: { id: string } }>(
    "/:id",
    {
      schema: { params: EventIdParamSchema },
    },
    async (request, reply) => {
      // Get event to check ownership
      const event = await getEventById(request.params.id);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      // Check if user is super_admin or deleting their own client's event
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to delete this event",
        );
      }

      await deleteEvent(request.params.id, request.user!.id);
      return reply.status(204).send();
    },
  );
}
