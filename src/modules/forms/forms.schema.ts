import { z } from "zod";

// ============================================================================
// Field Schemas
// ============================================================================

export const FieldTypeSchema = z.enum([
  "text",
  "firstName",
  "lastName",
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

export const FieldOptionSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  maxCapacity: z.number().optional(),
  currentCount: z.number().optional(),
  priceModifier: z.number().optional(),
});

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

export const FieldConditionSchema = z.strictObject({
  id: z.string().optional(),
  fieldId: z.string(),
  operator: ConditionOperatorSchema,
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const FieldValidationErrorMessagesSchema = z.strictObject({
  required: z.string().optional(),
  minLength: z.string().optional(),
  maxLength: z.string().optional(),
  pattern: z.string().optional(),
  email: z.string().optional(),
  min: z.string().optional(),
  max: z.string().optional(),
});

export const FieldValidationSchema = z.strictObject({
  required: z.boolean().optional(),
  minLength: z.number().int().positive().optional(),
  maxLength: z.number().int().positive().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  pattern: z.string().optional(),
  fileTypes: z.array(z.string()).optional(),
  maxFileSize: z.number().int().positive().optional(),
  minValue: z.number().optional(),
  maxValue: z.number().optional(),
  step: z.number().optional(),
  minDate: z.string().optional(),
  maxDate: z.string().optional(),
  acceptedFileTypes: z.array(z.string()).optional(),
  minSelections: z.number().int().optional(),
  maxSelections: z.number().int().optional(),
  errorMessages: FieldValidationErrorMessagesSchema.optional(),
});

export const FormFieldSchema = z.strictObject({
  id: z.string(),
  type: FieldTypeSchema,
  label: z.string().optional(),
  placeholder: z.string().optional(),
  helpText: z.string().optional(),
  helperText: z.string().optional(),
  required: z.boolean().optional(),
  width: z.string().optional(),
  options: z.array(FieldOptionSchema).optional(),
  validation: FieldValidationSchema.optional(),
  conditions: z.array(FieldConditionSchema).optional(),
  conditionLogic: z.enum(["AND", "OR", "and", "or"]).optional(),
  conditionAction: z.enum(["show", "disable"]).optional(),
  clearOnHide: z.boolean().optional(),
  defaultValue: z
    .union([z.string(), z.number(), z.array(z.string())])
    .optional(),
  pricingEnabled: z.boolean().optional(),
  gridColumn: z.string().optional(),
  fieldKey: z.string().optional(),
  phoneFormat: z.string().optional(),
  dateFormat: z.string().optional(),
  rows: z.number().int().optional(),
  layout: z.enum(["vertical", "horizontal", "cards"]).optional(),
  searchable: z.boolean().optional(),
  headingSize: z.enum(["h2", "h3", "h4"]).optional(),
  content: z.string().optional(),
});

// ============================================================================
// Form Step Schema
// ============================================================================

export const FormStepSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  fields: z.array(FormFieldSchema),
});

// ============================================================================
// Complete Form Schema (JSONB)
// ============================================================================

// Registration form schema structure
// Uses looseObject to allow top-level extensions while enforcing steps/fields structure
export const FormSchemaJsonSchema = z.looseObject({
  steps: z.array(FormStepSchema).optional(),
});

// ============================================================================
// Sponsor Form Schemas
// ============================================================================

// Beneficiary template for sponsor forms
export const BeneficiaryTemplateSchema = z.looseObject({
  fields: z.array(FormFieldSchema),
  minCount: z.number().int().min(1).default(1),
  maxCount: z.number().int().max(500).default(100),
});

// Summary settings for sponsor forms
export const SponsorSummarySettingsSchema = z.looseObject({
  title: z.string().optional(),
  showPriceBreakdown: z.boolean().default(true),
  termsText: z.string().optional(),
});

// Sponsorship mode settings (only for SPONSOR forms)
export const SponsorshipModeSchema = z.enum(["LINKED_ACCOUNT", "CODE"]);
export const RegistrantSearchScopeSchema = z.enum(["ALL", "UNPAID_ONLY"]);

export const SponsorshipSettingsSchema = z.strictObject({
  sponsorshipMode: SponsorshipModeSchema.default("CODE"),
  registrantSearchScope: RegistrantSearchScopeSchema.optional(),
  autoApproveSponsorship: z.boolean().optional(),
});

// Sponsor form schema structure
export const SponsorFormSchemaJsonSchema = z.looseObject({
  formType: z.literal("SPONSOR"),
  sponsorSteps: z.array(FormStepSchema),
  beneficiaryTemplate: BeneficiaryTemplateSchema,
  summarySettings: SponsorSummarySettingsSchema.optional(),
  sponsorshipSettings: SponsorshipSettingsSchema.optional(),
});

// ============================================================================
// Request Schemas
// ============================================================================

export const CreateFormSchema = z.strictObject({
  eventId: z.string().uuid(),
  name: z.string().min(1).max(200),
  schema: FormSchemaJsonSchema.optional(), // Optional - backend provides defaults
  successTitle: z.string().optional().nullable(),
  successMessage: z.string().optional().nullable(),
});

export const UpdateFormSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  schema: FormSchemaJsonSchema.optional(),
  successTitle: z.string().optional().nullable(),
  successMessage: z.string().optional().nullable(),
});

export const ListFormsQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  eventId: z.string().uuid().optional(),
  search: z.string().optional(),
  type: z.enum(["REGISTRATION", "SPONSOR"]).optional(),
});

export const FormIdParamSchema = z.strictObject({
  id: z.string().uuid(),
});

// Update sponsorship settings (for SPONSOR forms only)
export const UpdateSponsorshipSettingsSchema = z.strictObject({
  sponsorshipMode: SponsorshipModeSchema,
  registrantSearchScope: RegistrantSearchScopeSchema.optional(),
  autoApproveSponsorship: z.boolean().optional(),
});

// ============================================================================
// Types
// ============================================================================

export type FieldType = z.infer<typeof FieldTypeSchema>;
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
