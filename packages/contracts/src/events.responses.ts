import { z } from "zod";
import { StoredPricingRulesSchema } from "./pricing";

/** GET /api/events metadata; totals must never leak PostgreSQL INT8 strings. */
export const EventListPaginationMetaSchema = z.object({
  page: z.number().int().min(1), limit: z.number().int().min(1),
  total: z.number().int().min(0), totalPages: z.number().int().min(0),
  hasNext: z.boolean(), hasPrev: z.boolean(),
});

export const EventListRowResponseSchema = z.object({
  id: z.string(), clientId: z.string(), name: z.string(), slug: z.string(),
  description: z.string().nullable(), maxCapacity: z.number().nullable(), registeredCount: z.number(),
  startDate: z.date(), endDate: z.date(), location: z.string().nullable(),
  status: z.enum(["OPEN", "CLOSED", "ARCHIVED"]), bannerUrl: z.string().nullable(),
  createdAt: z.date(), updatedAt: z.date(), client: z.object({ id: z.string(), name: z.string() }),
});
export const EventListResponseSchema = z.object({ data: z.array(EventListRowResponseSchema), meta: EventListPaginationMetaSchema });

// ============================================================================
// Response contracts (plan 5.5) for the public event routes. Dates are `Date`
// objects on the server and ISO 8601 strings on the wire; pricing `rules` is
// the stored rules document (plan 5.2, StoredPricingRulesSchema).
// ============================================================================

/** GET /api/public/events/:id/payment-config. */
export const PublicPaymentConfigResponseSchema = z.object({
  event: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    status: z.string(),
    startDate: z.date(),
    endDate: z.date(),
    location: z.string().nullable(),
    bannerUrl: z.string().nullable(),
    client: z.object({
      id: z.string(),
      name: z.string(),
      logo: z.string().nullable(),
      primaryColor: z.string().nullable(),
      phone: z.string().nullable(),
    }),
  }),
  sponsorshipsEnabled: z.boolean(),
  pricing: z
    .object({
      basePrice: z.number(),
      currency: z.string(),
      rules: StoredPricingRulesSchema,
      paymentMethods: z.array(z.string()),
      bankDetails: z
        .object({
          bankName: z.string(),
          accountName: z.string(),
          iban: z.string(),
          bic: z.string(),
        })
        .nullable(),
      onlinePaymentUrl: z.string().nullable(),
    })
    .nullable(),
});
