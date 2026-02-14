import { z } from "zod";

// ============================================================================
// Enums
// ============================================================================

export const SponsorshipStatusSchema = z.enum(["PENDING", "USED", "CANCELLED"]);
export type SponsorshipStatus = z.infer<typeof SponsorshipStatusSchema>;

// ============================================================================
// Beneficiary Input Schema
// ============================================================================

export const BeneficiaryInputSchema = z
  .object({
    name: z.string().min(2).max(200),
    email: z.string().email(),
    phone: z.string().max(50).optional(),
    address: z.string().max(500).optional(),
    coversBasePrice: z.boolean(),
    coveredAccessIds: z.array(z.string().uuid()).default([]),
  })
  .strict()
  .refine((data) => data.coversBasePrice || data.coveredAccessIds.length > 0, {
    message: "Must cover at least base price or one access item",
  });

export type BeneficiaryInput = z.infer<typeof BeneficiaryInputSchema>;

// ============================================================================
// Linked Beneficiary Input Schema (for LINKED_ACCOUNT mode)
// ============================================================================

export const LinkedBeneficiaryInputSchema = z
  .object({
    registrationId: z.string().uuid(),
    email: z.string().email(),
    name: z.string().min(2).max(200),
    coversBasePrice: z.boolean(),
    coveredAccessIds: z.array(z.string().uuid()).default([]),
  })
  .strict()
  .refine((data) => data.coversBasePrice || data.coveredAccessIds.length > 0, {
    message: "Must cover base price or at least one access item",
  });

export type LinkedBeneficiaryInput = z.infer<
  typeof LinkedBeneficiaryInputSchema
>;

// ============================================================================
// Sponsor Info Schema
// ============================================================================

export const SponsorInfoSchema = z
  .object({
    labName: z.string().min(2).max(200),
    contactName: z.string().min(2).max(200),
    email: z.string().email(),
    phone: z.string().max(50).optional(),
  })
  .strict();

export type SponsorInfo = z.infer<typeof SponsorInfoSchema>;

// ============================================================================
// Create Sponsorship Batch Schema (Public - form submission)
// ============================================================================

export const CreateSponsorshipBatchSchema = z
  .object({
    sponsor: SponsorInfoSchema,
    customFields: z.record(z.string(), z.unknown()).optional(),
    beneficiaries: z.array(BeneficiaryInputSchema).max(100).optional(), // CODE mode
    linkedBeneficiaries: z
      .array(LinkedBeneficiaryInputSchema)
      .max(100)
      .optional(), // LINKED_ACCOUNT mode
  })
  .strict()
  .refine(
    (data) =>
      (data.beneficiaries?.length ?? 0) > 0 ||
      (data.linkedBeneficiaries?.length ?? 0) > 0,
    { message: "Must have at least one beneficiary or linked beneficiary" },
  )
  .refine(
    (data) =>
      !(
        (data.beneficiaries?.length ?? 0) > 0 &&
        (data.linkedBeneficiaries?.length ?? 0) > 0
      ),
    { message: "Cannot provide both beneficiaries and linkedBeneficiaries" },
  );

export type CreateSponsorshipBatchInput = z.infer<
  typeof CreateSponsorshipBatchSchema
>;

// ============================================================================
// Update Sponsorship Schema (Admin)
// ============================================================================

export const UpdateSponsorshipSchema = z
  .object({
    beneficiaryName: z.string().min(2).max(200).optional(),
    beneficiaryEmail: z.string().email().optional(),
    beneficiaryPhone: z.string().max(50).optional().nullable(),
    beneficiaryAddress: z.string().max(500).optional().nullable(),
    coversBasePrice: z.boolean().optional(),
    coveredAccessIds: z.array(z.string().uuid()).optional(),
    status: z.literal("CANCELLED").optional(),
  })
  .strict()
  .refine(
    (data) => {
      // If both coverage fields provided, at least one must be truthy
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
// List Sponsorships Query Schema (Admin)
// ============================================================================

export const ListSponsorshipsQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    status: SponsorshipStatusSchema.optional(),
    search: z.string().max(100).optional(),
    sortBy: z
      .enum(["createdAt", "totalAmount", "beneficiaryName"])
      .default("createdAt"),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();

export type ListSponsorshipsQuery = z.infer<typeof ListSponsorshipsQuerySchema>;

// ============================================================================
// Link Sponsorship Schema (Admin - by ID)
// ============================================================================

export const LinkSponsorshipSchema = z
  .object({
    sponsorshipId: z.string().uuid(),
  })
  .strict();

export type LinkSponsorshipInput = z.infer<typeof LinkSponsorshipSchema>;

// ============================================================================
// Link Sponsorship by Code Schema (Admin)
// ============================================================================

export const LinkSponsorshipByCodeSchema = z
  .object({
    code: z
      .string()
      .min(4)
      .max(10)
      .transform((val) => {
        // Normalize: uppercase, add prefix if missing
        const upper = val.toUpperCase().trim();
        return upper.startsWith("SP-") ? upper : `SP-${upper}`;
      })
      .pipe(
        z
          .string()
          .regex(/^SP-[A-HJ-NP-Z2-9]{4}$/, "Invalid sponsorship code format"),
      ),
  })
  .strict();

export type LinkSponsorshipByCodeInput = z.infer<
  typeof LinkSponsorshipByCodeSchema
>;

// ============================================================================
// Parameter Schemas
// ============================================================================

export const SponsorshipIdParamSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export const EventIdParamSchema = z
  .object({
    eventId: z.string().uuid(),
  })
  .strict();

export const RegistrationIdParamSchema = z
  .object({
    registrationId: z.string().uuid(),
  })
  .strict();

export const RegistrationSponsorshipParamSchema = z
  .object({
    registrationId: z.string().uuid(),
    sponsorshipId: z.string().uuid(),
  })
  .strict();
