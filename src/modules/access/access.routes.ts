import { requireAuth, canAccessClient } from '@shared/middleware/auth.middleware.js';
import { getEventById } from '@events';
import {
  createEventAccess,
  updateEventAccess,
  deleteEventAccess,
  listEventAccess,
  getEventAccessById,
  getAccessClientId,
  reorderAccessItems,
} from './access.service.js';
import {
  CreateEventAccessSchema,
  UpdateEventAccessSchema,
  ListEventAccessQuerySchema,
  EventAccessIdParamSchema,
  EventIdParamSchema,
  ReorderAccessItemsSchema,
  type CreateEventAccessInput,
  type UpdateEventAccessInput,
  type ReorderAccessItemsInput,
} from './access.schema.js';
import type { AppInstance } from '@shared/types/fastify.js';

// ============================================================================
// Protected Routes (Admin)
// ============================================================================

export async function accessRoutes(app: AppInstance): Promise<void> {
  app.addHook('onRequest', requireAuth);

  // POST /api/events/:eventId/access - Create access item
  app.post<{
    Params: { eventId: string };
    Body: Omit<CreateEventAccessInput, 'eventId'>;
  }>(
    '/:eventId/access',
    {
      schema: {
        params: EventIdParamSchema,
        body: CreateEventAccessSchema.omit({ eventId: true }),
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const input: CreateEventAccessInput = { ...request.body, eventId };

      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound('Event not found');
      }

      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden('Insufficient permissions');
      }

      const access = await createEventAccess(input);
      return reply.status(201).send(access);
    }
  );

  // GET /api/events/:eventId/access - List access items
  app.get<{
    Params: { eventId: string };
    Querystring: { active?: boolean; type?: string };
  }>(
    '/:eventId/access',
    {
      schema: {
        params: EventIdParamSchema,
        querystring: ListEventAccessQuerySchema,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const query = request.query;

      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound('Event not found');
      }

      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden('Insufficient permissions');
      }

      const access = await listEventAccess(eventId, {
        active: query.active,
        type: query.type,
      });
      return reply.send(access);
    }
  );

  // GET /api/access/:id - Get single access item
  app.get<{ Params: { id: string } }>(
    '/access/:id',
    {
      schema: { params: EventAccessIdParamSchema },
    },
    async (request, reply) => {
      const { id } = request.params;

      const access = await getEventAccessById(id);
      if (!access) {
        throw app.httpErrors.notFound('Access item not found');
      }

      const clientId = await getAccessClientId(id);
      if (clientId && !canAccessClient(request.user!, clientId)) {
        throw app.httpErrors.forbidden('Insufficient permissions');
      }

      return reply.send(access);
    }
  );

  // PATCH /api/access/:id - Update access item
  app.patch<{ Params: { id: string }; Body: UpdateEventAccessInput }>(
    '/access/:id',
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
        throw app.httpErrors.notFound('Access item not found');
      }

      const event = await getEventById(access.eventId);
      if (!event) {
        throw app.httpErrors.notFound('Event not found');
      }

      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden('Insufficient permissions');
      }

      const updatedAccess = await updateEventAccess(id, input);
      return reply.send(updatedAccess);
    }
  );

  // DELETE /api/access/:id - Delete access item
  app.delete<{ Params: { id: string } }>(
    '/access/:id',
    {
      schema: { params: EventAccessIdParamSchema },
    },
    async (request, reply) => {
      const { id } = request.params;

      const access = await getEventAccessById(id);
      if (!access) {
        throw app.httpErrors.notFound('Access item not found');
      }

      const event = await getEventById(access.eventId);
      if (!event) {
        throw app.httpErrors.notFound('Event not found');
      }

      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden('Insufficient permissions');
      }

      await deleteEventAccess(id);
      return reply.status(204).send();
    }
  );

  // PATCH /api/events/:eventId/access/reorder - Bulk reorder free-position items
  app.patch<{ Params: { eventId: string }; Body: ReorderAccessItemsInput }>(
    '/:eventId/access/reorder',
    {
      schema: {
        params: EventIdParamSchema,
        body: ReorderAccessItemsSchema,
      },
    },
    async (request, reply) => {
      const result = await reorderAccessItems(request.params.eventId, request.body.ids);
      return reply.status(200).send({ data: result });
    }
  );
}
