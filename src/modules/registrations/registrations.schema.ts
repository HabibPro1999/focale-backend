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

export { EventIdParamSchema } from "@shared/schemas/params.js";

// ============================================================================
// Public Route Param Schemas
// ============================================================================

// Used by public routes — "formId" param name differs from shared FormIdParamSchema
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
    formData: z.record(z.string(), z.unknown()).optional(),

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
// Types
// ============================================================================

export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

// Plain TS types used by services (schemas are inlined in routes)
export type CreateRegistrationInput = {
  formId: string;
  formData: Record<string, unknown>;
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  accessSelections: Array<z.infer<typeof AccessSelectionSchema>>;
  sponsorshipCode?: string;
  idempotencyKey?: string;
  linkBaseUrl?: string;
};

export type UpdateRegistrationInput = {
  paymentStatus?: PaymentStatus;
  paidAmount?: number;
  paymentMethod?: PaymentMethod;
  paymentReference?: string;
  paymentProofUrl?: string;
  note?: string | null;
};

export type UpdatePaymentInput = {
  paymentStatus: PaymentStatus;
  paidAmount?: number;
  paymentMethod?: PaymentMethod;
  paymentReference?: string;
  paymentProofUrl?: string;
};

export type ListRegistrationsQuery = {
  page: number;
  limit: number;
  search?: string;
  paymentStatus?: PaymentStatus;
};

export type ListAllRegistrationsQuery = {
  page: number;
  limit: number;
  search?: string;
  eventId?: string;
  paymentStatus?: PaymentStatus;
};

export type PriceBreakdown = {
  basePrice: number;
  appliedRules: Array<{
    ruleId: string;
    ruleName: string;
    effect: number;
    reason?: string;
  }>;
  calculatedBasePrice: number;
  accessItems: Array<{
    accessId: string;
    name: string;
    unitPrice: number;
    quantity: number;
    subtotal: number;
  }>;
  accessTotal: number;
  subtotal: number;
  sponsorships: Array<{
    code: string;
    amount: number;
    valid: boolean;
  }>;
  sponsorshipTotal: number;
  total: number;
  currency: string;
};
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

export type ListRegistrationAuditLogsQuery = {
  page: number;
  limit: number;
};
export type AuditAction = z.infer<typeof AuditActionSchema>;
export type RegistrationAuditLog = z.infer<typeof RegistrationAuditLogSchema>;

// ============================================================================
// Email Log Schemas
// ============================================================================

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

export type ListRegistrationEmailLogsQuery = {
  page: number;
  limit: number;
};
export type EmailStatus = z.infer<typeof EmailStatusSchema>;
export type AutomaticEmailTrigger = z.infer<typeof AutomaticEmailTriggerSchema>;
export type RegistrationEmailLog = z.infer<typeof RegistrationEmailLogSchema>;

// ============================================================================
// Registrant Search Schemas (for Linked Account Sponsorship)
// ============================================================================

export const RegistrantSearchResultSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  paymentStatus: PaymentStatusSchema,
  totalAmount: z.number(),
  accessTypeIds: z.array(z.string()),
});

export type SearchRegistrantsQuery = {
  query: string;
  unpaidOnly: boolean;
  limit: number;
};
export type RegistrantSearchResult = z.infer<
  typeof RegistrantSearchResultSchema
>;
