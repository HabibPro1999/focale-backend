import {
  requireAuth,
  canAccessClient,
  requireEventAccess,
} from "@shared/middleware/auth.middleware.js";
import {
  listSponsorships,
  getSponsorshipStats,
  getSponsorshipById,
  updateSponsorship,
  deleteSponsorship,
  getSponsorshipClientId,
} from "./sponsorships.service.js";
import {
  linkSponsorshipToRegistration,
  linkSponsorshipByCode,
  unlinkSponsorshipFromRegistration,
  getAvailableSponsorships,
  getLinkedSponsorships,
  type LinkSponsorshipSkippedResult,
} from "./sponsorships-linking.service.js";
import { getRegistrationById } from "@registrations";
import {
  EventIdParamSchema,
  IdParamSchema,
  RegistrationIdParamSchema,
} from "@shared/schemas/params.js";
import { listQuery } from "@shared/schemas/common.js";
import { SponsorshipStatusSchema } from "./sponsorships.schema.js";
import { z } from "zod";
import type { AppInstance } from "@shared/fastify.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";

// ============================================================================
// Route-local request schemas
// ============================================================================

const ListSponsorshipsQuerySchema = listQuery({
  status: SponsorshipStatusSchema.optional(),
  sortBy: z
    .enum(["createdAt", "totalAmount", "beneficiaryName"])
    .default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

type ListSponsorshipsQuery = z.infer<typeof ListSponsorshipsQuerySchema>;

const UpdateSponsorshipSchema = z
  .object({
    beneficiaryName: z.string().min(2).max(200).optional(),
    beneficiaryEmail: z.string().email().optional(),
    beneficiaryPhone: z.string().max(50).optional().nullable(),
    beneficiaryAddress: z.string().max(500).optional().nullable(),
    coversBasePrice: z.boolean().optional(),
    coveredAccessIds: z.array(z.string().uuid()).optional(),
    status: z.literal("CANCELLED").optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (
        data.coversBasePrice !== undefined &&
        data.coveredAccessIds !== undefined
      ) {
        return data.coversBasePrice || data.coveredAccessIds.length > 0;
      }
      return true;
    },
    { message: "Must cover at least base price or one access item" },
  );

type UpdateSponsorshipInput = z.infer<typeof UpdateSponsorshipSchema>;

const LinkSponsorshipSchema = z
  .object({
    sponsorshipId: z.string().uuid(),
  })
  .strict();

type LinkSponsorshipInput = z.infer<typeof LinkSponsorshipSchema>;

const LinkSponsorshipByCodeSchema = z
  .object({
    code: z
      .string()
      .min(4)
      .max(10)
      .transform((val) => {
        const upper = val.toUpperCase().trim();
        return upper.startsWith("SP-") ? upper : `SP-${upper}`;
      })
      .pipe(
        z
          .string()
          .regex(
            /^SP-[A-HJ-KM-NP-Z2-9]{4}$/,
            "Invalid sponsorship code format",
          ),
      ),
  })
  .strict();

type LinkSponsorshipByCodeInput = z.infer<typeof LinkSponsorshipByCodeSchema>;

const RegistrationSponsorshipParamSchema = z
  .object({
    registrationId: z.string().uuid(),
    sponsorshipId: z.string().uuid(),
  })
  .strict();

// ============================================================================
// Event-scoped Sponsorship Routes (mounted at /api/events)
// ============================================================================

export async function sponsorshipsRoutes(app: AppInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  // GET /api/events/:eventId/sponsorships - List sponsorships for an event
  app.get<{
    Params: { eventId: string };
    Querystring: ListSponsorshipsQuery;
  }>(
    "/:eventId/sponsorships",
    {
      schema: {
        params: EventIdParamSchema,
        querystring: ListSponsorshipsQuerySchema,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const query = request.query;

      await requireEventAccess(request.user!, eventId);

      const sponsorships = await listSponsorships(eventId, query);
      return reply.send(sponsorships);
    },
  );

  // GET /api/events/:eventId/sponsorships/stats - Get sponsorship statistics
  app.get<{ Params: { eventId: string } }>(
    "/:eventId/sponsorships/stats",
    {
      schema: {
        params: EventIdParamSchema,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;

      await requireEventAccess(request.user!, eventId);

      const stats = await getSponsorshipStats(eventId);
      return reply.send(stats);
    },
  );
}

// ============================================================================
// Sponsorship Detail Routes (mounted at /api/sponsorships)
// ============================================================================

export async function sponsorshipDetailRoutes(app: AppInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  // GET /api/sponsorships/:id - Get sponsorship detail
  app.get<{ Params: { id: string } }>(
    "/:id",
    {
      schema: { params: IdParamSchema },
    },
    async (request, reply) => {
      const { id } = request.params;

      const sponsorship = await getSponsorshipById(id);
      if (!sponsorship) {
        throw new AppError(
          "Sponsorship not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      const clientId = await getSponsorshipClientId(id);
      if (clientId && !canAccessClient(request.user!, clientId)) {
        throw new AppError(
          "Insufficient permissions",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      return reply.send(sponsorship);
    },
  );

  // PATCH /api/sponsorships/:id - Update sponsorship
  app.patch<{ Params: { id: string }; Body: UpdateSponsorshipInput }>(
    "/:id",
    {
      schema: {
        params: IdParamSchema,
        body: UpdateSponsorshipSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const input = request.body;

      const clientId = await getSponsorshipClientId(id);
      if (!clientId) {
        throw new AppError(
          "Sponsorship not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (!canAccessClient(request.user!, clientId)) {
        throw new AppError(
          "Insufficient permissions",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      const sponsorship = await updateSponsorship(id, input, request.user!.id);
      return reply.send(sponsorship);
    },
  );

  // DELETE /api/sponsorships/:id - Delete sponsorship
  app.delete<{ Params: { id: string } }>(
    "/:id",
    {
      schema: { params: IdParamSchema },
    },
    async (request, reply) => {
      const { id } = request.params;

      const clientId = await getSponsorshipClientId(id);
      if (!clientId) {
        throw new AppError(
          "Sponsorship not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (!canAccessClient(request.user!, clientId)) {
        throw new AppError(
          "Insufficient permissions",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      await deleteSponsorship(id, request.user!.id);
      return reply.send({ success: true });
    },
  );
}

// ============================================================================
// Registration-Sponsorship Routes (Authenticated)
// ============================================================================

export async function registrationSponsorshipsRoutes(
  app: AppInstance,
): Promise<void> {
  app.addHook("onRequest", requireAuth);

  // GET /api/registrations/:registrationId/available-sponsorships
  app.get<{ Params: { registrationId: string } }>(
    "/:registrationId/available-sponsorships",
    {
      schema: { params: RegistrationIdParamSchema },
    },
    async (request, reply) => {
      const { registrationId } = request.params;

      const registration = await getRegistrationById(registrationId);
      if (!registration) {
        throw new AppError(
          "Registration not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (!canAccessClient(request.user!, registration.event.clientId)) {
        throw new AppError(
          "Insufficient permissions",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      const sponsorships = await getAvailableSponsorships(
        registration.event.id,
        registrationId,
      );
      return reply.send({ sponsorships });
    },
  );

  // GET /api/registrations/:registrationId/sponsorships - Get linked sponsorships
  app.get<{ Params: { registrationId: string } }>(
    "/:registrationId/sponsorships",
    {
      schema: { params: RegistrationIdParamSchema },
    },
    async (request, reply) => {
      const { registrationId } = request.params;

      const registration = await getRegistrationById(registrationId);
      if (!registration) {
        throw new AppError(
          "Registration not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (!canAccessClient(request.user!, registration.event.clientId)) {
        throw new AppError(
          "Insufficient permissions",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      const linkedSponsorships = await getLinkedSponsorships(registrationId);
      return reply.send(linkedSponsorships);
    },
  );

  // POST /api/registrations/:registrationId/sponsorships - Link by ID
  app.post<{ Params: { registrationId: string }; Body: LinkSponsorshipInput }>(
    "/:registrationId/sponsorships",
    {
      schema: {
        params: RegistrationIdParamSchema,
        body: LinkSponsorshipSchema,
      },
    },
    async (request, reply) => {
      const { registrationId } = request.params;
      const { sponsorshipId } = request.body;

      const registration = await getRegistrationById(registrationId);
      if (!registration) {
        throw new AppError(
          "Registration not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (!canAccessClient(request.user!, registration.event.clientId)) {
        throw new AppError(
          "Insufficient permissions",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      const result = await linkSponsorshipToRegistration(
        sponsorshipId,
        registrationId,
        request.user!.id,
      );

      if ((result as LinkSponsorshipSkippedResult).skipped) {
        return reply.status(200).send({ success: false, ...result });
      }

      return reply.status(201).send({ success: true, ...result });
    },
  );

  // POST /api/registrations/:registrationId/sponsorships/by-code - Link by code
  app.post<{
    Params: { registrationId: string };
    Body: LinkSponsorshipByCodeInput;
  }>(
    "/:registrationId/sponsorships/by-code",
    {
      schema: {
        params: RegistrationIdParamSchema,
        body: LinkSponsorshipByCodeSchema,
      },
    },
    async (request, reply) => {
      const { registrationId } = request.params;
      const { code } = request.body;

      const registration = await getRegistrationById(registrationId);
      if (!registration) {
        throw new AppError(
          "Registration not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (!canAccessClient(request.user!, registration.event.clientId)) {
        throw new AppError(
          "Insufficient permissions",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      const result = await linkSponsorshipByCode(
        registrationId,
        code,
        request.user!.id,
      );

      if ((result as LinkSponsorshipSkippedResult).skipped) {
        return reply.status(200).send({ success: false, ...result });
      }

      return reply.status(201).send({ success: true, ...result });
    },
  );

  // DELETE /api/registrations/:registrationId/sponsorships/:sponsorshipId - Unlink
  app.delete<{ Params: { registrationId: string; sponsorshipId: string } }>(
    "/:registrationId/sponsorships/:sponsorshipId",
    {
      schema: { params: RegistrationSponsorshipParamSchema },
    },
    async (request, reply) => {
      const { registrationId, sponsorshipId } = request.params;

      const registration = await getRegistrationById(registrationId);
      if (!registration) {
        throw new AppError(
          "Registration not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (!canAccessClient(request.user!, registration.event.clientId)) {
        throw new AppError(
          "Insufficient permissions",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      await unlinkSponsorshipFromRegistration(sponsorshipId, registrationId);
      return reply.send({ success: true });
    },
  );
}
