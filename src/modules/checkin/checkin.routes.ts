import {
  requireAuth,
  canAccessClient,
} from "@shared/middleware/auth.middleware.js";
import {
  CheckInBodySchema,
  CheckInEventParamSchema,
  BatchSyncBodySchema,
  CheckInRegistrationsQuerySchema,
  type CheckInBody,
  type BatchSyncBody,
  type CheckInRegistrationsQuery,
} from "./checkin.schema.js";
import {
  checkIn,
  getCheckInRegistrations,
  batchSync,
  getCheckInStats,
} from "./checkin.service.js";
import { getEventById } from "@events";
import type { AppInstance } from "@shared/types/fastify.js";

export async function checkinRoutes(app: AppInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  // POST /:eventId/checkin - Check in a registration (event or access level)
  app.post<{ Params: { eventId: string }; Body: CheckInBody }>(
    "/:eventId/checkin",
    {
      schema: {
        params: CheckInEventParamSchema,
        body: CheckInBodySchema,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const event = await getEventById(eventId);
      if (!event) throw app.httpErrors.notFound("Event not found");
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const result = await checkIn(
        eventId,
        request.body.registrationId,
        request.body.accessId,
        request.user!.id,
      );
      return reply.send(result);
    },
  );

  // GET /:eventId/checkin/registrations - Eligible registration IDs for scanner preload
  app.get<{ Params: { eventId: string }; Querystring: CheckInRegistrationsQuery }>(
    "/:eventId/checkin/registrations",
    {
      schema: {
        params: CheckInEventParamSchema,
        querystring: CheckInRegistrationsQuerySchema,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const { accessId } = request.query;
      const event = await getEventById(eventId);
      if (!event) throw app.httpErrors.notFound("Event not found");
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const ids = await getCheckInRegistrations(eventId, accessId);
      return reply.send(ids);
    },
  );

  // GET /:eventId/checkin/stats - Check-in statistics
  app.get<{ Params: { eventId: string } }>(
    "/:eventId/checkin/stats",
    {
      schema: { params: CheckInEventParamSchema },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const event = await getEventById(eventId);
      if (!event) throw app.httpErrors.notFound("Event not found");
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const stats = await getCheckInStats(eventId);
      return reply.send(stats);
    },
  );

  // POST /:eventId/checkin/sync - Batch sync offline check-ins
  app.post<{ Params: { eventId: string }; Body: BatchSyncBody }>(
    "/:eventId/checkin/sync",
    {
      schema: {
        params: CheckInEventParamSchema,
        body: BatchSyncBodySchema,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const event = await getEventById(eventId);
      if (!event) throw app.httpErrors.notFound("Event not found");
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const result = await batchSync(
        eventId,
        request.body.checkIns,
        request.user!.id,
      );
      return reply.send(result);
    },
  );}
