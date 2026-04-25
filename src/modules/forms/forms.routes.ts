import { z } from "zod";
import {
  requireAuth,
  requireAdmin,
  canAccessClient,
} from "@shared/middleware/auth.middleware.js";
import { assertEventWritable, getEventById, EventIdParamSchema } from "@events";
import { assertClientModuleEnabled } from "@clients";
import {
  createForm,
  getFormById,
  listForms,
  updateForm,
  deleteForm,
  getSponsorFormByEventId,
  createSponsorForm,
  isSponsorshipModeLocked,
  updateSponsorshipSettings,
} from "./forms.service.js";
import {
  CreateFormSchema,
  UpdateFormSchema,
  ListFormsQuerySchema,
  FormIdParamSchema,
  UpdateSponsorshipSettingsSchema,
  type CreateFormInput,
  type UpdateFormInput,
  type ListFormsQuery,
  type UpdateSponsorshipSettingsInput,
} from "./forms.schema.js";
import type { AppInstance } from "@shared/types/fastify.js";
import { UserRole } from "@shared/constants/roles.js";

export async function formsRoutes(app: AppInstance): Promise<void> {
  // All routes require authentication
  app.addHook("onRequest", requireAuth);
  app.addHook("onRequest", requireAdmin);

  // POST /api/forms - Create form
  app.post<{ Body: CreateFormInput }>(
    "/",
    {
      schema: { body: CreateFormSchema },
    },
    async (request, reply) => {
      // Get event to check ownership
      const event = await getEventById(request.body.eventId);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      // Check if user is super_admin or creating form for their own client's event
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to create form for this event",
        );
      }
      assertEventWritable(event);
      await assertClientModuleEnabled(event.clientId, "registrations");

      const form = await createForm(request.body);
      return reply.status(201).send(form);
    },
  );

  // GET /api/forms - List forms
  app.get<{ Querystring: ListFormsQuery }>(
    "/",
    {
      schema: { querystring: ListFormsQuerySchema },
    },
    async (request, reply) => {
      const query = { ...request.query };

      if (request.user!.role === UserRole.CLIENT_ADMIN) {
        if (!request.user!.clientId) {
          throw app.httpErrors.badRequest(
            "User is not associated with any client",
          );
        }
        // Client admins must scope by event
        if (!query.eventId) {
          throw app.httpErrors.badRequest(
            "Event ID is required for client admin users",
          );
        }
      } else if (request.user!.role !== UserRole.SUPER_ADMIN) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      if (query.eventId) {
        const event = await getEventById(query.eventId);
        if (!event) {
          throw app.httpErrors.notFound("Event not found");
        }
        if (!canAccessClient(request.user!, event.clientId)) {
          throw app.httpErrors.forbidden(
            "Insufficient permissions to access this event",
          );
        }
        if (query.type === "SPONSOR") {
          await assertClientModuleEnabled(event.clientId, "sponsorships");
        } else if (query.type === "REGISTRATION") {
          await assertClientModuleEnabled(event.clientId, "registrations");
        } else {
          await assertClientModuleEnabled(event.clientId, "registrations");
          await assertClientModuleEnabled(event.clientId, "sponsorships");
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
      schema: { params: FormIdParamSchema },
    },
    async (request, reply) => {
      const form = await getFormById(request.params.id);
      if (!form) {
        throw app.httpErrors.notFound("Form not found");
      }

      if (!canAccessClient(request.user!, form.event.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to access this form",
        );
      }
      await assertClientModuleEnabled(
        form.event.clientId,
        form.type === "SPONSOR" ? "sponsorships" : "registrations",
      );

      return reply.send(form);
    },
  );

  // GET /api/forms/:id/sponsorship-mode-locked - Check if sponsorship mode is locked
  app.get<{ Params: { id: string } }>(
    "/:id/sponsorship-mode-locked",
    {
      schema: { params: FormIdParamSchema },
    },
    async (request, reply) => {
      const form = await getFormById(request.params.id);
      if (!form) {
        throw app.httpErrors.notFound("Form not found");
      }

      if (!canAccessClient(request.user!, form.event.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to access this form",
        );
      }

      // Only applicable for SPONSOR forms
      if (form.type !== "SPONSOR") {
        return reply.send({ locked: false });
      }
      await assertClientModuleEnabled(form.event.clientId, "sponsorships");

      const locked = await isSponsorshipModeLocked(request.params.id);
      return reply.send({ locked });
    },
  );

  // PATCH /api/forms/:id/sponsorship-settings - Update sponsorship settings
  app.patch<{ Params: { id: string }; Body: UpdateSponsorshipSettingsInput }>(
    "/:id/sponsorship-settings",
    {
      schema: {
        params: FormIdParamSchema,
        body: UpdateSponsorshipSettingsSchema,
      },
    },
    async (request, reply) => {
      // Get form to check ownership
      const form = await getFormById(request.params.id);
      if (!form) {
        throw app.httpErrors.notFound("Form not found");
      }

      if (!canAccessClient(request.user!, form.event.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to update this form",
        );
      }
      assertEventWritable(form.event);
      await assertClientModuleEnabled(form.event.clientId, "sponsorships");

      const updatedForm = await updateSponsorshipSettings(
        request.params.id,
        request.body,
      );
      return reply.send(updatedForm);
    },
  );

  // PATCH /api/forms/:id - Update form
  app.patch<{ Params: { id: string }; Body: UpdateFormInput }>(
    "/:id",
    {
      schema: { params: FormIdParamSchema, body: UpdateFormSchema },
    },
    async (request, reply) => {
      // Get form to check ownership
      const form = await getFormById(request.params.id);
      if (!form) {
        throw app.httpErrors.notFound("Form not found");
      }

      if (!canAccessClient(request.user!, form.event.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to update this form",
        );
      }
      assertEventWritable(form.event);
      await assertClientModuleEnabled(
        form.event.clientId,
        form.type === "SPONSOR" ? "sponsorships" : "registrations",
      );

      const updatedForm = await updateForm(request.params.id, request.body);
      return reply.send(updatedForm);
    },
  );

  // DELETE /api/forms/:id - Delete form
  app.delete<{ Params: { id: string } }>(
    "/:id",
    {
      schema: { params: FormIdParamSchema },
    },
    async (request, reply) => {
      // Get form to check ownership
      const form = await getFormById(request.params.id);
      if (!form) {
        throw app.httpErrors.notFound("Form not found");
      }

      if (!canAccessClient(request.user!, form.event.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to delete this form",
        );
      }
      assertEventWritable(form.event);
      await assertClientModuleEnabled(
        form.event.clientId,
        form.type === "SPONSOR" ? "sponsorships" : "registrations",
      );

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
      // Get event to check ownership
      const event = await getEventById(request.params.id);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      // Check if user is super_admin or accessing their own client's event
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to access this event",
        );
      }
      await assertClientModuleEnabled(event.clientId, "sponsorships");

      const form = await getSponsorFormByEventId(request.params.id);
      if (!form) {
        throw app.httpErrors.notFound("Sponsor form not found for this event");
      }

      return reply.send(form);
    },
  );

  // POST /api/forms/events/:id/sponsor - Create sponsor form for event
  app.post<{ Params: { id: string }; Body: { name?: string } }>(
    "/events/:id/sponsor",
    {
      schema: {
        params: EventIdParamSchema,
        body: z.looseObject({ name: z.string().min(1).max(200).optional() }),
      },
    },
    async (request, reply) => {
      // Get event to check ownership
      const event = await getEventById(request.params.id);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      // Check if user is super_admin or creating form for their own client's event
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden(
          "Insufficient permissions to create form for this event",
        );
      }
      assertEventWritable(event);
      await assertClientModuleEnabled(event.clientId, "sponsorships");

      const form = await createSponsorForm(
        request.params.id,
        request.body?.name,
      );
      return reply.status(201).send(form);
    },
  );
}
