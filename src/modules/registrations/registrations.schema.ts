import { z } from "zod";
import { AccessSelectionSchema } from "@access";

// ============================================================================
// Enums
// ============================================================================

export const PaymentStatusSchema = z.enum([
  "PENDING",
  "VERIFYING",
  "PAID",
  "REFUNDED",
  "WAIVED",
]);

export const PaymentMethodSchema = z.enum(["BANK_TRANSFER", "ONLINE", "CASH"]);

// ============================================================================
// Create Registration Schema (Public - for form submission)
// ============================================================================

export const CreateRegistrationSchema = z
  .object({
    formId: z.string().uuid(),
    formData: z.record(z.string(), z.any()),

    // Registrant info (extracted from formData for quick access)
    email: z.string().email(),
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    phone: z.string().max(50).optional(),

    // Access selections
    accessSelections: z.array(AccessSelectionSchema).optional().default([]),

    // Sponsorship
    sponsorshipCode: z.string().max(50).optional(),

    // Idempotency key for safe retries (prevents duplicate registrations)
    idempotencyKey: z.string().uuid().optional(),

    // Browser origin URL for email links (e.g., "https://summit.events.domain.com")
    linkBaseUrl: z.string().url().optional(),
  })
  .strict();

// ============================================================================
// Update Registration Schema (Admin)
// ============================================================================

export const UpdatePaymentSchema = z
  .object({
    paymentStatus: PaymentStatusSchema,
    paidAmount: z.number().int().min(0).optional(),
    paymentMethod: PaymentMethodSchema.optional(),
    paymentReference: z.string().max(200).optional(),
    paymentProofUrl: z.string().url().optional(),
  })
  .strict();

export const UpdateRegistrationSchema = z
  .object({
    paymentStatus: PaymentStatusSchema.optional(),
    paidAmount: z.number().int().min(0).optional(),
    paymentMethod: PaymentMethodSchema.optional(),
    paymentReference: z.string().max(200).optional(),
    paymentProofUrl: z.string().url().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();

// ============================================================================
// Query Schemas
// ============================================================================

export const ListRegistrationsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    paymentStatus: PaymentStatusSchema.optional(),
    search: z.string().max(200).optional(),
  })
  .strict();

export const RegistrationIdParamSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export const EventIdParamSchema = z
  .object({
    eventId: z.string().uuid(),
  })
  .strict();

export const FormIdParamSchema = z
  .object({
    formId: z.string().uuid(),
  })
  .strict();

// ============================================================================
// Public Edit Registration Schema (Self-Service)
// ============================================================================

export const PublicEditRegistrationSchema = z
  .object({
    // Form data updates (partial - only changed fields)
    formData: z.record(z.string(), z.any()).optional(),

    // Contact info updates
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    phone: z.string().max(50).optional(),
    // Note: email cannot be changed (it's the unique identifier)

    // Access selections (full replacement of current selections)
    accessSelections: z.array(AccessSelectionSchema).optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.formData !== undefined ||
      data.firstName !== undefined ||
      data.lastName !== undefined ||
      data.phone !== undefined ||
      data.accessSelections !== undefined,
    { message: "At least one field must be provided for update" },
  );

export const RegistrationIdPublicParamSchema = z
  .object({
    registrationId: z.string().uuid(),
  })
  .strict();

// ============================================================================
// Table Column Schemas (for dynamic table rendering)
// ============================================================================

export const TableColumnTypeSchema = z.enum([
  "text",
  "email",
  "phone",
  "number",
  "date",
  "datetime",
  "dropdown",
  "radio",
  "checkbox",
  "currency",
  "status",
  "payment",
  "file",
  "textarea",
]);

export const TableColumnOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
});

export const TableColumnSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: TableColumnTypeSchema,
  options: z.array(TableColumnOptionSchema).optional(),
});

export const RegistrationColumnsResponseSchema = z.object({
  formColumns: z.array(TableColumnSchema),
  fixedColumns: z.array(TableColumnSchema),
});

// ============================================================================
// Price Calculation Integration
// ============================================================================

export const PriceBreakdownSchema = z.object({
  basePrice: z.number(),
  appliedRules: z.array(
    z.object({
      ruleId: z.string(),
      ruleName: z.string(),
      effect: z.number(),
      reason: z.string().optional(),
    }),
  ),
  calculatedBasePrice: z.number(),
  accessItems: z.array(
    z.object({
      accessId: z.string(),
      name: z.any(),
      unitPrice: z.number(),
      quantity: z.number(),
      subtotal: z.number(),
    }),
  ),
  accessTotal: z.number(),
  subtotal: z.number(),
  sponsorships: z.array(
    z.object({
      code: z.string(),
      amount: z.number(),
      valid: z.boolean(),
    }),
  ),
  sponsorshipTotal: z.number(),
  total: z.number(),
  currency: z.string(),
});

// ============================================================================
// Types
// ============================================================================

export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;
export type CreateRegistrationInput = z.infer<typeof CreateRegistrationSchema>;
export type UpdateRegistrationInput = z.infer<typeof UpdateRegistrationSchema>;
export type UpdatePaymentInput = z.infer<typeof UpdatePaymentSchema>;
export type ListRegistrationsQuery = z.infer<
  typeof ListRegistrationsQuerySchema
>;
export type PriceBreakdown = z.infer<typeof PriceBreakdownSchema>;
export type PublicEditRegistrationInput = z.infer<
  typeof PublicEditRegistrationSchema
>;
export type TableColumnType = z.infer<typeof TableColumnTypeSchema>;
export type TableColumnOption = z.infer<typeof TableColumnOptionSchema>;
export type TableColumn = z.infer<typeof TableColumnSchema>;
export type RegistrationColumnsResponse = z.infer<
  typeof RegistrationColumnsResponseSchema
>;

// ============================================================================
// Audit Log Schemas
// ============================================================================

export const ListRegistrationAuditLogsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const AuditActionSchema = z.enum([
  "CREATE",
  "UPDATE",
  "DELETE",
  "PAYMENT_CONFIRMED",
  "PAYMENT_PROOF_UPLOADED",
]);

export const RegistrationAuditLogSchema = z.object({
  id: z.string(),
  action: AuditActionSchema,
  changes: z
    .record(
      z.string(),
      z.object({
        old: z.unknown().nullable(),
        new: z.unknown().nullable(),
      }),
    )
    .nullable(),
  performedBy: z.string().nullable(),
  performedByName: z.string().nullable(),
  performedAt: z.string(),
  ipAddress: z.string().nullable(),
});

export type ListRegistrationAuditLogsQuery = z.infer<
  typeof ListRegistrationAuditLogsQuerySchema
>;
export type AuditAction = z.infer<typeof AuditActionSchema>;
export type RegistrationAuditLog = z.infer<typeof RegistrationAuditLogSchema>;

// ============================================================================
// Email Log Schemas
// ============================================================================

export const ListRegistrationEmailLogsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const EmailStatusSchema = z.enum([
  "QUEUED",
  "SENDING",
  "SENT",
  "DELIVERED",
  "OPENED",
  "CLICKED",
  "BOUNCED",
  "DROPPED",
  "FAILED",
  "SKIPPED",
]);

export const AutomaticEmailTriggerSchema = z
  .enum([
    "REGISTRATION_CREATED",
    "PAYMENT_PROOF_SUBMITTED",
    "PAYMENT_CONFIRMED",
  ])
  .nullable();

export const RegistrationEmailLogSchema = z.object({
  id: z.string(),
  subject: z.string(),
  status: EmailStatusSchema,
  trigger: AutomaticEmailTriggerSchema,
  templateName: z.string().nullable(),
  errorMessage: z.string().nullable(),
  queuedAt: z.string(),
  sentAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  openedAt: z.string().nullable(),
  clickedAt: z.string().nullable(),
  bouncedAt: z.string().nullable(),
  failedAt: z.string().nullable(),
});

export type ListRegistrationEmailLogsQuery = z.infer<
  typeof ListRegistrationEmailLogsQuerySchema
>;
export type EmailStatus = z.infer<typeof EmailStatusSchema>;
export type AutomaticEmailTrigger = z.infer<typeof AutomaticEmailTriggerSchema>;
export type RegistrationEmailLog = z.infer<typeof RegistrationEmailLogSchema>;

// ============================================================================
// Registrant Search Schemas (for Linked Account Sponsorship)
// ============================================================================

export const SearchRegistrantsQuerySchema = z
  .object({
    query: z.string().min(1).max(200),
    unpaidOnly: z.coerce.boolean().optional().default(false),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();

export const RegistrantSearchResultSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  paymentStatus: PaymentStatusSchema,
  totalAmount: z.number(),
  originalAmount: z.number(),
  accessTypeIds: z.array(z.string()),
  phone: z.string().nullable(),
  formData: z.record(z.string(), z.unknown()).nullable(),
});

export type SearchRegistrantsQuery = z.infer<
  typeof SearchRegistrantsQuerySchema
>;
export type RegistrantSearchResult = z.infer<
  typeof RegistrantSearchResultSchema
>;
