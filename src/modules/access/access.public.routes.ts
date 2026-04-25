import { z } from "zod";
import { assertClientModuleEnabled } from "@clients";
import { assertEventOpen, getEventById } from "@events";
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

type PublicAccessItem = NonNullable<
  Awaited<ReturnType<typeof getEventAccessById>>
>;

function hasAccessConditions(item: PublicAccessItem): boolean {
  if (Array.isArray(item.conditions)) {
    return item.conditions.length > 0;
  }
  return item.conditions !== null;
}

function isPublicVisibleAccess(
  item: PublicAccessItem,
  eventId: string,
  now: Date,
): boolean {
  if (item.eventId !== eventId || !item.active) return false;
  if (item.availableFrom && item.availableFrom > now) return false;
  if (item.availableTo && item.availableTo < now) return false;
  if (hasAccessConditions(item)) return false;
  return true;
}

// ============================================================================
// Public Routes (No Auth)
// ============================================================================

export async function accessPublicRoutes(app: AppInstance): Promise<void> {
  async function assertPublicAccessEnabled(eventId: string): Promise<void> {
    const event = await getEventById(eventId);
    if (!event) {
      throw app.httpErrors.notFound("Event not found");
    }
    assertEventOpen(event);
    await assertClientModuleEnabled(event.clientId, "registrations");
  }

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

      await assertPublicAccessEnabled(eventId);
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

      await assertPublicAccessEnabled(eventId);
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
      config: { rateLimit: publicRateLimits.accessPublic },
      schema: { params: EventIdParamSchema },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      await assertPublicAccessEnabled(eventId);
      const now = new Date();
      const items = await listEventAccess(eventId, { active: true });
      return reply.send(
        items.filter((item) => isPublicVisibleAccess(item, eventId, now)),
      );
    },
  );

  // GET /:eventId/access/:accessId - Get single access item
  app.get<{ Params: { eventId: string; accessId: string } }>(
    "/:eventId/access/:accessId",
    {
      config: { rateLimit: publicRateLimits.accessPublic },
      schema: {
        params: z.strictObject({
          eventId: z.string().uuid(),
          accessId: z.string().uuid(),
        }),
      },
    },
    async (request, reply) => {
      const { eventId, accessId } = request.params;
      await assertPublicAccessEnabled(eventId);
      const now = new Date();
      const item = await getEventAccessById(accessId);
      if (!item || !isPublicVisibleAccess(item, eventId, now)) {
        throw app.httpErrors.notFound("Access item not found");
      }
      return reply.send(item);
    },
  );
}
