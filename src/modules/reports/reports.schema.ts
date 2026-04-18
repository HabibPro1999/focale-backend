// ============================================================================
// Reports Module - Zod Schemas
// ============================================================================

import { z } from "zod";

// ============================================================================
// Query Schemas
// ============================================================================

export const ReportQuerySchema = z.strictObject({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export const ExportQuerySchema = z.strictObject({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  format: z.enum(["csv", "json", "xlsx"]).default("csv"),
});

export const ExportRegistrationsQuerySchema = z.strictObject({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  format: z.enum(["csv", "json", "xlsx"]).default("csv"),
  paymentStatus: z.enum(["PENDING", "VERIFYING", "PARTIAL", "PAID", "SPONSORED", "WAIVED", "REFUNDED"]).optional(),
  paymentMethod: z.enum(["BANK_TRANSFER", "ONLINE", "CASH", "LAB_SPONSORSHIP"]).optional(),
  search: z.string().max(200).optional(),
});

export const ExportSponsorshipsQuerySchema = z.strictObject({
  status: z.enum(["PENDING", "USED", "CANCELLED"]).optional(),
  search: z.string().max(100).optional(),
});

// ============================================================================
// Modular Registrations Export — POST body
// ============================================================================

export const IdentityFieldSchema = z.enum([
  "id",
  "referenceNumber",
  "email",
  "firstName",
  "lastName",
  "phone",
  "role",
  "note",
]);

export const SubmissionFieldSchema = z.enum([
  "submittedAt",
  "createdAt",
  "updatedAt",
  "lastEditedAt",
  "formSchemaVersion",
]);

export const PaymentFieldSchema = z.enum([
  "paymentStatus",
  "paymentMethod",
  "currency",
  "totalAmount",
  "paidAmount",
  "baseAmount",
  "accessAmount",
  "discountAmount",
  "sponsorshipAmount",
  "paymentReference",
  "paymentProofUrl",
  "paidAt",
]);

export const SponsorshipFieldSchema = z.enum([
  "sponsorshipCode",
  "labName",
  "labContactName",
  "labEmail",
  "labPhone",
  "beneficiaryAddress",
]);

export const ExportLanguageSchema = z.enum(["fr", "en", "ar"]);

export const ExportRegistrationsBodySchema = z.strictObject({
  filters: z
    .strictObject({
      search: z.string().max(200).optional(),
      paymentStatus: z
        .enum([
          "PENDING",
          "VERIFYING",
          "PARTIAL",
          "PAID",
          "SPONSORED",
          "WAIVED",
          "REFUNDED",
        ])
        .optional(),
      paymentMethod: z
        .enum(["BANK_TRANSFER", "ONLINE", "CASH", "LAB_SPONSORSHIP"])
        .optional(),
      startDate: z.string().datetime().optional(),
      endDate: z.string().datetime().optional(),
    })
    .default({}),
  columns: z.strictObject({
    identity: z.array(IdentityFieldSchema).default([]),
    submission: z.array(SubmissionFieldSchema).default([]),
    payment: z.array(PaymentFieldSchema).default([]),
    sponsorship: z.array(SponsorshipFieldSchema).default([]),
    accessItemIds: z.array(z.string().uuid()).default([]),
    checkinAccessIds: z.array(z.string().uuid()).default([]),
    includeGlobalCheckin: z.boolean().default(false),
    includeTransactions: z.boolean().default(false),
    includeDroppedAccess: z.boolean().default(false),
    formFieldIds: z.array(z.string()).default([]),
  }),
  language: ExportLanguageSchema.default("fr"),
});

// ============================================================================
// Response Schemas
// ============================================================================

// Per-currency breakdown for accurate multi-currency reporting
export const CurrencySummarySchema = z.object({
  currency: z.string(),
  totalRevenue: z.number(),
  totalPending: z.number(),
  totalRefunded: z.number(),
  registrationCount: z.number(),
  breakdown: z.object({
    base: z.number(),
    access: z.number(),
    discount: z.number(),
    sponsorship: z.number(),
  }),
});

export const FinancialSummarySchema = z.object({
  // Aggregated totals (primary currency or single currency events)
  totalRevenue: z.number(),
  totalPending: z.number(),
  totalRefunded: z.number(),
  averageRegistrationValue: z.number(),
  baseRevenue: z.number(),
  accessRevenue: z.number(),
  discountsGiven: z.number(),
  sponsorshipsApplied: z.number(),
  registrationCount: z.number(),
  // Per-currency breakdown for multi-currency events
  primaryCurrency: z.string(),
  currencies: z.array(CurrencySummarySchema),
});

export const PaymentStatusBreakdownItemSchema = z.object({
  paymentStatus: z.string(),
  count: z.number(),
  totalAmount: z.number(),
});

export const AccessBreakdownItemSchema = z.object({
  accessType: z.string(),
  count: z.number(),
  totalAmount: z.number(),
});

export const DailyTrendItemSchema = z.object({
  date: z.string(),
  count: z.number(),
  totalAmount: z.number(),
});

export const FinancialReportResponseSchema = z.object({
  eventId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  dateRange: z.object({
    startDate: z.string().datetime().nullable(),
    endDate: z.string().datetime().nullable(),
  }),
  summary: FinancialSummarySchema,
  byPaymentStatus: z.array(PaymentStatusBreakdownItemSchema),
  byAccessType: z.array(AccessBreakdownItemSchema),
  dailyTrend: z.array(DailyTrendItemSchema),
});

// ============================================================================
// Type Exports
// ============================================================================

export type ReportQuery = z.infer<typeof ReportQuerySchema>;
export type ExportQuery = z.infer<typeof ExportQuerySchema>;
export type ExportRegistrationsQuery = z.infer<typeof ExportRegistrationsQuerySchema>;
export type ExportSponsorshipsQuery = z.infer<typeof ExportSponsorshipsQuerySchema>;
export type ExportRegistrationsBody = z.infer<typeof ExportRegistrationsBodySchema>;
export type IdentityField = z.infer<typeof IdentityFieldSchema>;
export type SubmissionField = z.infer<typeof SubmissionFieldSchema>;
export type PaymentField = z.infer<typeof PaymentFieldSchema>;
export type SponsorshipField = z.infer<typeof SponsorshipFieldSchema>;
export type ExportLanguage = z.infer<typeof ExportLanguageSchema>;
export type CurrencySummary = z.infer<typeof CurrencySummarySchema>;
export type FinancialSummary = z.infer<typeof FinancialSummarySchema>;
export type PaymentStatusBreakdownItem = z.infer<
  typeof PaymentStatusBreakdownItemSchema
>;
export type AccessBreakdownItem = z.infer<typeof AccessBreakdownItemSchema>;
export type DailyTrendItem = z.infer<typeof DailyTrendItemSchema>;
export type FinancialReportResponse = z.infer<
  typeof FinancialReportResponseSchema
>;
