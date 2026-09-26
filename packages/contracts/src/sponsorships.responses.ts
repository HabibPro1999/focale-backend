import { z } from "zod";
import { SponsorshipStatusSchema } from "./sponsorships";

// ============================================================================
// Response contracts (plan 5.5): the `data` payload of each sponsorship
// route. The API projects every response onto its contract, so a field that
// is not listed here never leaves the server. Dates are `Date` objects on the
// server and ISO 8601 strings on the wire.
// ============================================================================

const PaginationMetaSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
  hasNext: z.boolean(),
  hasPrev: z.boolean(),
});

// ============================================================================
// Public (sponsor form) routes
// ============================================================================

/**
 * POST /api/public/events/:eventId/sponsorships and
 * POST /api/public/events/slug/:slug/sponsorships.
 */
export const SponsorshipBatchCreatedResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  batchId: z.string(),
  count: z.number(),
});

/**
 * GET /api/public/events/slug/:slug/registrants/search (anonymous): no phone,
 * no form answers, masked email (0.5).
 */
export const PublicRegistrantSearchResponseSchema = z.array(
  z.object({
    id: z.string(),
    email: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    paymentStatus: z.string(),
    totalAmount: z.number(),
    baseAmount: z.number(),
    accessAmount: z.number(),
    sponsorshipAmount: z.number(),
    accessTypeIds: z.array(z.string()),
    coveredAccessIds: z.array(z.string()),
    isBasePriceCovered: z.boolean(),
  }),
);

// ============================================================================
// Admin routes
// ============================================================================

/** Every sponsorship column. */
const SponsorshipRowShape = {
  id: z.string(),
  batchId: z.string(),
  eventId: z.string(),
  code: z.string(),
  status: SponsorshipStatusSchema,
  beneficiaryName: z.string(),
  beneficiaryEmail: z.string(),
  beneficiaryPhone: z.string().nullable(),
  beneficiaryAddress: z.string().nullable(),
  coversBasePrice: z.boolean(),
  coveredAccessIds: z.array(z.string()).nullable(),
  totalAmount: z.number(),
  targetRegistrationId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
};

const SponsorshipStatBucketSchema = z.object({
  count: z.number(),
  amount: z.number(),
});

/** GET /api/events/:eventId/sponsorships. */
export const SponsorshipListResponseSchema = z.object({
  data: z.array(
    z.object({
      ...SponsorshipRowShape,
      batch: z.object({
        id: z.string(),
        labName: z.string(),
        contactName: z.string(),
        email: z.string(),
      }),
      usages: z.array(
        z.object({
          registrationId: z.string().nullable(),
          amountApplied: z.number(),
        }),
      ),
    }),
  ),
  meta: PaginationMetaSchema,
  stats: z.object({
    total: z.number(),
    totalAmount: z.number(),
    pending: SponsorshipStatBucketSchema,
    used: SponsorshipStatBucketSchema,
    cancelled: SponsorshipStatBucketSchema,
  }),
});

/**
 * GET /api/sponsorships/:id and PATCH /api/sponsorships/:id: the sponsorship
 * with its batch (sponsor contact and form answers), usages and covered
 * access items.
 */
export const SponsorshipDetailResponseSchema = z.object({
  ...SponsorshipRowShape,
  event: z.object({ clientId: z.string() }),
  batch: z.object({
    id: z.string(),
    eventId: z.string(),
    formId: z.string(),
    labName: z.string(),
    contactName: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
    formData: z.unknown(),
    createdAt: z.date(),
  }),
  usages: z.array(
    z.object({
      id: z.string(),
      sponsorshipId: z.string(),
      registrationId: z.string().nullable(),
      amountApplied: z.number(),
      appliedAt: z.date(),
      appliedBy: z.string(),
      registration: z
        .object({
          id: z.string(),
          email: z.string(),
          firstName: z.string().nullable(),
          lastName: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  coveredAccessItems: z.array(
    z.object({ id: z.string(), name: z.string(), price: z.number() }),
  ),
});

/**
 * DELETE /api/sponsorships/:id and
 * DELETE /api/registrations/:registrationId/sponsorships/:sponsorshipId.
 */
export const SponsorshipSuccessResponseSchema = z.object({
  success: z.boolean(),
});

/** GET /api/registrations/:registrationId/available-sponsorships. */
export const AvailableSponsorshipsResponseSchema = z.object({
  sponsorships: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      beneficiaryName: z.string(),
      beneficiaryEmail: z.string(),
      totalAmount: z.number(),
      coversBasePrice: z.boolean(),
      coveredAccessIds: z.array(z.string()),
      batch: z.object({ labName: z.string() }),
      applicableAmount: z.number(),
      conflicts: z.array(z.string()),
    }),
  ),
});

/** GET /api/registrations/:registrationId/sponsorships. */
export const LinkedSponsorshipsResponseSchema = z.array(
  z.object({
    id: z.string(),
    code: z.string(),
    status: z.string(),
    beneficiaryName: z.string(),
    beneficiaryEmail: z.string(),
    coversBasePrice: z.boolean(),
    coveredAccessIds: z.array(z.string()),
    totalAmount: z.number(),
    batch: z.object({
      id: z.string(),
      labName: z.string(),
      contactName: z.string(),
      email: z.string(),
    }),
    usage: z.object({
      id: z.string(),
      amountApplied: z.number(),
      appliedAt: z.date(),
    }),
  }),
);

/**
 * POST /api/registrations/:registrationId/sponsorships and
 * POST /api/registrations/:registrationId/sponsorships/by-code.
 */
export const SponsorshipLinkedResponseSchema = z.object({
  success: z.boolean(),
  usage: z.object({
    id: z.string(),
    sponsorshipId: z.string(),
    amountApplied: z.number(),
  }),
  registration: z.object({
    totalAmount: z.number(),
    sponsorshipAmount: z.number(),
    amountDue: z.number(),
  }),
  warnings: z.array(z.string()),
});
