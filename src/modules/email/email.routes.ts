import { requireAuth, canAccessClient } from '@shared/middleware/auth.middleware.js';
import { publicRateLimits } from '@core/plugins.js';
import { getEventById } from '@events';
import {
  createEmailTemplate,
  getEmailTemplateById,
  getEmailTemplateClientId,
  listEmailTemplates,
  updateEmailTemplate,
  deleteEmailTemplate,
  duplicateEmailTemplate,
  listEventEmailLogs,
} from './email-template.service.js';
import {
  getAvailableVariables,
  getSampleEmailContext,
  resolveVariables,
} from './email-variable.service.js';
import { sendEmail } from './email-sendgrid.service.js';
import { queueBulkEmails, queueBulkSponsorEmails } from './email-queue.service.js';
import { buildBatchEmailContext } from './email-context.js';
import { prisma } from '@/database/client.js';
import {
  EventIdParamSchema,
  EmailTemplateIdParamSchema,
  CreateEmailTemplateSchema,
  UpdateEmailTemplateSchema,
  ListEmailTemplatesQuerySchema,
  ListEventEmailLogsQuerySchema,
  TestSendEmailSchema,
  BulkSendEmailSchema,
  type CreateEmailTemplateInput,
  type ListEventEmailLogsQuery,
  type UpdateEmailTemplateInput,
  type ListEmailTemplatesQuery,
  type TestSendEmailInput,
  type BulkSendEmailInput,
} from './email.schema.js';
import type { AppInstance } from '@shared/types/fastify.js';

// ============================================================================
// Protected Routes (Admin)
// ============================================================================

export async function emailRoutes(app: AppInstance): Promise<void> {
  app.addHook('onRequest', requireAuth);

  // ==========================================================================
  // EMAIL TEMPLATES
  // ==========================================================================

  // GET /api/events/:eventId/email-templates - List templates for event
  app.get<{
    Params: { eventId: string };
    Querystring: ListEmailTemplatesQuery;
  }>(
    '/:eventId/email-templates',
    {
      schema: {
        params: EventIdParamSchema,
        querystring: ListEmailTemplatesQuerySchema,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const query = request.query;

      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound('Event not found');
      }

      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden('Insufficient permissions');
      }

      const templates = await listEmailTemplates(eventId, query);
      return reply.send(templates);
    }
  );

  // GET /api/events/:eventId/email-templates/variables - Get available variables for event
  app.get<{
    Params: { eventId: string };
  }>(
    '/:eventId/email-templates/variables',
    {
      schema: { params: EventIdParamSchema },
    },
    async (request, reply) => {
      const { eventId } = request.params;

      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound('Event not found');
      }

      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden('Insufficient permissions');
      }

      const variables = await getAvailableVariables(eventId);
      return reply.send(variables);
    }
  );

  // POST /api/events/:eventId/email-templates - Create template
  app.post<{
    Params: { eventId: string };
    Body: Omit<CreateEmailTemplateInput, 'eventId'>;
  }>(
    '/:eventId/email-templates',
    {
      schema: {
        params: EventIdParamSchema,
        body: CreateEmailTemplateSchema.omit({ eventId: true }),
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const input = request.body;

      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound('Event not found');
      }

      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden('Insufficient permissions');
      }

      const template = await createEmailTemplate({ ...input, eventId });
      return reply.status(201).send(template);
    }
  );

  // GET /api/events/email-templates/:templateId - Get single template
  app.get<{ Params: { templateId: string } }>(
    '/email-templates/:templateId',
    {
      schema: { params: EmailTemplateIdParamSchema },
    },
    async (request, reply) => {
      const { templateId } = request.params;

      const template = await getEmailTemplateById(templateId);
      if (!template) {
        throw app.httpErrors.notFound('Email template not found');
      }

      if (!canAccessClient(request.user!, template.clientId)) {
        throw app.httpErrors.forbidden('Insufficient permissions');
      }

      return reply.send(template);
    }
  );

  // PATCH /api/events/email-templates/:templateId - Update template
  app.patch<{ Params: { templateId: string }; Body: UpdateEmailTemplateInput }>(
    '/email-templates/:templateId',
    {
      schema: {
        params: EmailTemplateIdParamSchema,
        body: UpdateEmailTemplateSchema,
      },
    },
    async (request, reply) => {
      const { templateId } = request.params;
      const input = request.body;

      const clientId = await getEmailTemplateClientId(templateId);
      if (!clientId) {
        throw app.httpErrors.notFound('Email template not found');
      }

      if (!canAccessClient(request.user!, clientId)) {
        throw app.httpErrors.forbidden('Insufficient permissions');
      }

      const template = await updateEmailTemplate(templateId, input);
      return reply.send(template);
    }
  );

  // DELETE /api/events/email-templates/:templateId - Delete template
  app.delete<{ Params: { templateId: string } }>(
    '/email-templates/:templateId',
    {
      schema: { params: EmailTemplateIdParamSchema },
    },
    async (request, reply) => {
      const { templateId } = request.params;

      const clientId = await getEmailTemplateClientId(templateId);
      if (!clientId) {
        throw app.httpErrors.notFound('Email template not found');
      }

      if (!canAccessClient(request.user!, clientId)) {
        throw app.httpErrors.forbidden('Insufficient permissions');
      }

      await deleteEmailTemplate(templateId);
      return reply.status(204).send();
    }
  );

  // POST /api/events/email-templates/:templateId/duplicate - Duplicate template
  app.post<{ Params: { templateId: string }; Body: { name?: string } }>(
    '/email-templates/:templateId/duplicate',
    {
      schema: { params: EmailTemplateIdParamSchema },
    },
    async (request, reply) => {
      const { templateId } = request.params;
      const { name } = request.body || {};

      const clientId = await getEmailTemplateClientId(templateId);
      if (!clientId) {
        throw app.httpErrors.notFound('Email template not found');
      }

      if (!canAccessClient(request.user!, clientId)) {
        throw app.httpErrors.forbidden('Insufficient permissions');
      }

      const template = await duplicateEmailTemplate(templateId, name);
      return reply.status(201).send(template);
    }
  );

  // POST /api/events/email-templates/:templateId/test-send - Send test email
  app.post<{ Params: { templateId: string }; Body: TestSendEmailInput }>(
    '/email-templates/:templateId/test-send',
    {
      config: { rateLimit: publicRateLimits.emailTestSend },
      schema: {
        params: EmailTemplateIdParamSchema,
        body: TestSendEmailSchema,
      },
    },
    async (request, reply) => {
      const { templateId } = request.params;
      const { recipientEmail, recipientName } = request.body;

      const template = await getEmailTemplateById(templateId);
      if (!template) {
        throw app.httpErrors.notFound('Email template not found');
      }

      if (!canAccessClient(request.user!, template.clientId)) {
        throw app.httpErrors.forbidden('Insufficient permissions');
      }

      // Get sample context for variable resolution
      const sampleContext = getSampleEmailContext();

      // Resolve variables in subject and HTML content
      const resolvedSubject = resolveVariables(template.subject, sampleContext);
      const resolvedHtml = resolveVariables(template.htmlContent || '', sampleContext);
      const resolvedPlainText = resolveVariables(template.plainContent || '', sampleContext);

      // Send test email
      const result = await sendEmail({
        to: recipientEmail,
        toName: recipientName,
        subject: `[TEST] ${resolvedSubject}`,
        html: resolvedHtml,
        plainText: resolvedPlainText,
        categories: ['test-email'],
      });

      if (!result.success) {
        throw app.httpErrors.badGateway(result.error || 'Failed to send test email');
      }

      return reply.send({
        success: true,
        message: `Test email sent to ${recipientEmail}`,
        messageId: result.messageId,
      });
    }
  );

  // ==========================================================================
  // EVENT EMAIL LOGS
  // ==========================================================================

  // GET /api/events/:eventId/email-logs - List all email logs for event
  app.get<{
    Params: { eventId: string };
    Querystring: ListEventEmailLogsQuery;
  }>(
    '/:eventId/email-logs',
    {
      schema: {
        params: EventIdParamSchema,
        querystring: ListEventEmailLogsQuerySchema,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const query = request.query;

      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound('Event not found');
      }

      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden('Insufficient permissions');
      }

      const result = await listEventEmailLogs(eventId, query);
      return reply.send(result);
    }
  );

  // ==========================================================================
  // BULK EMAIL SEND (Simple - no campaigns)
  // ==========================================================================

  // POST /api/events/:eventId/email-templates/:templateId/send - Send to recipients
  app.post<{
    Params: { eventId: string; templateId: string };
    Body: BulkSendEmailInput;
  }>(
    '/:eventId/email-templates/:templateId/send',
    {
      config: { rateLimit: publicRateLimits.emailBulkSend },
      schema: {
        params: EventIdParamSchema.extend({
          templateId: EmailTemplateIdParamSchema.shape.templateId,
        }),
        body: BulkSendEmailSchema,
      },
    },
    async (request, reply) => {
      const { eventId, templateId } = request.params;
      const { audience, registrationIds, filters } = request.body;

      // Verify event access
      const event = await getEventById(eventId);
      if (!event) {
        throw app.httpErrors.notFound('Event not found');
      }

      if (!canAccessClient(request.user!, event.clientId)) {
        throw app.httpErrors.forbidden('Insufficient permissions');
      }

      // Verify template exists and belongs to this event/client
      const template = await getEmailTemplateById(templateId);
      if (!template) {
        throw app.httpErrors.notFound('Email template not found');
      }

      if (template.clientId !== event.clientId) {
        throw app.httpErrors.forbidden('Template does not belong to this client');
      }

      // ── Sponsor audience ──────────────────────────────────────────────
      if (audience === 'sponsors') {
        const [batches, client] = await Promise.all([
          prisma.sponsorshipBatch.findMany({
            where: { eventId },
            orderBy: { createdAt: 'desc' },
            select: {
              labName: true,
              contactName: true,
              email: true,
              phone: true,
              sponsorships: {
                select: { beneficiaryName: true, beneficiaryEmail: true, totalAmount: true },
              },
            },
          }),
          prisma.client.findUnique({
            where: { id: event.clientId },
            select: { name: true },
          }),
        ]);

        // Deduplicate by email — keep first (most recent due to orderBy)
        const seen = new Map<string, typeof batches[number]>();
        for (const batch of batches) {
          const key = batch.email.toLowerCase();
          if (!seen.has(key)) seen.set(key, batch);
        }

        const sponsors = [...seen.values()].map((batch) => {
          const context = buildBatchEmailContext({
            batch,
            sponsorships: batch.sponsorships,
            event: { name: event.name, startDate: event.startDate, location: event.location, client: { name: client?.name || '' } },
            currency: event.pricing?.currency ?? 'TND',
          });
          return {
            email: batch.email,
            recipientName: batch.contactName,
            contextSnapshot: context as Record<string, unknown>,
          };
        });

        if (sponsors.length === 0) {
          return reply.send({ success: true, queued: 0, message: 'No sponsors found for this event' });
        }

        const queued = await queueBulkSponsorEmails(templateId, sponsors);
        return reply.send({ success: true, queued, message: `${queued} emails queued for sending` });
      }

      // ── Registrant audience ───────────────────────────────────────────
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
        // Send based on filters (empty filters = all registrants)
        registrations = await prisma.registration.findMany({
          where: {
            eventId,
            ...(filters?.paymentStatus && { paymentStatus: { in: filters.paymentStatus } }),
            ...(filters?.accessTypeIds && filters.accessTypeIds.length > 0 && {
              accessTypeIds: { hasSome: filters.accessTypeIds },
            }),
            ...(filters?.role && filters.role.length > 0 && {
              role: { in: filters.role },
            }),
          },
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
          message: 'No recipients matched the criteria',
        });
      }

      // Queue emails
      const queued = await queueBulkEmails(templateId, registrations);

      return reply.send({
        success: true,
        queued,
        message: `${queued} emails queued for sending`,
      });
    }
  );
}
