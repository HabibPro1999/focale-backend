import { z } from "zod";
import {
  getGroupedAccess,
  validateAccessSelections,
} from "./access.service.js";
import { AccessSelectionSchema } from "./access.schema.js";
import { EventIdParamSchema } from "@shared/schemas/params.js";
import type { AppInstance } from "@shared/fastify.js";

// ============================================================================
// Inline Request Schemas
// ============================================================================

const getGroupedAccessBody = z
  .object({
    formData: z.record(z.string(), z.any()).optional().default({}),
    selectedAccessIds: z.array(z.string().uuid()).optional().default([]),
  })
  .strict();

const validateAccessSelectionsBody = z
  .object({
    formData: z.record(z.string(), z.any()),
    selections: z.array(AccessSelectionSchema),
  })
  .strict();

// ============================================================================
// Public Routes (No Auth)
// ============================================================================

export async function accessPublicRoutes(app: AppInstance): Promise<void> {
  // POST /api/public/events/:eventId/access/grouped - Get grouped access items
  // Using POST because we need to send formData and selectedAccessIds in the body
  app.post<{
    Params: z.infer<typeof EventIdParamSchema>;
    Body: z.infer<typeof getGroupedAccessBody>;
  }>(
    "/:eventId/access/grouped",
    {
      schema: {
        params: EventIdParamSchema,
        body: getGroupedAccessBody,
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
    Params: z.infer<typeof EventIdParamSchema>;
    Body: z.infer<typeof validateAccessSelectionsBody>;
  }>(
    "/:eventId/access/validate",
    {
      schema: {
        params: EventIdParamSchema,
        body: validateAccessSelectionsBody,
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
