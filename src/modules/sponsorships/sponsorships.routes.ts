import {
  requireAuth,
  canAccessClient,
} from "@shared/middleware/auth.middleware.js";
import { requireEventAccess } from "@shared/middleware/access-control.js";
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
  SponsorshipIdParamSchema,
  RegistrationIdParamSchema,
  RegistrationSponsorshipParamSchema,
  ListSponsorshipsQuerySchema,
  UpdateSponsorshipSchema,
  LinkSponsorshipSchema,
  LinkSponsorshipByCodeSchema,
  type ListSponsorshipsQuery,
  type UpdateSponsorshipInput,
  type LinkSponsorshipInput,
  type LinkSponsorshipByCodeInput,
} from "./sponsorships.schema.js";
import type { AppInstance } from "@shared/types/fastify.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";

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
      schema: { params: SponsorshipIdParamSchema },
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
        params: SponsorshipIdParamSchema,
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
      schema: { params: SponsorshipIdParamSchema },
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
