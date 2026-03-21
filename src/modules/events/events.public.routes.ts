import { prisma } from "@/database/client.js";
import { EventIdParamSchema } from "./events.schema.js";
import type { AppInstance } from "@shared/types/fastify.js";

// ============================================================================
// Public Routes (No Auth)
// ============================================================================

export async function eventsPublicRoutes(app: AppInstance): Promise<void> {
  // GET /api/public/events/:eventId/payment-config - Get event payment configuration
  app.get<{ Params: { id: string } }>(
    "/:id/payment-config",
    {
      schema: { params: EventIdParamSchema },
    },
    async (request, reply) => {
      const { id: eventId } = request.params;

      // Fetch event with pricing and client in one query
      const event = await prisma.event.findUnique({
        where: { id: eventId },
        include: {
          pricing: true,
          client: {
            select: {
              id: true,
              name: true,
              logo: true,
              primaryColor: true,
              enabledModules: true,
            },
          },
        },
      });

      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }

      // Transform pricing for public consumption
      const pricing = event.pricing;
      const paymentMethods: string[] = ["BANK_TRANSFER"]; // Bank transfer always available
      if (pricing?.onlinePaymentEnabled && pricing?.onlinePaymentUrl) {
        paymentMethods.push("ONLINE");
      }
      if (pricing?.cashPaymentEnabled) {
        paymentMethods.push("CASH");
      }

      // Check if sponsorships module is enabled for the client
      const enabledModules = event.client.enabledModules as string[];
      const sponsorshipsEnabled = enabledModules.includes("sponsorships");

      // Lab sponsorship option available when sponsorships module is disabled
      if (!sponsorshipsEnabled) {
        paymentMethods.push("LAB_SPONSORSHIP");
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
        sponsorshipsEnabled,
        pricing: pricing
          ? {
              basePrice: pricing.basePrice,
              currency: pricing.currency,
              rules: pricing.rules ?? [],
              paymentMethods,
              bankDetails: pricing.bankName
                ? {
                    bankName: pricing.bankName,
                    accountName: pricing.bankAccountName ?? "",
                    iban: pricing.bankAccountNumber ?? "",
                    bic: "",
                  }
                : null,
              onlinePaymentUrl: pricing.onlinePaymentUrl ?? null,
            }
          : null,
      });
    },
  );
}
