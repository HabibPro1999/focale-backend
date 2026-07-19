import { z } from "zod";

// Ported verbatim from legacy src/modules/sponsorships/sponsorships.schema.ts.
// Every object is z.strictObject (unknown keys -> 400) exactly as the legacy
// Fastify schema validation behaved.

const hasUpdateField = (data: Record<string, unknown>) =>
  Object.values(data).some((value) => value !== undefined);

// ============================================================================
// Enums
// ============================================================================

export const SponsorshipStatusSchema = z.enum(["PENDING", "USED", "CANCELLED"]);
export type SponsorshipStatus = z.infer<typeof SponsorshipStatusSchema>;

// ============================================================================
// Beneficiary Input (CODE mode)
// ============================================================================

export const BeneficiaryInputSchema = z
  .strictObject({
    name: z.string().min(2).max(200),
    email: z.string().email(),
    phone: z.string().max(50).optional(),
    address: z.string().max(500).optional(),
    coversBasePrice: z.boolean(),
    coveredAccessIds: z.array(z.string().uuid()).default([]),
  })
  .refine((data) => data.coversBasePrice || data.coveredAccessIds.length > 0, {
    message: "Must cover at least base price or one access item",
  });

export type BeneficiaryInput = z.infer<typeof BeneficiaryInputSchema>;

// ============================================================================
// Linked Beneficiary Input (LINKED_ACCOUNT mode)
// ============================================================================

export const LinkedBeneficiaryInputSchema = z
  .strictObject({
    registrationId: z.string().uuid(),
    coversBasePrice: z.boolean(),
    coveredAccessIds: z.array(z.string().uuid()).default([]),
  })
  .refine((data) => data.coversBasePrice || data.coveredAccessIds.length > 0, {
    message: "Must cover base price or at least one access item",
  });

export type LinkedBeneficiaryInput = z.infer<typeof LinkedBeneficiaryInputSchema>;

// ============================================================================
// Sponsor Info
// ============================================================================

export const SponsorInfoSchema = z.strictObject({
  labName: z.string().min(2).max(200),
  contactName: z.string().min(2).max(200),
  email: z.string().email(),
  phone: z.string().max(50).optional(),
});

export type SponsorInfo = z.infer<typeof SponsorInfoSchema>;

// ============================================================================
// Create Sponsorship Batch (Public form submission)
// ============================================================================

export const CreateSponsorshipBatchSchema = z
  .strictObject({
    sponsor: SponsorInfoSchema,
    // ponytail: accepted for legacy parity only — the form app always sends it
    // and the legacy backend accepted-and-ignored it (no idempotency handling).
    // Upgrade path: dedupe on it like registrations' idempotencyKey.
    idempotencyKey: z.string().uuid().optional(),
    customFields: z.record(z.string(), z.unknown()).optional(),
    beneficiaries: z.array(BeneficiaryInputSchema).max(100).optional(), // CODE mode
    linkedBeneficiaries: z
      .array(LinkedBeneficiaryInputSchema)
      .max(100)
      .optional(), // LINKED_ACCOUNT mode
  })
  .superRefine((data, ctx) => {
    const hasBeneficiaries = (data.beneficiaries?.length ?? 0) > 0;
    const hasLinkedBeneficiaries = (data.linkedBeneficiaries?.length ?? 0) > 0;

    if (!hasBeneficiaries && !hasLinkedBeneficiaries) {
      ctx.addIssue({
        code: "custom",
        message: "Must have at least one beneficiary or linked beneficiary",
      });
      return;
    }

    if (hasBeneficiaries && hasLinkedBeneficiaries) {
      ctx.addIssue({
        code: "custom",
        message:
          "Provide either beneficiaries or linked beneficiaries, not both",
      });
    }
  });

export type CreateSponsorshipBatchInput = z.infer<
  typeof CreateSponsorshipBatchSchema
>;

// ============================================================================
// Update Sponsorship (Admin)
// ============================================================================

export const UpdateSponsorshipSchema = z
  .strictObject({
    beneficiaryName: z.string().min(2).max(200).optional(),
    beneficiaryEmail: z.string().email().optional(),
    beneficiaryPhone: z.string().max(50).optional().nullable(),
    beneficiaryAddress: z.string().max(500).optional().nullable(),
    coversBasePrice: z.boolean().optional(),
    coveredAccessIds: z.array(z.string().uuid()).optional(),
    status: z.literal("CANCELLED").optional(),
  })
  .refine(hasUpdateField, {
    message: "At least one field must be provided for update",
  })
  .refine(
    (data) => {
      if (
        data.coversBasePrice !== undefined &&
        data.coveredAccessIds !== undefined
      ) {
        return data.coversBasePrice || data.coveredAccessIds.length > 0;
      }
      return true;
    },
    { message: "Must cover at least base price or one access item" },
  );

export type UpdateSponsorshipInput = z.infer<typeof UpdateSponsorshipSchema>;

// ============================================================================
// List Sponsorships Query (Admin)
// ============================================================================

export const ListSponsorshipsQuerySchema = z.strictObject({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: SponsorshipStatusSchema.optional(),
  search: z.string().max(100).optional(),
  sortBy: z
    .enum(["createdAt", "totalAmount", "beneficiaryName"])
    .default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type ListSponsorshipsQuery = z.infer<typeof ListSponsorshipsQuerySchema>;

// ============================================================================
// Link Sponsorship (Admin - by ID)
// ============================================================================

export const LinkSponsorshipSchema = z.strictObject({
  sponsorshipId: z.string().uuid(),
});

export type LinkSponsorshipInput = z.infer<typeof LinkSponsorshipSchema>;

// ============================================================================
// Link Sponsorship by Code (Admin) — uppercase/trim/prefix SP- normalization
// ============================================================================

export const LinkSponsorshipByCodeSchema = z.strictObject({
  code: z
    .string()
    .min(4)
    .max(10)
    .transform((val) => {
      const upper = val.toUpperCase().trim();
      return upper.startsWith("SP-") ? upper : `SP-${upper}`;
    }),
});

export type LinkSponsorshipByCodeInput = z.infer<
  typeof LinkSponsorshipByCodeSchema
>;

// ============================================================================
// Registrant search (public, by slug) — locally-defined legacy schemas
// ============================================================================

export const SponsorshipEventSlugParamSchema = z.strictObject({
  slug: z.string().min(1).max(100),
});

export const RegistrantSearchQuerySchema = z.strictObject({
  query: z.string().trim().min(2).max(200),
  unpaidOnly: z.string().optional(),
});

// ============================================================================
// Parameter Schemas
// ============================================================================

export const SponsorshipIdParamSchema = z.strictObject({
  id: z.string().uuid(),
});

export const SponsorshipEventIdParamSchema = z.strictObject({
  eventId: z.string().uuid(),
});

export const RegistrationIdParamSchema = z.strictObject({
  registrationId: z.string().uuid(),
});

export const RegistrationSponsorshipParamSchema = z.strictObject({
  registrationId: z.string().uuid(),
  sponsorshipId: z.string().uuid(),
});

// ============================================================================
// Cross-module result types (shape of HTTP responses / linking results)
// ============================================================================

export interface SponsorshipStats {
  total: number;
  totalAmount: number;
  pending: { count: number; amount: number };
  used: { count: number; amount: number };
  cancelled: { count: number; amount: number };
}

export interface LinkSponsorshipResult {
  usage: {
    id: string;
    sponsorshipId: string;
    amountApplied: number;
  };
  registration: {
    totalAmount: number;
    sponsorshipAmount: number;
    amountDue: number;
  };
  warnings: string[];
}

export interface AvailableSponsorship {
  id: string;
  code: string;
  beneficiaryName: string;
  beneficiaryEmail: string;
  totalAmount: number;
  coversBasePrice: boolean;
  coveredAccessIds: string[];
  batch: { labName: string };
  applicableAmount: number;
  conflicts: string[];
}

export interface CreateBatchResult {
  batchId: string;
  count: number;
}
