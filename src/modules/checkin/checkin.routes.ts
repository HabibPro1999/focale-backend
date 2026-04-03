import {
  requireAuth,
  canAccessClient,
} from "@shared/middleware/auth.middleware.js";
import { EventIdParamSchema } from "@events";
import {
  CheckInBodySchema,
  BatchSyncBodySchema,
  CheckInLookupParamSchema,
  type CheckInBody,
  type BatchSyncBody,
  type CheckInLookupParam,
} from "./checkin.schema.js";
import {
  checkIn,
  getRegistrationForCheckIn,
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
        params: EventIdParamSchema,
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

  // GET /:eventId/checkin/registrations - Bulk preload for offline
  app.get<{ Params: { eventId: string } }>(
    "/:eventId/checkin/registrations",
    {
      schema: { params: EventIdParamSchema },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const event = await getEventById(eventId);
      if (!event) throw app.httpErrors.notFound("Event not found");
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const registrations = await getCheckInRegistrations(eventId);
      return reply.send(registrations);
    },
  );

  // GET /:eventId/checkin/stats - Check-in statistics
  app.get<{ Params: { eventId: string } }>(
    "/:eventId/checkin/stats",
    {
      schema: { params: EventIdParamSchema },
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
        params: EventIdParamSchema,
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
  );

  // GET /:eventId/checkin/lookup/:registrationId - Single registration check-in status
  app.get<{ Params: CheckInLookupParam }>(
    "/:eventId/checkin/lookup/:registrationId",
    {
      schema: { params: CheckInLookupParamSchema },
    },
    async (request, reply) => {
      const { eventId, registrationId } = request.params;
      const event = await getEventById(eventId);
      if (!event) throw app.httpErrors.notFound("Event not found");
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const result = await getRegistrationForCheckIn(eventId, registrationId);
      return reply.send(result);
    },
  );
}
