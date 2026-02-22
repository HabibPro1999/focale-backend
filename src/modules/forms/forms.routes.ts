import { z } from "zod";
import {
  requireAuth,
  canAccessClient,
  requireEventAccess,
} from "@shared/middleware/auth.middleware.js";
import { getEventById, EventIdParamSchema } from "@events";
import {
  createForm,
  listForms,
  updateForm,
  deleteForm,
  getFormWithClientId,
  getSponsorFormByEventId,
  createSponsorForm,
  isSponsorshipModeLocked,
  updateSponsorshipSettings,
} from "./forms.service.js";
import {
  FormSchemaJsonSchema,
  SponsorFormSchemaJsonSchema,
  SponsorshipModeSchema,
  RegistrantSearchScopeSchema,
} from "./forms.schema.js";
import { IdParamSchema } from "@shared/schemas/params.js";
import { listQuery } from "@shared/schemas/common.js";
import type { AppInstance } from "@shared/fastify.js";
import { UserRole } from "@shared/constants.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";

export async function formsRoutes(app: AppInstance): Promise<void> {
  // ============================================================================
  // Inline request schemas
  // ============================================================================

  const createBody = z
    .object({
      eventId: z.string().uuid(),
      name: z.string().min(1).max(200),
      schema: FormSchemaJsonSchema.optional(),
      successTitle: z.string().optional().nullable(),
      successMessage: z.string().optional().nullable(),
    })
    .strict();

  const updateBody = z
    .object({
      name: z.string().min(1).max(200).optional(),
      schema: FormSchemaJsonSchema.or(SponsorFormSchemaJsonSchema).optional(),
      successTitle: z.string().optional().nullable(),
      successMessage: z.string().optional().nullable(),
      force: z.boolean().optional(),
    })
    .strict();

  const listParams = listQuery({
    eventId: z.string().uuid().optional(),
    type: z.enum(["REGISTRATION", "SPONSOR"]).optional(),
  });

  const updateSponsorshipSettingsBody = z
    .object({
      sponsorshipMode: SponsorshipModeSchema,
      registrantSearchScope: RegistrantSearchScopeSchema.optional(),
      autoApproveSponsorship: z.boolean().optional(),
    })
    .strict();

  // All routes require authentication
  app.addHook("onRequest", requireAuth);

  // POST /api/forms - Create form
  app.post<{ Body: z.infer<typeof createBody> }>(
    "/",
    {
      schema: { body: createBody },
    },
    async (request, reply) => {
      await requireEventAccess(request.user!, request.body.eventId);

      const form = await createForm(request.body);
      return reply.status(201).send(form);
    },
  );

  // GET /api/forms - List forms
  app.get<{ Querystring: z.infer<typeof listParams> }>(
    "/",
    {
      schema: { querystring: listParams },
    },
    async (request, reply) => {
      const query = { ...request.query };

      // For client_admin users, filter by their client's events
      if (request.user!.role === UserRole.CLIENT_ADMIN) {
        if (!request.user!.clientId) {
          throw new AppError(
            "User is not associated with any client",
            400,
            true,
            ErrorCodes.VALIDATION_ERROR,
          );
        }

        // If eventId is provided, verify it belongs to this client
        if (query.eventId) {
          const event = await getEventById(query.eventId);
          if (!event || event.clientId !== request.user!.clientId) {
            throw new AppError(
              "Insufficient permissions to access this event",
              403,
              true,
              ErrorCodes.FORBIDDEN,
            );
          }
        }
        // If no eventId provided, we require it for client_admin users
        else {
          throw new AppError(
            "Event ID is required for client admin users",
            400,
            true,
            ErrorCodes.VALIDATION_ERROR,
          );
        }
      }

      const result = await listForms(query);
      return reply.send(result);
    },
  );

  // GET /api/forms/:id - Get form
  app.get<{ Params: { id: string } }>(
    "/:id",
    {
      schema: { params: IdParamSchema },
    },
    async (request, reply) => {
      const result = await getFormWithClientId(request.params.id);
      if (!result) {
        throw new AppError("Form not found", 404, true, ErrorCodes.NOT_FOUND);
      }

      // Check if user is super_admin or accessing their own client's form
      if (
        !result.clientId ||
        !canAccessClient(request.user!, result.clientId)
      ) {
        throw new AppError(
          "Insufficient permissions to access this form",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      return reply.send(result.form);
    },
  );

  // GET /api/forms/:id/sponsorship-mode-locked - Check if sponsorship mode is locked
  app.get<{ Params: { id: string } }>(
    "/:id/sponsorship-mode-locked",
    {
      schema: { params: IdParamSchema },
    },
    async (request, reply) => {
      const result = await getFormWithClientId(request.params.id);
      if (!result) {
        throw new AppError("Form not found", 404, true, ErrorCodes.NOT_FOUND);
      }

      // Check if user is super_admin or accessing their own client's form
      if (
        !result.clientId ||
        !canAccessClient(request.user!, result.clientId)
      ) {
        throw new AppError(
          "Insufficient permissions to access this form",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      // Only applicable for SPONSOR forms
      if (result.form.type !== "SPONSOR") {
        return reply.send({ locked: false });
      }

      const locked = await isSponsorshipModeLocked(request.params.id);
      return reply.send({ locked });
    },
  );

  // PATCH /api/forms/:id/sponsorship-settings - Update sponsorship settings
  app.patch<{
    Params: { id: string };
    Body: z.infer<typeof updateSponsorshipSettingsBody>;
  }>(
    "/:id/sponsorship-settings",
    {
      schema: {
        params: IdParamSchema,
        body: updateSponsorshipSettingsBody,
      },
    },
    async (request, reply) => {
      // Get form to check ownership
      const result = await getFormWithClientId(request.params.id);
      if (!result) {
        throw new AppError("Form not found", 404, true, ErrorCodes.NOT_FOUND);
      }

      // Check if user is super_admin or updating their own client's form
      if (
        !result.clientId ||
        !canAccessClient(request.user!, result.clientId)
      ) {
        throw new AppError(
          "Insufficient permissions to update this form",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      const updatedForm = await updateSponsorshipSettings(
        request.params.id,
        request.body,
      );
      return reply.send(updatedForm);
    },
  );

  // PATCH /api/forms/:id - Update form
  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateBody> }>(
    "/:id",
    {
      schema: { params: IdParamSchema, body: updateBody },
    },
    async (request, reply) => {
      // Get form to check ownership
      const result = await getFormWithClientId(request.params.id);
      if (!result) {
        throw new AppError("Form not found", 404, true, ErrorCodes.NOT_FOUND);
      }

      // Check if user is super_admin or updating their own client's form
      if (
        !result.clientId ||
        !canAccessClient(request.user!, result.clientId)
      ) {
        throw new AppError(
          "Insufficient permissions to update this form",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      const updatedForm = await updateForm(request.params.id, request.body);
      return reply.send(updatedForm);
    },
  );

  // DELETE /api/forms/:id - Delete form
  app.delete<{ Params: { id: string } }>(
    "/:id",
    {
      schema: { params: IdParamSchema },
    },
    async (request, reply) => {
      // Get form to check ownership
      const result = await getFormWithClientId(request.params.id);
      if (!result) {
        throw new AppError("Form not found", 404, true, ErrorCodes.NOT_FOUND);
      }

      // Check if user is super_admin or deleting their own client's form
      if (
        !result.clientId ||
        !canAccessClient(request.user!, result.clientId)
      ) {
        throw new AppError(
          "Insufficient permissions to delete this form",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      await deleteForm(request.params.id);
      return reply.status(204).send();
    },
  );

  // ============================================================================
  // Sponsor Form Routes
  // ============================================================================

  // GET /api/forms/events/:id/sponsor - Get sponsor form for event
  app.get<{ Params: { id: string } }>(
    "/events/:id/sponsor",
    {
      schema: { params: EventIdParamSchema },
    },
    async (request, reply) => {
      await requireEventAccess(request.user!, request.params.id);

      const form = await getSponsorFormByEventId(request.params.id);
      if (!form) {
        throw new AppError(
          "Sponsor form not found for this event",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      return reply.send(form);
    },
  );

  // POST /api/forms/events/:id/sponsor - Create sponsor form for event
  app.post<{ Params: { id: string }; Body: { name?: string } }>(
    "/events/:id/sponsor",
    {
      schema: { params: EventIdParamSchema },
    },
    async (request, reply) => {
      await requireEventAccess(request.user!, request.params.id);

      const form = await createSponsorForm(
        request.params.id,
        request.body?.name,
      );
      return reply.status(201).send(form);
    },
  );
}
