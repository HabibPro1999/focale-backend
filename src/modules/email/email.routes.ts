import { z } from "zod";
import {
  requireAuth,
  canAccessClient,
  requireEventAccess,
} from "@shared/middleware/auth.middleware.js";
import {
  createEmailTemplate,
  getEmailTemplateById,
  getEmailTemplateClientId,
  listEmailTemplates,
  updateEmailTemplate,
  deleteEmailTemplate,
  duplicateEmailTemplate,
} from "./email-template.service.js";
import {
  getAvailableVariables,
  getSampleEmailContext,
  resolveVariables,
  resolveVariablesHtml,
} from "./email-variable.service.js";
import { sendEmail } from "./email-sendgrid.service.js";
import { queueBulkEmails } from "./email-queue.service.js";
import { prisma } from "@/database/client.js";
import { Prisma } from "@/generated/prisma/client.js";
import {
  ListEmailTemplatesQuerySchema,
  CreateEmailTemplateSchema,
  UpdateEmailTemplateSchema,
  BulkSendEmailSchema,
  TestSendEmailSchema,
} from "./email.schema.js";
import { EventIdParamSchema } from "@shared/schemas/params.js";
import type { AppInstance } from "@shared/fastify.js";
import { AppError } from "@shared/errors.js";
import { ErrorCodes } from "@shared/errors.js";

// ============================================================================
// Local request schemas (inlined — not exported)
// ============================================================================

const TemplateIdParamSchema = z
  .object({ templateId: z.string().uuid() })
  .strict();

// ============================================================================
// Protected Routes (Admin)
// ============================================================================

export async function emailRoutes(app: AppInstance): Promise<void> {
  app.addHook("onRequest", requireAuth);

  // ==========================================================================
  // EMAIL TEMPLATES
  // ==========================================================================

  // GET /api/events/:eventId/email-templates - List templates for event
  app.get<{
    Params: { eventId: string };
    Querystring: z.infer<typeof ListEmailTemplatesQuerySchema>;
  }>(
    "/:eventId/email-templates",
    {
      schema: {
        params: EventIdParamSchema,
        querystring: ListEmailTemplatesQuerySchema,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const query = request.query;

      await requireEventAccess(request.user!, eventId);

      const templates = await listEmailTemplates(eventId, query);
      return reply.send(templates);
    },
  );

  // GET /api/events/:eventId/email-templates/variables - Get available variables for event
  app.get<{
    Params: { eventId: string };
  }>(
    "/:eventId/email-templates/variables",
    {
      schema: { params: EventIdParamSchema },
    },
    async (request, reply) => {
      const { eventId } = request.params;

      await requireEventAccess(request.user!, eventId);

      const variables = await getAvailableVariables(eventId);
      return reply.send(variables);
    },
  );

  // POST /api/events/:eventId/email-templates - Create template
  app.post<{
    Params: { eventId: string };
    Body: Omit<z.infer<typeof CreateEmailTemplateSchema>, "eventId">;
  }>(
    "/:eventId/email-templates",
    {
      schema: {
        params: EventIdParamSchema,
        body: CreateEmailTemplateSchema.omit({ eventId: true }),
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const input = request.body;

      await requireEventAccess(request.user!, eventId);

      const template = await createEmailTemplate({ ...input, eventId });
      return reply.status(201).send(template);
    },
  );

  // GET /api/events/email-templates/:templateId - Get single template
  app.get<{ Params: { templateId: string } }>(
    "/email-templates/:templateId",
    {
      schema: { params: TemplateIdParamSchema },
    },
    async (request, reply) => {
      const { templateId } = request.params;

      const template = await getEmailTemplateById(templateId);
      if (!template) {
        throw new AppError(
          "Email template not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (!canAccessClient(request.user!, template.clientId)) {
        throw new AppError(
          "Insufficient permissions",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      return reply.send(template);
    },
  );

  // PATCH /api/events/email-templates/:templateId - Update template
  app.patch<{
    Params: { templateId: string };
    Body: z.infer<typeof UpdateEmailTemplateSchema>;
  }>(
    "/email-templates/:templateId",
    {
      schema: {
        params: TemplateIdParamSchema,
        body: UpdateEmailTemplateSchema,
      },
    },
    async (request, reply) => {
      const { templateId } = request.params;
      const input = request.body;

      const clientId = await getEmailTemplateClientId(templateId);
      if (!clientId) {
        throw new AppError(
          "Email template not found",
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

      const template = await updateEmailTemplate(templateId, input);
      return reply.send(template);
    },
  );

  // DELETE /api/events/email-templates/:templateId - Delete template
  app.delete<{ Params: { templateId: string } }>(
    "/email-templates/:templateId",
    {
      schema: { params: TemplateIdParamSchema },
    },
    async (request, reply) => {
      const { templateId } = request.params;

      const clientId = await getEmailTemplateClientId(templateId);
      if (!clientId) {
        throw new AppError(
          "Email template not found",
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

      await deleteEmailTemplate(templateId);
      return reply.status(204).send();
    },
  );

  // POST /api/events/email-templates/:templateId/duplicate - Duplicate template
  app.post<{ Params: { templateId: string }; Body: { name?: string } }>(
    "/email-templates/:templateId/duplicate",
    {
      schema: { params: TemplateIdParamSchema },
    },
    async (request, reply) => {
      const { templateId } = request.params;
      const { name } = request.body || {};

      const clientId = await getEmailTemplateClientId(templateId);
      if (!clientId) {
        throw new AppError(
          "Email template not found",
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

      const template = await duplicateEmailTemplate(templateId, name);
      return reply.status(201).send(template);
    },
  );

  // POST /api/events/email-templates/:templateId/test-send - Send test email
  app.post<{
    Params: { templateId: string };
    Body: z.infer<typeof TestSendEmailSchema>;
  }>(
    "/email-templates/:templateId/test-send",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
      schema: {
        params: TemplateIdParamSchema,
        body: TestSendEmailSchema,
      },
    },
    async (request, reply) => {
      const { templateId } = request.params;
      const { recipientEmail, recipientName } = request.body;

      const template = await getEmailTemplateById(templateId);
      if (!template) {
        throw new AppError(
          "Email template not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (!canAccessClient(request.user!, template.clientId)) {
        throw new AppError(
          "Insufficient permissions",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      // Get sample context for variable resolution
      const sampleContext = getSampleEmailContext();

      // Resolve variables in subject and HTML content
      const resolvedSubject = resolveVariables(template.subject, sampleContext);
      const resolvedHtml = resolveVariablesHtml(
        template.htmlContent || "",
        sampleContext,
      );
      const resolvedPlainText = resolveVariables(
        template.plainContent || "",
        sampleContext,
      );

      // Send test email
      const result = await sendEmail({
        to: recipientEmail,
        toName: recipientName,
        subject: `[TEST] ${resolvedSubject}`,
        html: resolvedHtml,
        plainText: resolvedPlainText,
        categories: ["test-email"],
      });

      if (!result.success) {
        throw new AppError(
          result.error || "Failed to send test email",
          502,
          true,
          ErrorCodes.INTERNAL_ERROR,
        );
      }

      return reply.send({
        success: true,
        message: `Test email sent to ${recipientEmail}`,
        messageId: result.messageId,
      });
    },
  );

  // ==========================================================================
  // BULK EMAIL SEND (Simple - no campaigns)
  // ==========================================================================

  // POST /api/events/:eventId/email-templates/:templateId/send - Send to recipients
  app.post<{
    Params: { eventId: string; templateId: string };
    Body: z.infer<typeof BulkSendEmailSchema>;
  }>(
    "/:eventId/email-templates/:templateId/send",
    {
      schema: {
        params: EventIdParamSchema.extend({
          templateId: TemplateIdParamSchema.shape.templateId,
        }),
        body: BulkSendEmailSchema,
      },
    },
    async (request, reply) => {
      const { eventId, templateId } = request.params;
      const { registrationIds, filters } = request.body;

      // Verify event access
      const event = await requireEventAccess(request.user!, eventId);

      // Verify template exists and belongs to this event/client
      const template = await getEmailTemplateById(templateId);
      if (!template) {
        throw new AppError(
          "Email template not found",
          404,
          true,
          ErrorCodes.NOT_FOUND,
        );
      }

      if (template.clientId !== event.clientId) {
        throw new AppError(
          "Template does not belong to this client",
          403,
          true,
          ErrorCodes.FORBIDDEN,
        );
      }

      if (!template.isActive) {
        throw new AppError(
          "Cannot send with an inactive template",
          400,
          true,
          ErrorCodes.BAD_REQUEST,
        );
      }

      // Get registrations based on IDs or filters
      let registrations: Array<{
        id: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
      }>;

      if (registrationIds && registrationIds.length > 0) {
        // Send to specific registrations
        registrations = await prisma.registration.findMany({
          where: {
            id: { in: registrationIds },
            eventId,
          },
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        });
      } else {
        // Send to all or filtered registrants
        const where: Prisma.RegistrationWhereInput = { eventId };
        if (filters?.paymentStatus)
          where.paymentStatus = { in: filters.paymentStatus };
        if (filters?.accessTypeIds?.length)
          where.accessTypeIds = { hasSome: filters.accessTypeIds };

        registrations = await prisma.registration.findMany({
          where,
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        });
      }

      if (registrations.length === 0) {
        return reply.send({
          success: true,
          queued: 0,
          message: "No recipients matched the criteria",
        });
      }

      // Queue emails
      const queued = await queueBulkEmails(templateId, registrations);

      return reply.send({
        success: true,
        queued,
        message: `${queued} emails queued for sending`,
      });
    },
  );
}
