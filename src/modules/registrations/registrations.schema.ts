import { z } from "zod";
import { AccessSelectionSchema } from "@access";

// ============================================================================
// Enums
// ============================================================================

export const PaymentStatusSchema = z.enum([
  "PENDING",
  "VERIFYING",
  "PARTIAL",
  "PAID",
  "SPONSORED",
  "WAIVED",
  "REFUNDED",
]);

export const TransactionTypeSchema = z.enum([
  "PAYMENT",
  "REFUND",
  "WAIVER",
  "ADJUSTMENT",
]);

export const PaymentMethodSchema = z.enum([
  "BANK_TRANSFER",
  "ONLINE",
  "CASH",
  "LAB_SPONSORSHIP",
]);

export const RegistrationRoleSchema = z.enum([
  "PARTICIPANT",
  "SPEAKER",
  "MODERATOR",
  "ORGANIZER",
]);

// ============================================================================
// Shared Validation
// ============================================================================

const requireLabName = (data: { paymentMethod?: string; labName?: string }) =>
  data.paymentMethod !== "LAB_SPONSORSHIP" || Boolean(data.labName);

const labNameRefinement = {
  message: "Lab name is required when payment method is LAB_SPONSORSHIP",
  path: ["labName"],
};

// ============================================================================
// Create Registration Schema (Public - for form submission)
// ============================================================================

export const CreateRegistrationSchema = z
  .strictObject({
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

    // Payment method selection
    paymentMethod: PaymentMethodSchema.optional(),

    // Lab sponsorship (when sponsorship module is disabled)
    labName: z.string().max(200).optional(),

    // Idempotency key for safe retries (prevents duplicate registrations)
    idempotencyKey: z.string().uuid().optional(),

    // Browser origin URL for email links (e.g., "https://summit.events.domain.com")
    linkBaseUrl: z.string().url().optional(),
  })
  .refine(requireLabName, labNameRefinement);

// ============================================================================
// Select Payment Method Schema (Public - from payment page)
// ============================================================================

export const SelectPaymentMethodSchema = z
  .strictObject({
    paymentMethod: z.enum(["CASH", "LAB_SPONSORSHIP"]),
    labName: z.string().max(200).optional(),
  })
  .refine(requireLabName, labNameRefinement);

export type SelectPaymentMethodInput = z.infer<
  typeof SelectPaymentMethodSchema
>;

// ============================================================================
// Update Registration Schema (Admin)
// ============================================================================

export const UpdatePaymentSchema = z.strictObject({
  paymentStatus: PaymentStatusSchema,
  paidAmount: z.number().int().min(0).optional(),
  paymentMethod: PaymentMethodSchema.optional(),
  paymentReference: z.string().max(200).optional(),
  paymentProofUrl: z.string().url().optional(),
});

export const UpdateRegistrationSchema = z.strictObject({
  paymentStatus: PaymentStatusSchema.optional(),
  paidAmount: z.number().int().min(0).optional(),
  paymentMethod: PaymentMethodSchema.optional(),
  paymentReference: z.string().max(200).optional(),
  paymentProofUrl: z.string().url().optional(),
  note: z.string().max(2000).nullable().optional(),
  role: RegistrationRoleSchema.optional(),
});

// ============================================================================
// Admin Create Registration Schema
// ============================================================================

export const AdminCreateRegistrationSchema = z
  .strictObject({
    // Identity — email + name required for admin-created registrations
    email: z.string().email(),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    phone: z.string().max(50).optional(),

    // Dynamic form fields — not validated against the form schema
    // Admin can omit required fields (speaker/organizer may not have filled the form)
    formData: z.record(z.string(), z.any()).optional().default({}),

    // Role — defaults to PARTICIPANT
    role: RegistrationRoleSchema.default("PARTICIPANT"),

    // Access selections
    accessSelections: z.array(AccessSelectionSchema).optional().default([]),

    // Payment — admin can set status directly (e.g. WAIVED for speakers)
    paymentMethod: PaymentMethodSchema.optional(),
    paymentStatus: PaymentStatusSchema.optional(),
    labName: z.string().max(200).optional(),
    sendEmail: z.boolean().optional().default(false),
  })
  .refine(requireLabName, labNameRefinement);

// ============================================================================
// Admin Edit Registration Schema (Full override — no restrictions)
// ============================================================================

export const AdminEditRegistrationSchema = z
  .strictObject({
    email: z.string().email().optional(),
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    phone: z.string().max(50).nullable().optional(),
    formData: z.record(z.string(), z.any()).optional(),
    role: RegistrationRoleSchema.optional(),
    accessSelections: z.array(AccessSelectionSchema).optional(),
    paymentStatus: PaymentStatusSchema.optional(),
    paidAmount: z.number().int().min(0).optional(),
    paymentMethod: PaymentMethodSchema.nullable().optional(),
    paymentReference: z.string().max(200).nullable().optional(),
    paymentProofUrl: z.string().url().nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
    labName: z.string().max(200).nullable().optional(),
  })
  .refine(
    (data) =>
      Object.values(data).some((v) => v !== undefined),
    { message: "At least one field must be provided for update" },
  );

// ============================================================================
// Query Schemas
// ============================================================================

export const ListRegistrationsQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  paymentStatus: PaymentStatusSchema.optional(),
  search: z.string().max(200).optional(),
});

export const DeleteRegistrationQuerySchema = z.strictObject({
  force: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export const RegistrationIdParamSchema = z.strictObject({
  id: z.string().uuid(),
});

export const EventIdParamSchema = z.strictObject({
  eventId: z.string().uuid(),
});

export const FormIdParamSchema = z.strictObject({
  formId: z.string().uuid(),
});

// ============================================================================
// Public Edit Registration Schema (Self-Service)
// ============================================================================

export const PublicEditRegistrationSchema = z
  .strictObject({
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
  .refine(
    (data) =>
      data.formData !== undefined ||
      data.firstName !== undefined ||
      data.lastName !== undefined ||
      data.phone !== undefined ||
      data.accessSelections !== undefined,
    { message: "At least one field must be provided for update" },
  );

export const RegistrationIdPublicParamSchema = z.strictObject({
  registrationId: z.string().uuid(),
});

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
export type CreateRegistrationInput = z.infer<typeof CreateRegistrationSchema>;
export type UpdateRegistrationInput = z.infer<typeof UpdateRegistrationSchema>;
export type UpdatePaymentInput = z.infer<typeof UpdatePaymentSchema>;
export type ListRegistrationsQuery = z.infer<
  typeof ListRegistrationsQuerySchema
>;
export type DeleteRegistrationQuery = z.infer<
  typeof DeleteRegistrationQuerySchema
>;
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

export const ListRegistrationAuditLogsQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const AuditActionSchema = z.enum([
  "CREATE",
  "UPDATE",
  "DELETE",
  "PAYMENT_CONFIRMED",
  "PAYMENT_PROOF_UPLOADED",
  "PAYMENT_METHOD_SELECTED",
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

export const ListRegistrationEmailLogsQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

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

export const SearchRegistrantsQuerySchema = z.strictObject({
  query: z.string().min(1).max(200),
  unpaidOnly: z.coerce.boolean().optional().default(false),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const RegistrantSearchResultSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  paymentStatus: PaymentStatusSchema,
  totalAmount: z.number(),
  baseAmount: z.number(),
  sponsorshipAmount: z.number(),
  accessTypeIds: z.array(z.string()),
  coveredAccessIds: z.array(z.string()),
  isBasePriceCovered: z.boolean(),
  phone: z.string().nullable(),
  formData: z.record(z.string(), z.unknown()).nullable(),
});

export type SearchRegistrantsQuery = z.infer<
  typeof SearchRegistrantsQuerySchema
>;
export type RegistrantSearchResult = z.infer<
  typeof RegistrantSearchResultSchema
>;

export type RegistrationRole = z.infer<typeof RegistrationRoleSchema>;
export type AdminCreateRegistrationInput = z.infer<
  typeof AdminCreateRegistrationSchema
>;
export type AdminEditRegistrationInput = z.infer<
  typeof AdminEditRegistrationSchema
>;
