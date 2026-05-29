import { prisma } from "@/database/client.js";
import { publicRateLimits } from "@core/plugins.js";
import { isModuleEnabledForClient } from "@clients";
import { EventIdParamSchema } from "./events.schema.js";
import type { AppInstance } from "@shared/types/fastify.js";

// ============================================================================
// Public Routes (No Auth)
// ============================================================================

export async function eventsPublicRoutes(app: AppInstance): Promise<void> {
  // GET /api/public/events/:id/payment-config - Get event payment configuration
  app.get<{ Params: { id: string } }>(
    "/:id/payment-config",
    {
      schema: { params: EventIdParamSchema },
      config: { rateLimit: publicRateLimits.accessPublic },
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
              active: true,
              enabledModules: true,
            },
          },
        },
      });

      if (!event) {
        throw app.httpErrors.notFound("Event not found");
      }
      if (event.status !== "OPEN" || event.client.active !== true) {
        throw app.httpErrors.notFound("Event not found");
      }

      // Transform pricing for public consumption
      const pricing = event.pricing;
      const registrationsEnabled = isModuleEnabledForClient(
        event.client,
        "registrations",
      );
      const pricingEnabled = isModuleEnabledForClient(event.client, "pricing");
      const paymentMethods: string[] = [];
      const exposePaymentConfig =
        event.status === "OPEN" && registrationsEnabled && pricingEnabled;
      if (exposePaymentConfig) {
        paymentMethods.push("BANK_TRANSFER");
        if (pricing?.onlinePaymentEnabled && pricing.onlinePaymentUrl) {
          paymentMethods.push("ONLINE");
        }
        if (pricing?.cashPaymentEnabled) {
          paymentMethods.push("CASH");
        }
      }

      const sponsorshipsAvailableForActiveClient = isModuleEnabledForClient(
        event.client,
        "sponsorships",
      );

      // Lab sponsorship option available when sponsorships module is disabled
      if (exposePaymentConfig && !sponsorshipsAvailableForActiveClient) {
        paymentMethods.push("LAB_SPONSORSHIP");
      }

      return reply.send({
        event: {
          id: event.id,
          name: event.name,
          slug: event.slug,
          description: event.description,
          status: event.status,
          startDate: event.startDate,
          endDate: event.endDate,
          location: event.location,
          bannerUrl: event.bannerUrl,
          client: {
            id: event.client.id,
            name: event.client.name,
            logo: event.client.logo,
            primaryColor: event.client.primaryColor,
          },
        },
        sponsorshipsEnabled: sponsorshipsAvailableForActiveClient,
        pricing:
          pricing && pricingEnabled && registrationsEnabled
            ? {
                basePrice: pricing.basePrice,
                currency: pricing.currency,
                rules: pricing.rules ?? [],
                paymentMethods,
                bankDetails:
                  exposePaymentConfig && pricing.bankName
                    ? {
                        bankName: pricing.bankName,
                        accountName: pricing.bankAccountName ?? "",
                        iban: pricing.bankAccountNumber ?? "",
                        bic: "",
                      }
                    : null,
                onlinePaymentUrl: exposePaymentConfig
                  ? (pricing.onlinePaymentUrl ?? null)
                  : null,
              }
            : null,
      });
    },
  );
}
