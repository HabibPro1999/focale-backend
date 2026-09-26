import { z } from "zod";
import { EventAccessRowResponseSchema } from "./access";

// ============================================================================
// Response contracts (plan 5.5) for the public form routes. These routes used
// to return whole database rows (form, event, pricing, access items), so any
// new column became public; now only the columns listed here are returned.
// Dates are `Date` objects on the server and ISO 8601 strings on the wire.
// The form `schema`, `successTranslations`, pricing `rules` and access
// `conditions` are stored JSON documents and stay opaque (plan 5.2).
// ============================================================================

const EventStatusSchema = z.enum(["CLOSED", "OPEN", "ARCHIVED"]);

/** The organizer (client) fields a public page shows. */
export const PublicClientResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  logo: z.string().nullable(),
  primaryColor: z.string().nullable(),
  phone: z.string().nullable(),
});

/** An event's pricing row (every column). */
export const EventPricingRowResponseSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  basePrice: z.number(),
  currency: z.string(),
  rules: z.unknown(),
  onlinePaymentEnabled: z.boolean(),
  onlinePaymentUrl: z.string().nullable(),
  cashPaymentEnabled: z.boolean(),
  bankName: z.string().nullable(),
  bankAccountName: z.string().nullable(),
  bankAccountNumber: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

/** GET /api/forms/public/:slug: the published registration form of an open event. */
export const PublicFormResponseSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  type: z.enum(["REGISTRATION", "SPONSOR"]),
  name: z.string(),
  schema: z.unknown(),
  schemaVersion: z.number(),
  successTitle: z.string().nullable(),
  successMessage: z.string().nullable(),
  successTranslations: z.unknown(),
  active: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
  event: z.object({
    id: z.string(),
    clientId: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    maxCapacity: z.number().nullable(),
    registeredCount: z.number(),
    startDate: z.date(),
    endDate: z.date(),
    location: z.string().nullable(),
    status: EventStatusSchema,
    bannerUrl: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
    client: PublicClientResponseSchema,
    pricing: EventPricingRowResponseSchema.nullable(),
    access: z.array(EventAccessRowResponseSchema),
  }),
});

/** GET /api/forms/public/:slug/sponsor: the sponsor form of an open event. */
export const PublicSponsorFormResponseSchema = z.object({
  id: z.string(),
  /** Same as `id`, kept for older form-app builds. */
  formId: z.string(),
  eventId: z.string(),
  schemaVersion: z.number(),
  schema: z.unknown(),
  event: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    status: EventStatusSchema,
    startsAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    location: z.string().nullable(),
    bannerUrl: z.string().nullable(),
    client: PublicClientResponseSchema,
  }),
  pricing: EventPricingRowResponseSchema.nullable(),
  accessItems: z.array(EventAccessRowResponseSchema),
});
