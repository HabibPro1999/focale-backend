import { getEventById, getEventBySlug } from "@events";
import { searchRegistrantsForSponsorship } from "@registrations";
import { createSponsorshipBatch } from "./sponsorships-batch.service.js";
import {
  CreateSponsorshipBatchSchema,
  type CreateSponsorshipBatchInput,
  RegistrantSearchQuerySchema,
  FormSponsorshipModeSchema,
} from "./sponsorships.schema.js";
import { EventIdParamSchema } from "@shared/schemas/params.js";
import { z } from "zod";
import type { AppInstance } from "@shared/fastify.js";
import { prisma } from "@/database/client.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";

// ============================================================================
// Route-local request schemas
// ============================================================================

const EventSlugParamSchema = z
  .object({
    slug: z.string().min(1).max(100),
  })
  .strict();

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
        throw new AppError("Event not found", 404, true, ErrorCodes.NOT_FOUND);
      }

      if (event.status !== "OPEN") {
        throw new AppError(
          "Event is not accepting sponsorship submissions",
          400,
          true,
          ErrorCodes.EVENT_NOT_OPEN,
        );
      }

      // Get the sponsor form for this event
      const form = await getSponsorFormForEvent(eventId);
      if (!form) {
        throw new AppError(
          "Sponsor form not found for this event",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      // Validate that payload shape matches the form's configured sponsorship mode
      validatePayloadMatchesMode(form.schema, input);

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
        throw new AppError("Event not found", 404, true, ErrorCodes.NOT_FOUND);
      }

      // Verify sponsor form exists and uses LINKED_ACCOUNT mode
      const form = await getSponsorFormForEvent(event.id);
      if (!form) {
        throw new AppError(
          "Sponsor form not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      // Check sponsorship mode (security check to prevent unauthorized searches)
      const parseResult = FormSponsorshipModeSchema.safeParse(form.schema);
      if (
        !parseResult.success ||
        parseResult.data?.sponsorshipSettings?.sponsorshipMode !==
          "LINKED_ACCOUNT"
      ) {
        throw new AppError(
          "Search not available for this form",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      const sponsorshipSettings = parseResult.data.sponsorshipSettings;

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

      return reply.send(
        results.map(({ id, email, firstName, lastName, accessTypeIds }) => ({
          id,
          email,
          firstName,
          lastName,
          accessTypeIds,
        })),
      );
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
        throw new AppError("Event not found", 404, true, ErrorCodes.NOT_FOUND);
      }

      if (event.status !== "OPEN") {
        throw new AppError(
          "Event is not accepting sponsorship submissions",
          400,
          true,
          ErrorCodes.EVENT_NOT_OPEN,
        );
      }

      // Get the sponsor form for this event
      const form = await getSponsorFormForEvent(event.id);
      if (!form) {
        throw new AppError(
          "Sponsor form not found for this event",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      // Validate that payload shape matches the form's configured sponsorship mode
      validatePayloadMatchesMode(form.schema, input);

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

/**
 * Validate that the batch input shape matches the form's configured sponsorship mode.
 * Throws if CODE mode receives linkedBeneficiaries or LINKED_ACCOUNT mode receives beneficiaries.
 */
function validatePayloadMatchesMode(
  formSchema: unknown,
  input: CreateSponsorshipBatchInput,
): void {
  const parsed = FormSponsorshipModeSchema.safeParse(formSchema);
  const mode = parsed.data?.sponsorshipSettings?.sponsorshipMode;
  if (mode === "CODE" && (input.linkedBeneficiaries?.length ?? 0) > 0) {
    throw new AppError(
      "This form uses CODE mode: provide beneficiaries, not linkedBeneficiaries",
      400,
      true,
      ErrorCodes.VALIDATION_ERROR,
    );
  }
  if (mode === "LINKED_ACCOUNT" && (input.beneficiaries?.length ?? 0) > 0) {
    throw new AppError(
      "This form uses LINKED_ACCOUNT mode: provide linkedBeneficiaries, not beneficiaries",
      400,
      true,
      ErrorCodes.VALIDATION_ERROR,
    );
  }
}

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
