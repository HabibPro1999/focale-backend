import { z } from "zod";
import { StoredPricingRulesSchema } from "./pricing";

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
