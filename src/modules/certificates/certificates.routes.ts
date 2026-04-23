import {
  requireAuth,
  canAccessClient,
} from "@shared/middleware/auth.middleware.js";
import { assertEventWritable, getEventById } from "@events";
import { assertClientModuleEnabled } from "@clients";
import {
  listTemplates,
  getTemplate,
  downloadTemplateImage,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  uploadTemplateImage,
} from "./certificates.service.js";
import {
  isEligibleForCertificate,
  type CertificateTemplateData,
} from "./certificate-pdf.service.js";
import {
  EventIdParamSchema,
  TemplateIdParamSchema,
  CreateCertificateTemplateSchema,
  UpdateCertificateTemplateSchema,
  SendCertificatesBodySchema,
  type CreateCertificateTemplateInput,
  type UpdateCertificateTemplateInput,
  type CertificateZone,
} from "./certificates.schema.js";
import { getTemplateByTrigger } from "@modules/email/email-template.service.js";
import { queueBulkCertificateEmails } from "@modules/email/email-queue.service.js";
import { buildEmailContextWithAccess } from "@modules/email/email-context.js";
import { logger } from "@shared/utils/logger.js";
import { prisma } from "@/database/client.js";
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
      await assertClientModuleEnabled(event.clientId, "certificates");

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
      assertEventWritable(event);
      await assertClientModuleEnabled(event.clientId, "certificates");

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
      await assertClientModuleEnabled(template.event.clientId, "certificates");

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
      assertEventWritable(existing.event);
      await assertClientModuleEnabled(existing.event.clientId, "certificates");

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
      assertEventWritable(existing.event);
      await assertClientModuleEnabled(existing.event.clientId, "certificates");

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
      assertEventWritable(existing.event);
      await assertClientModuleEnabled(existing.event.clientId, "certificates");

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

  // GET /api/events/certificates/:id/image — download template image via API origin
  app.get<{
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
      await assertClientModuleEnabled(existing.event.clientId, "certificates");

      if (!existing.templateUrl) {
        throw app.httpErrors.notFound("Certificate template image not found");
      }

      const file = await downloadTemplateImage(existing.templateUrl);

      reply.header("Cache-Control", "private, max-age=300");
      reply.type(file.contentType ?? "application/octet-stream");
      return reply.send(file.buffer);
    },
  );

  // POST /api/events/:eventId/certificates/send — send certificates via email
  app.post<{
    Params: { eventId: string };
    Body: { registrationIds?: string[] };
  }>(
    "/:eventId/certificates/send",
    {
      schema: {
        params: EventIdParamSchema,
        body: SendCertificatesBodySchema,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const { registrationIds } = request.body;

      // 1. Auth + access check
      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }
      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden("Insufficient permissions");
      }
      assertEventWritable(event);
      await assertClientModuleEnabled(event.clientId, "certificates");
      await assertClientModuleEnabled(event.clientId, "emails");

      // 2. Get the CERTIFICATE_SENT email template
      const emailTemplate = await getTemplateByTrigger(
        eventId,
        "CERTIFICATE_SENT",
      );
      if (!emailTemplate) {
        throw app.httpErrors.badRequest(
          "No CERTIFICATE_SENT email template configured for this event. Create one in the Email Templates section first.",
        );
      }

      // 3. Get all active certificate templates for the event
      const certTemplates = await prisma.certificateTemplate.findMany({
        where: { eventId, active: true },
        include: { access: { select: { id: true, name: true } } },
      });

      if (certTemplates.length === 0) {
        throw app.httpErrors.badRequest(
          "No active certificate templates found for this event.",
        );
      }

      // 4. Fetch registrations with check-in data
      const registrations = await prisma.registration.findMany({
        where: {
          eventId,
          ...(registrationIds ? { id: { in: registrationIds } } : {}),
        },
        include: {
          accessCheckIns: { select: { accessId: true } },
          event: { include: { client: true } },
          form: true,
        },
      });

      // 5. For each registration, determine eligible certificates and queue email
      const inputs: Array<{
        registrationId: string;
        recipientEmail: string;
        recipientName?: string;
        certificateTemplateIds: string[];
        certificateNames: string[];
        contextSnapshot: Record<string, unknown>;
      }> = [];

      const breakdown: Record<string, number> = {};

      // Build template data once — same for all registrants
      const templateData: CertificateTemplateData[] = certTemplates.map(
        (t) => ({
          id: t.id,
          name: t.name,
          templateUrl: t.templateUrl,
          templateWidth: t.templateWidth,
          templateHeight: t.templateHeight,
          zones: t.zones as CertificateZone[],
          applicableRoles: t.applicableRoles as string[],
          accessId: t.accessId,
          access: t.access,
        }),
      );

      // Filter eligible registrations first (pure, no DB calls)
      const eligibleRegs = registrations
        .map((reg) => {
          const eligible = templateData.filter((t) =>
            isEligibleForCertificate(
              {
                id: reg.id,
                firstName: reg.firstName,
                lastName: reg.lastName,
                role: reg.role,
                checkedInAt: reg.checkedInAt,
                accessCheckIns: reg.accessCheckIns,
                event: {
                  name: reg.event.name,
                  startDate: reg.event.startDate,
                  location: reg.event.location,
                },
              },
              t,
            ),
          );
          return { reg, eligible };
        })
        .filter(({ eligible }) => eligible.length > 0);

      // Build email contexts in parallel (10 concurrent to limit DB pressure)
      const CONTEXT_CONCURRENCY = 10;
      for (let i = 0; i < eligibleRegs.length; i += CONTEXT_CONCURRENCY) {
        const chunk = eligibleRegs.slice(i, i + CONTEXT_CONCURRENCY);
        const contexts = await Promise.all(
          chunk.map(({ reg }) =>
            buildEmailContextWithAccess(
              reg as Parameters<typeof buildEmailContextWithAccess>[0],
            ),
          ),
        );

        for (let j = 0; j < chunk.length; j++) {
          const { reg, eligible } = chunk[j];
          const context = contexts[j];

          for (const t of eligible) {
            breakdown[t.name] = (breakdown[t.name] || 0) + 1;
          }

          inputs.push({
            registrationId: reg.id,
            recipientEmail: reg.email,
            recipientName:
              [reg.firstName, reg.lastName].filter(Boolean).join(" ") ||
              undefined,
            certificateTemplateIds: eligible.map((t) => t.id),
            certificateNames: eligible.map((t) => t.name),
            contextSnapshot: context as unknown as Record<string, unknown>,
          });
        }
      }

      // 6. Queue all emails
      const { queued, skipped } = await queueBulkCertificateEmails(
        emailTemplate.id,
        inputs,
      );

      logger.info(
        { eventId, queued, skipped, total: registrations.length, breakdown },
        "Certificate emails queued",
      );

      return reply.send({
        success: true,
        queued,
        skipped,
        total: registrations.length,
        breakdown,
      });
    },
  );
}
