import { z } from "zod";

// ============================================================================
// Request Schemas — ported ~verbatim from the legacy events.schema.ts
// (z.strictObject strictness, coercions, transforms, refinements preserved).
// ============================================================================

const BasePriceSchema = z.number().int().min(0).nullable();

const hasUpdateField = (data: Record<string, unknown>) =>
  Object.values(data).some((value) => value !== undefined);

const supportedCurrencies = new Set(
  (
    Intl as typeof Intl & {
      supportedValuesOf?: (key: "currency") => string[];
    }
  ).supportedValuesOf?.("currency") ?? ["TND", "EUR", "USD"],
);

const CurrencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine(
    (value) => /^[A-Z]{3}$/.test(value) && supportedCurrencies.has(value),
    "Currency must be a supported ISO 4217 code",
  );

export const CreateEventSchema = z
  .strictObject({
    clientId: z.string().uuid(),
    name: z.string().min(1).max(200),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(
        /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
        "Slug must be lowercase alphanumeric with hyphens, dots, or underscores",
      ),
    description: z.string().optional().nullable(),
    maxCapacity: z.number().int().positive().optional().nullable(),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    location: z.string().min(1).max(500).optional().nullable(),
    status: z.literal("CLOSED").optional().default("CLOSED"),
    // Pricing
    basePrice: BasePriceSchema.optional().default(0),
    currency: CurrencySchema.default("TND"),
  })
  .refine((data) => data.endDate >= data.startDate, {
    message: "End date must be greater than or equal to start date",
    path: ["endDate"],
  });

export const UpdateEventSchema = z
  .strictObject({
    name: z.string().min(1).max(200).optional(),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(
        /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
        "Slug must be lowercase alphanumeric with hyphens, dots, or underscores",
      )
      .optional(),
    description: z.string().optional().nullable(),
    maxCapacity: z.number().int().positive().optional().nullable(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    location: z.string().min(1).max(500).optional().nullable(),
    status: z.enum(["CLOSED", "OPEN", "ARCHIVED"]).optional(),
    // Pricing
    basePrice: BasePriceSchema.optional(),
    currency: CurrencySchema.optional(),
  })
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return data.endDate >= data.startDate;
      }
      return true;
    },
    {
      message: "End date must be greater than or equal to start date",
      path: ["endDate"],
    },
  )
  .refine(hasUpdateField, {
    message: "At least one field must be provided for update",
  });

export const ListEventsQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  clientId: z.string().uuid().optional(),
  status: z.enum(["CLOSED", "OPEN", "ARCHIVED"]).optional(),
  search: z.string().optional(),
});

export const EventIdParamSchema = z.strictObject({
  id: z.string().uuid(),
});

export const EventSlugParamSchema = z.strictObject({
  slug: z.string().min(1).max(100),
});

// ============================================================================
// Types
// ============================================================================

export type CreateEventInput = z.infer<typeof CreateEventSchema>;
export type UpdateEventInput = z.infer<typeof UpdateEventSchema>;
export type ListEventsQuery = z.infer<typeof ListEventsQuerySchema>;

/** Public payment-config response (GET /api/public/events/:id/payment-config). */
export interface PublicPaymentConfigResponse {
  event: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    status: string;
    startDate: Date;
    endDate: Date;
    location: string | null;
    bannerUrl: string | null;
    client: {
      id: string;
      name: string;
      logo: string | null;
      primaryColor: string | null;
    };
  };
  sponsorshipsEnabled: boolean;
  pricing: {
    basePrice: number;
    currency: string;
    rules: unknown;
    paymentMethods: string[];
    bankDetails: {
      bankName: string;
      accountName: string;
      iban: string;
      bic: string;
    } | null;
    onlinePaymentUrl: string | null;
  } | null;
}
