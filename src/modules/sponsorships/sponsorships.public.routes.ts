import { getEventById, getEventBySlug } from "@events";
import { searchRegistrantsForSponsorship } from "@registrations";
import { createSponsorshipBatch } from "./sponsorships.service.js";
import {
  CreateSponsorshipBatchSchema,
  EventIdParamSchema,
  type CreateSponsorshipBatchInput,
} from "./sponsorships.schema.js";
import { z } from "zod";
import type { AppInstance } from "@shared/types/fastify.js";

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

const EventSlugParamSchema = z
  .object({
    slug: z.string().min(1).max(100),
  })
  .strict();

const RegistrantSearchQuerySchema = z
  .object({
    query: z.string().min(1).max(200),
    unpaidOnly: z.string().optional(),
  })
  .strict();

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

      // Server-side enforcement: override unpaidOnly based on registrantSearchScope
      const registrantSearchScope = sponsorshipSettings?.registrantSearchScope;
      const enforceUnpaidOnly =
        registrantSearchScope === "UNPAID_ONLY" ? true : unpaidOnly === "true";

      // Use existing search function
      const results = await searchRegistrantsForSponsorship(event.id, {
        query,
        unpaidOnly: enforceUnpaidOnly,
        limit: 10,
      });

      return reply.send(results);
    },
  );

  // POST /api/public/events/slug/:slug/sponsorships - Submit sponsor form by slug
  app.post<{
    Params: { slug: string };
    Body: CreateSponsorshipBatchInput;
  }>(
    "/slug/:slug/sponsorships",
    {
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
