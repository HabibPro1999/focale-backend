import { z } from "zod";
import {
  getGroupedAccess,
  getEventAccessById,
  listEventAccess,
  validateAccessSelections,
} from "./access.service.js";
import {
  EventIdParamSchema,
  GetGroupedAccessBodySchema,
  ValidateAccessSelectionsBodySchema,
  type GetGroupedAccessBody,
  type ValidateAccessSelectionsBody,
} from "./access.schema.js";
import type { AppInstance } from "@shared/types/fastify.js";
import { publicRateLimits } from "@core/plugins.js";

// ============================================================================
// Public Routes (No Auth)
// ============================================================================

export async function accessPublicRoutes(app: AppInstance): Promise<void> {
  // POST /api/public/events/:eventId/access/grouped - Get grouped access items
  // Using POST because we need to send formData and selectedAccessIds in the body
  app.post<{
    Params: { eventId: string };
    Body: GetGroupedAccessBody;
  }>(
    "/:eventId/access/grouped",
    {
      config: { rateLimit: publicRateLimits.accessPublic },
      schema: {
        params: EventIdParamSchema,
        body: GetGroupedAccessBodySchema,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const { formData, selectedAccessIds } = request.body;

      const grouped = await getGroupedAccess(
        eventId,
        formData,
        selectedAccessIds,
      );
      return reply.send(grouped);
    },
  );

  // POST /api/public/events/:eventId/access/validate - Validate selections
  app.post<{
    Params: { eventId: string };
    Body: ValidateAccessSelectionsBody;
  }>(
    "/:eventId/access/validate",
    {
      config: { rateLimit: publicRateLimits.accessPublic },
      schema: {
        params: EventIdParamSchema,
        body: ValidateAccessSelectionsBodySchema,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const { formData, selections } = request.body;

      const result = await validateAccessSelections(
        eventId,
        selections,
        formData,
      );
      return reply.send(result);
    },
  );

  // GET /:eventId/access - List active access items (flat, for registration edit flow)
  app.get<{ Params: { eventId: string } }>(
    "/:eventId/access",
    {
      schema: { params: EventIdParamSchema },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const items = await listEventAccess(eventId, { active: true });
      return reply.send(items);
    },
  );

  // GET /:eventId/access/:accessId - Get single access item
  app.get<{ Params: { eventId: string; accessId: string } }>(
    "/:eventId/access/:accessId",
    {
      schema: {
        params: z.strictObject({
          eventId: z.string().uuid(),
          accessId: z.string().uuid(),
        }),
      },
    },
    async (request, reply) => {
      const { eventId, accessId } = request.params;
      const item = await getEventAccessById(accessId);
      if (!item || item.eventId !== eventId) {
        throw app.httpErrors.notFound("Access item not found");
      }
      return reply.send(item);
    },
  );
}
