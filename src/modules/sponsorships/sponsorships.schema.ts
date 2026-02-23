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
