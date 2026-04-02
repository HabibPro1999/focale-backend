import {
  requireAuth,
  canAccessClient,
} from "@shared/middleware/auth.middleware.js";
import { getEventById } from "@events";
import {
  getRegistrationById,
  updateRegistration,
  adminEditRegistration,
  confirmPayment,
  deleteRegistration,
  listRegistrations,
  getRegistrationClientId,
  getRegistrationTableColumns,
  listRegistrationAuditLogs,
  listRegistrationEmailLogs,
  searchRegistrantsForSponsorship,
  extractKeyFromUrl,
  createAdminRegistration,
} from "./registrations.service.js";
import { getStorageProvider } from "@shared/services/storage/index.js";
import { AppError } from "@shared/errors/app-error.js";
import { ErrorCodes } from "@shared/errors/error-codes.js";
import {
  RegistrationIdParamSchema,
  EventIdParamSchema,
  UpdateRegistrationSchema,
  UpdatePaymentSchema,
  ListRegistrationsQuerySchema,
  ListRegistrationAuditLogsQuerySchema,
  ListRegistrationEmailLogsQuerySchema,
  SearchRegistrantsQuerySchema,
  DeleteRegistrationQuerySchema,
  AdminCreateRegistrationSchema,
  AdminEditRegistrationSchema,
  type UpdateRegistrationInput,
  type UpdatePaymentInput,
  type ListRegistrationsQuery,
  type ListRegistrationAuditLogsQuery,
  type ListRegistrationEmailLogsQuery,
  type SearchRegistrantsQuery,
  type DeleteRegistrationQuery,
  type AdminCreateRegistrationInput,
  type AdminEditRegistrationInput,
} from "./registrations.schema.js";
import type { AppInstance } from "@shared/types/fastify.js";

// ============================================================================
// Protected Routes (Admin)
// ============================================================================

export async function registrationsRoutes(app: AppInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  // GET /api/events/:eventId/registrations/columns - Get table column definitions
  app.get<{
    Params: { eventId: string };
  }>(
    "/:eventId/registrations/columns",
    {
      schema: { params: EventIdParamSchema },
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

      const columns = await getRegistrationTableColumns(eventId);
      return reply.send(columns);
    },
  );

  // GET /api/events/:eventId/registrants/search - Search registrants for sponsorship linking
  app.get<{
    Params: { eventId: string };
    Querystring: SearchRegistrantsQuery;
  }>(
    "/:eventId/registrants/search",
    {
      schema: {
        params: EventIdParamSchema,
        querystring: SearchRegistrantsQuerySchema,
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

      const results = await searchRegistrantsForSponsorship(eventId, query);
      return reply.send(results);
    },
  );

  // POST /api/events/:eventId/admin/registrations - Admin creates a registration
  app.post<{
    Params: { eventId: string };
    Body: AdminCreateRegistrationInput;
  }>(
    "/:eventId/admin/registrations",
    {
      schema: {
        params: EventIdParamSchema,
        body: AdminCreateRegistrationSchema,
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

      const registration = await createAdminRegistration(
        eventId,
        request.body,
        request.user!.id,
      );

      return reply.status(201).send(registration);
    },
  );

  // PUT /api/events/:eventId/registrations/:id/admin-edit - Admin full edit
  app.put<{
    Params: { eventId: string; id: string };
    Body: AdminEditRegistrationInput;
  }>(
    "/:eventId/registrations/:id/admin-edit",
    {
      schema: {
        params: EventIdParamSchema.extend(RegistrationIdParamSchema.shape),
        body: AdminEditRegistrationSchema,
      },
    },
    async (request, reply) => {
      const { eventId, id } = request.params;

      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const registration = await adminEditRegistration(
        eventId,
        id,
        request.body,
        request.user!.id,
      );

      return reply.send(registration);
    },
  );

  // GET /api/events/:eventId/registrations - List registrations for an event
  app.get<{
    Params: { eventId: string };
    Querystring: ListRegistrationsQuery;
  }>(
    "/:eventId/registrations",
    {
      schema: {
        params: EventIdParamSchema,
        querystring: ListRegistrationsQuerySchema,
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

      const registrations = await listRegistrations(eventId, query);
      return reply.send(registrations);
    },
  );

  // GET /api/registrations/:id - Get single registration
  app.get<{ Params: { id: string } }>(
    "/registrations/:id",
    {
      schema: { params: RegistrationIdParamSchema },
    },
    async (request, reply) => {
      const { id } = request.params;

      const registration = await getRegistrationById(id);
      if (!registration) {
        throw app.httpErrors.notFound("Registration not found");
      }

      if (!canAccessClient(request.user!, registration.event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      return reply.send(registration);
    },
  );

  // PATCH /api/registrations/:id - Update registration
  app.patch<{ Params: { id: string }; Body: UpdateRegistrationInput }>(
    "/registrations/:id",
    {
      schema: {
        params: RegistrationIdParamSchema,
        body: UpdateRegistrationSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const input = request.body;

      const clientId = await getRegistrationClientId(id);
      if (!clientId) {
        throw app.httpErrors.notFound("Registration not found");
      }

      if (!canAccessClient(request.user!, clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const registration = await updateRegistration(
        id,
        input,
        request.user!.id,
      );
      return reply.send(registration);
    },
  );

  // POST /api/registrations/:id/confirm - Confirm payment
  app.post<{ Params: { id: string }; Body: UpdatePaymentInput }>(
    "/registrations/:id/confirm",
    {
      schema: {
        params: RegistrationIdParamSchema,
        body: UpdatePaymentSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const input = request.body;

      const clientId = await getRegistrationClientId(id);
      if (!clientId) {
        throw app.httpErrors.notFound("Registration not found");
      }

      if (!canAccessClient(request.user!, clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      // Pass user ID and IP for audit logging
      const registration = await confirmPayment(
        id,
        input,
        request.user!.id,
        request.ip,
      );
      return reply.send(registration);
    },
  );

  // DELETE /api/registrations/:id - Delete registration (force=true bypasses PAID guard)
  app.delete<{
    Params: { id: string };
    Querystring: DeleteRegistrationQuery;
  }>(
    "/registrations/:id",
    {
      schema: {
        params: RegistrationIdParamSchema,
        querystring: DeleteRegistrationQuerySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { force } = request.query;

      const clientId = await getRegistrationClientId(id);
      if (!clientId) {
        throw app.httpErrors.notFound("Registration not found");
      }

      if (!canAccessClient(request.user!, clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      await deleteRegistration(id, request.user!.id, force, request.user!.role);
      return reply.status(204).send();
    },
  );

  // GET /api/registrations/:id/audit-logs - Get audit history for registration
  app.get<{
    Params: { id: string };
    Querystring: ListRegistrationAuditLogsQuery;
  }>(
    "/registrations/:id/audit-logs",
    {
      schema: {
        params: RegistrationIdParamSchema,
        querystring: ListRegistrationAuditLogsQuerySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const query = request.query;

      const clientId = await getRegistrationClientId(id);
      if (!clientId) {
        throw app.httpErrors.notFound("Registration not found");
      }

      if (!canAccessClient(request.user!, clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const logs = await listRegistrationAuditLogs(id, query);
      return reply.send(logs);
    },
  );

  // GET /api/registrations/:id/email-logs - Get email history for registration
  app.get<{
    Params: { id: string };
    Querystring: ListRegistrationEmailLogsQuery;
  }>(
    "/registrations/:id/email-logs",
    {
      schema: {
        params: RegistrationIdParamSchema,
        querystring: ListRegistrationEmailLogsQuerySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const query = request.query;

      const clientId = await getRegistrationClientId(id);
      if (!clientId) {
        throw app.httpErrors.notFound("Registration not found");
      }

      if (!canAccessClient(request.user!, clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const logs = await listRegistrationEmailLogs(id, query);
      return reply.send(logs);
    },
  );

  // GET /api/registrations/:id/payment-proof - Redirect to signed URL for payment proof
  app.get<{ Params: { id: string } }>(
    "/registrations/:id/payment-proof",
    {
      schema: { params: RegistrationIdParamSchema },
    },
    async (request, reply) => {
      const { id } = request.params;

      const registration = await getRegistrationById(id);
      if (!registration) {
        throw app.httpErrors.notFound("Registration not found");
      }

      if (!canAccessClient(request.user!, registration.event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      if (!registration.paymentProofUrl) {
        throw new AppError(
          "No payment proof uploaded",
          404,
          ErrorCodes.NOT_FOUND,
        );
      }

      const key = extractKeyFromUrl(registration.paymentProofUrl);
      if (!key) {
        // Fallback: redirect to the stored URL directly (e.g., old Firebase URLs)
        return reply.status(302).redirect(registration.paymentProofUrl);
      }

      const storage = getStorageProvider();
      const signedUrl = await storage.getSignedUrl(key, 3600);
      return reply.status(302).redirect(signedUrl);
    },
  );
}
