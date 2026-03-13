import { getGroupedAccess, validateAccessSelections } from './access.service.js';
import {
  EventIdParamSchema,
  GetGroupedAccessBodySchema,
  ValidateAccessSelectionsBodySchema,
  type GetGroupedAccessBody,
  type ValidateAccessSelectionsBody,
} from './access.schema.js';
import type { AppInstance } from '@shared/types/fastify.js';

// ============================================================================
// Public Routes (No Auth)
// ============================================================================

export async function accessPublicRoutes(app: AppInstance): Promise<void> {
  // POST /api/public/events/:eventId/access/grouped - Get grouped access items
  // Using POST because we need to send formData and selectedAccessIds in the body
  app.post<{
    Params: { eventId: string };
    Body: GetGroupedAccessBody;
  }>(
    '/:eventId/access/grouped',
    {
      schema: {
        params: EventIdParamSchema,
        body: GetGroupedAccessBodySchema,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const { formData, selectedAccessIds } = request.body;

      const grouped = await getGroupedAccess(eventId, formData, selectedAccessIds);
      return reply.send(grouped);
    }
  );

  // POST /api/public/events/:eventId/access/validate - Validate selections
  app.post<{
    Params: { eventId: string };
    Body: ValidateAccessSelectionsBody;
  }>(
    '/:eventId/access/validate',
    {
      schema: {
        params: EventIdParamSchema,
        body: ValidateAccessSelectionsBodySchema,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const { formData, selections } = request.body;

      const result = await validateAccessSelections(eventId, selections, formData);
      return reply.send(result);
    }
  );

  // GET /api/public/events/:eventId/payment-config - Get event payment configuration
  app.get<{ Params: { eventId: string } }>(
    '/:eventId/payment-config',
    {
      schema: { params: EventIdParamSchema },
    },
    async (request, reply) => {
      const { eventId } = request.params;

      // Fetch event with pricing and client in one query
      const event = await app.prisma.event.findUnique({
        where: { id: eventId },
        include: {
          pricing: true,
          client: {
            select: {
              id: true,
              name: true,
              logo: true,
              primaryColor: true,
            },
          },
        },
      });

      if (!event) {
        throw app.httpErrors.notFound('Event not found');
      }

      // Transform pricing for public consumption
      const pricing = event.pricing;
      const paymentMethods: string[] = ['BANK_TRANSFER']; // Bank transfer always available
      if (pricing?.onlinePaymentEnabled && pricing?.onlinePaymentUrl) {
        paymentMethods.push('ONLINE');
      }

      return reply.send({
        event: {
          id: event.id,
          name: event.name,
          slug: event.slug,
          status: event.status,
          startDate: event.startDate,
          endDate: event.endDate,
          location: event.location,
          client: event.client,
        },
        pricing: pricing
          ? {
              basePrice: pricing.basePrice,
              currency: pricing.currency,
              rules: pricing.rules ?? [],
              paymentMethods,
              bankDetails: pricing.bankName
                ? {
                    bankName: pricing.bankName,
                    accountName: pricing.bankAccountName ?? '',
                    iban: pricing.bankAccountNumber ?? '',
                    bic: '',
                  }
                : null,
              onlinePaymentUrl: pricing.onlinePaymentUrl ?? null,
            }
          : null,
      });
    }
  );
}
