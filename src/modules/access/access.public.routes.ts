import {
  getGroupedAccess,
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
}
