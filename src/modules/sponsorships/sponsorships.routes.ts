import {
  requireAuth,
  canAccessClient,
} from "@shared/middleware/auth.middleware.js";
import { getEventById } from "@events";
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

      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

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

      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

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
        throw app.httpErrors.notFound("Sponsorship not found");
      }

      const clientId = await getSponsorshipClientId(id);
      if (clientId && !canAccessClient(request.user!, clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
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
        throw app.httpErrors.notFound("Sponsorship not found");
      }

      if (!canAccessClient(request.user!, clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
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
        throw app.httpErrors.notFound("Sponsorship not found");
      }

      if (!canAccessClient(request.user!, clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
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
        throw app.httpErrors.notFound("Registration not found");
      }

      if (!canAccessClient(request.user!, registration.event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
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
        throw app.httpErrors.notFound("Registration not found");
      }

      if (!canAccessClient(request.user!, registration.event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
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
        throw app.httpErrors.notFound("Registration not found");
      }

      if (!canAccessClient(request.user!, registration.event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const result = await linkSponsorshipToRegistration(
        sponsorshipId,
        registrationId,
        request.user!.id,
      );

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
        throw app.httpErrors.notFound("Registration not found");
      }

      if (!canAccessClient(request.user!, registration.event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const result = await linkSponsorshipByCode(
        registrationId,
        code,
        request.user!.id,
      );

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
        throw app.httpErrors.notFound("Registration not found");
      }

      if (!canAccessClient(request.user!, registration.event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      await unlinkSponsorshipFromRegistration(sponsorshipId, registrationId);
      return reply.send({ success: true });
    },
  );
}
