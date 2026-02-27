import { z } from "zod";
import {
  requireAuth,
  requireSuperAdmin,
  canAccessClient,
  requireEventAccess,
} from "@shared/middleware/auth.middleware.js";
import { IdParamSchema, EventIdParamSchema } from "@shared/schemas/params.js";
import { listQuery } from "@shared/schemas/common.js";
import {
  getRegistrationById,
  updateRegistration,
  deleteRegistration,
  listRegistrations,
  listAllRegistrations,
} from "./registration-crud.service.js";
import {
  confirmPayment,
  extractKeyFromUrl,
} from "./registration-payment.service.js";
import {
  getRegistrationTableColumns,
  listRegistrationAuditLogs,
  listRegistrationEmailLogs,
  searchRegistrantsForSponsorship,
} from "./registration-query.service.js";
import { getStorageProvider } from "@shared/services/storage/index.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";
import {
  PaymentStatusSchema,
  PaymentMethodSchema,
  DeleteRegistrationQuerySchema,
} from "./registrations.schema.js";
import type {
  UpdateRegistrationInput,
  UpdatePaymentInput,
  ListRegistrationsQuery,
  ListAllRegistrationsQuery,
  ListRegistrationAuditLogsQuery,
  ListRegistrationEmailLogsQuery,
  SearchRegistrantsQuery,
  DeleteRegistrationQuery,
} from "./registrations.schema.js";
import type { AppInstance } from "@shared/fastify.js";
import type { RegistrationWithRelations } from "./registration-crud.service.js";

// ============================================================================
// Helper: strip sensitive fields from admin responses
// ============================================================================

type SafeRegistration = Omit<
  RegistrationWithRelations,
  "editToken" | "editTokenExpiry" | "idempotencyKey"
>;

function stripSensitiveFields(
  reg: RegistrationWithRelations,
): SafeRegistration {
  const copy = { ...reg } as Partial<RegistrationWithRelations>;
  delete copy.editToken;
  delete copy.editTokenExpiry;
  delete copy.idempotencyKey;
  return copy as SafeRegistration;
}

// ============================================================================
// Inline request schemas
// ============================================================================

const UpdateRegistrationSchema = z
  .object({
    paymentStatus: PaymentStatusSchema.optional(),
    paidAmount: z.number().int().min(0).optional(),
    paymentMethod: PaymentMethodSchema.optional(),
    paymentReference: z.string().max(200).optional(),
    paymentProofUrl: z.string().url().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();

const UpdatePaymentSchema = z
  .object({
    paymentStatus: PaymentStatusSchema,
    paidAmount: z.number().int().min(0).optional(),
    paymentMethod: PaymentMethodSchema.optional(),
    paymentReference: z.string().max(200).optional(),
    paymentProofUrl: z.string().url().optional(),
  })
  .strict();

const ListRegistrationsQuerySchema = listQuery({
  paymentStatus: PaymentStatusSchema.optional(),
});

const ListAllRegistrationsQuerySchema = listQuery({
  eventId: z.string().uuid().optional(),
  paymentStatus: PaymentStatusSchema.optional(),
});

const ListRegistrationAuditLogsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const ListRegistrationEmailLogsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const SearchRegistrantsQuerySchema = z
  .object({
    query: z.string().min(1).max(200),
    unpaidOnly: z.coerce.boolean().optional().default(false),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();

// ============================================================================
// Protected Routes (Admin)
// ============================================================================

export async function registrationsRoutes(app: AppInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  // GET /api/registrations - List all registrations (super admin only)
  app.get<{
    Querystring: ListAllRegistrationsQuery;
  }>(
    "/registrations",
    {
      preHandler: [requireSuperAdmin],
      schema: {
        querystring: ListAllRegistrationsQuerySchema,
      },
    },
    async (request, reply) => {
      const query = request.query;
      const result = await listAllRegistrations(query);
      const safeData = result.data.map(
        ({
          editToken: _et,
          editTokenExpiry: _ete,
          idempotencyKey: _ik,
          ...reg
        }) => reg,
      );
      return reply.send({ ...result, data: safeData });
    },
  );

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

      await requireEventAccess(request.user!, eventId);

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

      await requireEventAccess(request.user!, eventId);

      const results = await searchRegistrantsForSponsorship(eventId, query);
      return reply.send(results);
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

      await requireEventAccess(request.user!, eventId);

      const result = await listRegistrations(eventId, query);
      const safeData = result.data.map(
        ({
          editToken: _et,
          editTokenExpiry: _ete,
          idempotencyKey: _ik,
          ...reg
        }) => reg,
      );
      return reply.send({ ...result, data: safeData });
    },
  );

  // GET /api/registrations/:id - Get single registration
  app.get<{ Params: { id: string } }>(
    "/registrations/:id",
    {
      schema: { params: IdParamSchema },
    },
    async (request, reply) => {
      const { id } = request.params;

      const registration = await getRegistrationById(id);
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

      const safeRegistration = stripSensitiveFields(registration);
      return reply.send(safeRegistration);
    },
  );

  // PATCH /api/registrations/:id - Update registration
  app.patch<{ Params: { id: string }; Body: UpdateRegistrationInput }>(
    "/registrations/:id",
    {
      schema: {
        params: IdParamSchema,
        body: UpdateRegistrationSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const input = request.body;

      const existing = await getRegistrationById(id);
      if (!existing) {
        throw new AppError(
          "Registration not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (!canAccessClient(request.user!, existing.event.clientId)) {
        throw new AppError(
          "Insufficient permissions",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
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
        params: IdParamSchema,
        body: UpdatePaymentSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const input = request.body;

      const existing = await getRegistrationById(id);
      if (!existing) {
        throw new AppError(
          "Registration not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (!canAccessClient(request.user!, existing.event.clientId)) {
        throw new AppError(
          "Insufficient permissions",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
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
        params: IdParamSchema,
        querystring: DeleteRegistrationQuerySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { force } = request.query;

      const existing = await getRegistrationById(id);
      if (!existing) {
        throw new AppError(
          "Registration not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (!canAccessClient(request.user!, existing.event.clientId)) {
        throw new AppError(
          "Insufficient permissions",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      await deleteRegistration(id, request.user!.id, {
        force,
        callerRole: request.user!.role,
      });
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
        params: IdParamSchema,
        querystring: ListRegistrationAuditLogsQuerySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const query = request.query;

      const existing = await getRegistrationById(id);
      if (!existing) {
        throw new AppError(
          "Registration not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (!canAccessClient(request.user!, existing.event.clientId)) {
        throw new AppError(
          "Insufficient permissions",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
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
        params: IdParamSchema,
        querystring: ListRegistrationEmailLogsQuerySchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const query = request.query;

      const existing = await getRegistrationById(id);
      if (!existing) {
        throw new AppError(
          "Registration not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (!canAccessClient(request.user!, existing.event.clientId)) {
        throw new AppError(
          "Insufficient permissions",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      const logs = await listRegistrationEmailLogs(id, query);
      return reply.send(logs);
    },
  );

  // GET /api/registrations/:id/payment-proof - Redirect to signed URL for payment proof
  app.get<{ Params: { id: string } }>(
    "/registrations/:id/payment-proof",
    {
      schema: { params: IdParamSchema },
    },
    async (request, reply) => {
      const { id } = request.params;

      const registration = await getRegistrationById(id);
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

      if (!registration.paymentProofUrl) {
        throw new AppError(
          "No payment proof uploaded",
          404,
          true,
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
