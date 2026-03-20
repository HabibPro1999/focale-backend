import {
  requireAuth,
  canAccessClient,
} from "@shared/middleware/auth.middleware.js";
import { getEventById } from "@events";
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  uploadTemplateImage,
} from "./certificates.service.js";
import {
  EventIdParamSchema,
  TemplateIdParamSchema,
  CreateCertificateTemplateSchema,
  UpdateCertificateTemplateSchema,
  type CreateCertificateTemplateInput,
  type UpdateCertificateTemplateInput,
} from "./certificates.schema.js";
import type { AppInstance } from "@shared/types/fastify.js";

// ============================================================================
// Protected Routes (Admin)
// ============================================================================

export async function certificatesRoutes(app: AppInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  // GET /api/events/:eventId/certificates — list templates for event
  app.get<{
    Params: { eventId: string };
  }>(
    "/:eventId/certificates",
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

      const templates = await listTemplates(eventId);
      return reply.send(templates);
    },
  );

  // POST /api/events/:eventId/certificates — create template (JSON body, no file)
  app.post<{
    Params: { eventId: string };
    Body: CreateCertificateTemplateInput;
  }>(
    "/:eventId/certificates",
    {
      schema: {
        params: EventIdParamSchema,
        body: CreateCertificateTemplateSchema,
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

      const template = await createTemplate(eventId, request.body);
      return reply.status(201).send(template);
    },
  );

  // GET /api/events/certificates/:id — get single template
  app.get<{
    Params: { id: string };
  }>(
    "/certificates/:id",
    {
      schema: { params: TemplateIdParamSchema },
    },
    async (request, reply) => {
      const { id } = request.params;

      const template = await getTemplate(id);

      if (!canAccessClient(request.user!, template.event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      return reply.send(template);
    },
  );

  // PATCH /api/events/certificates/:id — update template (zones, name, etc.)
  app.patch<{
    Params: { id: string };
    Body: UpdateCertificateTemplateInput;
  }>(
    "/certificates/:id",
    {
      schema: {
        params: TemplateIdParamSchema,
        body: UpdateCertificateTemplateSchema,
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      const existing = await getTemplate(id);

      if (!canAccessClient(request.user!, existing.event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const template = await updateTemplate(id, request.body);
      return reply.send(template);
    },
  );

  // DELETE /api/events/certificates/:id — delete template + stored image
  app.delete<{
    Params: { id: string };
  }>(
    "/certificates/:id",
    {
      schema: { params: TemplateIdParamSchema },
    },
    async (request, reply) => {
      const { id } = request.params;

      const existing = await getTemplate(id);

      if (!canAccessClient(request.user!, existing.event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      await deleteTemplate(id);
      return reply.status(204).send();
    },
  );

  // POST /api/events/certificates/:id/image — upload template image (multipart)
  app.post<{
    Params: { id: string };
  }>(
    "/certificates/:id/image",
    {
      schema: { params: TemplateIdParamSchema },
    },
    async (request, reply) => {
      const { id } = request.params;

      const existing = await getTemplate(id);

      if (!canAccessClient(request.user!, existing.event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }

      const data = await request.file({
        limits: { fileSize: 10 * 1024 * 1024 },
      }); // 10 MB
      if (!data) {
        throw app.httpErrors.badRequest("No file uploaded");
      }

      const buffer = await data.toBuffer();
      const template = await uploadTemplateImage(id, {
        buffer,
        filename: data.filename,
        mimetype: data.mimetype,
      });

      return reply.send(template);
    },
  );
}
