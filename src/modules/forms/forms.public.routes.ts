import {
  getFormByEventSlug,
  getSponsorFormByEventSlug,
} from "./forms.service.js";
import { EventSlugParamSchema } from "@events";
import type { AppInstance } from "@shared/fastify.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";

export async function formsPublicRoutes(app: AppInstance): Promise<void> {
  // NO auth hook - these routes are public

  // GET /api/forms/public/:slug - Get published form by event slug with event and client info
  app.get<{ Params: { slug: string } }>(
    "/:slug",
    {
      schema: { params: EventSlugParamSchema },
    },
    async (request, reply) => {
      const form = await getFormByEventSlug(request.params.slug);
      if (!form) {
        throw new AppError(
          "Form not found or not published",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      return reply.send(form);
    },
  );

  // GET /api/forms/public/:slug/sponsor - Get sponsor form by event slug
  app.get<{ Params: { slug: string } }>(
    "/:slug/sponsor",
    {
      schema: { params: EventSlugParamSchema },
    },
    async (request, reply) => {
      const form = await getSponsorFormByEventSlug(request.params.slug);
      if (!form) {
        throw new AppError(
          "Sponsor form not found or event not open",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      return reply.send(form);
    },
  );
}
