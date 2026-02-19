import { z } from "zod";

// ============================================================================
// Field Schemas
// ============================================================================

export const FieldTypeSchema = z.enum([
  "text",
  "email",
  "phone",
  "number",
  "textarea",
  "dropdown",
  "radio",
  "checkbox",
  "date",
  "file",
  "heading",
  "paragraph",
  "governorate",
  "country",
]);

export const FieldOptionSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    priceModifier: z.number().optional(),
    description: z.string().optional(),
    maxCapacity: z.number().optional(),
    currentCount: z.number().optional(),
  })
  .strict();

export const ConditionOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "greater_than",
  "less_than",
  "is_empty",
  "is_not_empty",
]);

export const FieldConditionSchema = z
  .object({
    id: z.string().optional(),
    fieldId: z.string(),
    operator: ConditionOperatorSchema,
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict();

export const FieldValidationSchema = z
  .object({
    required: z.boolean().optional(),
    minLength: z.number().int().positive().optional(),
    maxLength: z.number().int().positive().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    minValue: z.number().optional(),
    maxValue: z.number().optional(),
    pattern: z.string().optional(),
    fileTypes: z.array(z.string()).optional(),
    maxFileSize: z.number().int().positive().optional(),
    step: z.number().optional(),
    minDate: z.string().optional(),
    maxDate: z.string().optional(),
    acceptedFileTypes: z.array(z.string()).optional(),
    minSelections: z.number().int().min(0).optional(),
    maxSelections: z.number().int().positive().optional(),
    // Custom error messages
    requiredError: z.string().optional(),
    patternError: z.string().optional(),
    minLengthError: z.string().optional(),
    maxLengthError: z.string().optional(),
    minValueError: z.string().optional(),
    maxValueError: z.string().optional(),
    minDateError: z.string().optional(),
    maxDateError: z.string().optional(),
    fileTypeError: z.string().optional(),
    fileSizeError: z.string().optional(),
    minSelectionsError: z.string().optional(),
    maxSelectionsError: z.string().optional(),
    errorMessages: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const FormFieldSchema = z
  .object({
    id: z.string(),
    type: FieldTypeSchema,
    label: z.string().optional(),
    placeholder: z.string().optional(),
    helpText: z.string().optional(),
    required: z.boolean().optional(),
    width: z.string().optional(),
    options: z.array(FieldOptionSchema).optional(),
    validation: FieldValidationSchema.optional(),
    conditions: z.array(FieldConditionSchema).optional(),
    conditionLogic: z.enum(["and", "or"]).optional(),
    conditionAction: z.enum(["show", "disable"]).optional(),
    clearOnHide: z.boolean().optional(),
    defaultValue: z
      .union([z.string(), z.number(), z.array(z.string())])
      .optional(),
    pricingEnabled: z.boolean().optional(),
    gridColumn: z.string().optional(),
    // Type-specific properties
    rows: z.number().int().positive().optional(),
    layout: z.enum(["vertical", "horizontal", "cards"]).optional(),
    searchable: z.boolean().optional(),
    headingSize: z.enum(["h2", "h3", "h4"]).optional(),
    content: z.string().optional(),
    phoneFormat: z.string().optional(),
    dateFormat: z.string().optional(),
    fieldKey: z.string().optional(),
  })
  .strict();

// ============================================================================
// Form Step Schema
// ============================================================================

export const FormStepSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    fields: z.array(FormFieldSchema),
  })
  .strict();

// ============================================================================
// Complete Form Schema (JSONB)
// ============================================================================

// Strict schema for JSONB - validates all step and field properties
// Registration forms use `steps`, sponsor forms use `sponsorSteps`
export const FormSchemaJsonSchema = z
  .object({
    steps: z.array(FormStepSchema),
  })
  .strict();

// ============================================================================
// Sponsor Form Schemas
// ============================================================================

// Beneficiary template for sponsor forms
export const BeneficiaryTemplateSchema = z
  .object({
    fields: z.array(FormFieldSchema),
    minCount: z.number().int().min(1).default(1),
    maxCount: z.number().int().max(500).default(100),
  })
  .strict();

// Summary settings for sponsor forms
export const SponsorSummarySettingsSchema = z
  .object({
    title: z.string().optional(),
    showPriceBreakdown: z.boolean().default(true),
    termsText: z.string().optional(),
  })
  .strict();

// Sponsorship mode settings (only for SPONSOR forms)
export const SponsorshipModeSchema = z.enum(["LINKED_ACCOUNT", "CODE"]);
export const RegistrantSearchScopeSchema = z.enum(["ALL", "UNPAID_ONLY"]);

export const SponsorshipSettingsSchema = z
  .object({
    sponsorshipMode: SponsorshipModeSchema.default("CODE"),
    registrantSearchScope: RegistrantSearchScopeSchema.optional(),
    autoApproveSponsorship: z.boolean().optional(),
  })
  .strict();

// Sponsor form schema structure
export const SponsorFormSchemaJsonSchema = z
  .object({
    formType: z.literal("SPONSOR"),
    sponsorSteps: z.array(FormStepSchema),
    beneficiaryTemplate: BeneficiaryTemplateSchema,
    summarySettings: SponsorSummarySettingsSchema.optional(),
    sponsorshipSettings: SponsorshipSettingsSchema.optional(),
  })
  .strict();

// ============================================================================
// Request Schemas
// ============================================================================

export const CreateFormSchema = z
  .object({
    eventId: z.string().uuid(),
    name: z.string().min(1).max(200),
    schema: FormSchemaJsonSchema.optional(), // Optional - backend provides defaults
    successTitle: z.string().optional().nullable(),
    successMessage: z.string().optional().nullable(),
  })
  .strict();

export const UpdateFormSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    schema: FormSchemaJsonSchema.optional(),
    successTitle: z.string().optional().nullable(),
    successMessage: z.string().optional().nullable(),
  })
  .strict();

export const ListFormsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    eventId: z.string().uuid().optional(),
    search: z.string().optional(),
    type: z.enum(["REGISTRATION", "SPONSOR"]).optional(),
  })
  .strict();

export { FormIdParamSchema } from "@shared/schemas/params.js";

// Update sponsorship settings (for SPONSOR forms only)
export const UpdateSponsorshipSettingsSchema = z
  .object({
    sponsorshipMode: SponsorshipModeSchema,
    registrantSearchScope: RegistrantSearchScopeSchema.optional(),
    autoApproveSponsorship: z.boolean().optional(),
  })
  .strict();

// ============================================================================
// Types
// ============================================================================

export type FieldCondition = z.infer<typeof FieldConditionSchema>;
export type FieldValidation = z.infer<typeof FieldValidationSchema>;
export type FormField = z.infer<typeof FormFieldSchema>;
export type FormStep = z.infer<typeof FormStepSchema>;
export type FormSchemaJson = z.infer<typeof FormSchemaJsonSchema>;
export type SponsorshipSettings = z.infer<typeof SponsorshipSettingsSchema>;
export type SponsorFormSchemaJson = z.infer<typeof SponsorFormSchemaJsonSchema>;
export type CreateFormInput = z.infer<typeof CreateFormSchema>;
export type UpdateFormInput = z.infer<typeof UpdateFormSchema>;
export type ListFormsQuery = z.infer<typeof ListFormsQuerySchema>;
export type UpdateSponsorshipSettingsInput = z.infer<
  typeof UpdateSponsorshipSettingsSchema
>;
