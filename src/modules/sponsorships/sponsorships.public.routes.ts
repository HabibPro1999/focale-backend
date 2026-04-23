import { getEventById, getEventBySlug } from "@events";
import { assertClientModuleEnabled } from "@clients";
import { searchRegistrantsForSponsorship } from "@registrations";
import { createSponsorshipBatch } from "./sponsorships.service.js";
import {
  CreateSponsorshipBatchSchema,
  EventIdParamSchema,
  type CreateSponsorshipBatchInput,
} from "./sponsorships.schema.js";
import { z } from "zod";
import type { AppInstance } from "@shared/types/fastify.js";
import { publicRateLimits } from "@core/plugins.js";

// ============================================================================
// Public Routes (No Auth - for sponsor form submission)
// ============================================================================

export async function sponsorshipsPublicRoutes(
  app: AppInstance,
): Promise<void> {
  // POST /api/public/events/:eventId/sponsorships - Submit sponsor form
  app.post<{
    Params: { eventId: string };
    Body: CreateSponsorshipBatchInput;
  }>(
    "/:eventId/sponsorships",
    {
      config: {
        rateLimit: publicRateLimits.registration,
      },
      schema: {
        params: EventIdParamSchema,
        body: CreateSponsorshipBatchSchema,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const input = request.body;

      // Verify event exists and is open
      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      if (event.status !== "OPEN") {
        throw app.httpErrors.badRequest(
          "Event is not accepting sponsorship submissions",
        );
      }
      await assertClientModuleEnabled(event.clientId, "sponsorships");

      // Get the sponsor form for this event
      const form = await getSponsorFormForEvent(eventId);
      if (!form) {
        throw app.httpErrors.notFound("Sponsor form not found for this event");
      }

      // Create the sponsorship batch
      const result = await createSponsorshipBatch(eventId, form.id, input);

      return reply.status(201).send({
        success: true,
        message: `${result.count} sponsoring(s) created successfully`,
        batchId: result.batchId,
        count: result.count,
      });
    },
  );
}

// ============================================================================
// Public Routes by Slug (for pure-form frontend)
// ============================================================================

const EventSlugParamSchema = z.strictObject({
  slug: z.string().min(1).max(100),
});

const RegistrantSearchQuerySchema = z.strictObject({
  query: z.string().trim().min(2).max(200),
  unpaidOnly: z.string().optional(),
});

export async function sponsorshipsPublicBySlugRoutes(
  app: AppInstance,
): Promise<void> {
  // GET /api/public/events/slug/:slug/registrants/search - Search registrants for LINKED_ACCOUNT sponsorship
  app.get<{
    Params: { slug: string };
    Querystring: { query: string; unpaidOnly?: string };
  }>(
    "/slug/:slug/registrants/search",
    {
      config: {
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      schema: {
        params: EventSlugParamSchema,
        querystring: RegistrantSearchQuerySchema,
      },
    },
    async (request, reply) => {
      const { slug } = request.params;
      const { query, unpaidOnly } = request.query;

      // Get event by slug
      const event = await getEventBySlug(slug);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }
      if (event.status !== "OPEN") {
        throw app.httpErrors.badRequest("Event is not accepting sponsorships");
      }
      await assertClientModuleEnabled(event.clientId, "sponsorships");

      // Verify sponsor form exists and uses LINKED_ACCOUNT mode
      const form = await getSponsorFormForEvent(event.id);
      if (!form) {
        throw app.httpErrors.notFound("Sponsor form not found");
      }

      // Check sponsorship mode (security check to prevent unauthorized searches)
      const schema = form.schema as Record<string, unknown> | null;
      const sponsorshipSettings = schema?.sponsorshipSettings as
        | Record<string, unknown>
        | undefined;
      if (sponsorshipSettings?.sponsorshipMode !== "LINKED_ACCOUNT") {
        throw app.httpErrors.forbidden("Search not available for this form");
      }

      // Enforce registrantSearchScope from form settings (server-side)
      const registrantSearchScope =
        (sponsorshipSettings?.registrantSearchScope as string | undefined) ??
        "ALL";
      const effectiveUnpaidOnly =
        registrantSearchScope === "UNPAID_ONLY" ? true : unpaidOnly === "true";

      const results = await searchRegistrantsForSponsorship(event.id, {
        query,
        unpaidOnly: effectiveUnpaidOnly,
        limit: 10,
      });

      const sanitizedResults = results.map(
        ({
          phone: _phone,
          formData: _formData,
          ...safe
        }: Record<string, unknown>) => safe,
      );

      return reply.send(sanitizedResults);
    },
  );

  // POST /api/public/events/slug/:slug/sponsorships - Submit sponsor form by slug
  app.post<{
    Params: { slug: string };
    Body: CreateSponsorshipBatchInput;
  }>(
    "/slug/:slug/sponsorships",
    {
      config: {
        rateLimit: publicRateLimits.registration,
      },
      schema: {
        params: EventSlugParamSchema,
        body: CreateSponsorshipBatchSchema,
      },
    },
    async (request, reply) => {
      const { slug } = request.params;
      const input = request.body;

      // Get event by slug
      const event = await getEventBySlug(slug);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      if (event.status !== "OPEN") {
        throw app.httpErrors.badRequest(
          "Event is not accepting sponsorship submissions",
        );
      }
      await assertClientModuleEnabled(event.clientId, "sponsorships");

      // Get the sponsor form for this event
      const form = await getSponsorFormForEvent(event.id);
      if (!form) {
        throw app.httpErrors.notFound("Sponsor form not found for this event");
      }

      // Create the sponsorship batch
      const result = await createSponsorshipBatch(event.id, form.id, input);

      return reply.status(201).send({
        success: true,
        message: `${result.count} sponsoring(s) created successfully`,
        batchId: result.batchId,
        count: result.count,
      });
    },
  );
}

// ============================================================================
// Helper Functions
// ============================================================================

import { prisma } from "@/database/client.js";

/**
 * Get the sponsor form for an event.
 */
async function getSponsorFormForEvent(
  eventId: string,
): Promise<{ id: string; eventId: string; schema: unknown } | null> {
  return prisma.form.findFirst({
    where: {
      eventId,
      type: "SPONSOR",
      active: true,
    },
    select: {
      id: true,
      eventId: true,
      schema: true,
    },
  });
}
