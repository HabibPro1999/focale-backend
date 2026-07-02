import { z, type ZodTypeAny } from "zod";
import { createLogger } from "./logger";
import { evaluateConditions } from "./conditions";
import { isSafePattern } from "./regex-safety";

const MIN_PHONE_LENGTH = 8;
const logger = createLogger({ name: "shared:form-data-validator" });

// ============================================================================
// Types
//
// Framework-free structural mirrors of the form-schema shapes. The zod source
// of truth (FormFieldSchema etc.) lives in the forms module / @app/contracts,
// which this leaf package MUST NOT import. Keep these structurally compatible
// with that zod schema.
// ============================================================================

export type FieldType =
  | "text"
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "number"
  | "textarea"
  | "dropdown"
  | "radio"
  | "checkbox"
  | "date"
  | "file"
  | "heading"
  | "paragraph"
  | "governorate"
  | "country";

export interface FieldOption {
  id: string;
  label?: string;
}

export interface FieldCondition {
  id?: string;
  fieldId: string;
  operator: string;
  value?: string | number | boolean;
}

export interface FieldValidation {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
  fileTypes?: string[];
  maxFileSize?: number;
  minValue?: number;
  maxValue?: number;
  step?: number;
  minDate?: string;
  maxDate?: string;
  acceptedFileTypes?: string[];
  minSelections?: number;
  maxSelections?: number;
}

export interface FormField {
  id: string;
  type: FieldType;
  label?: string;
  required?: boolean;
  options?: FieldOption[];
  validation?: FieldValidation;
  conditions?: FieldCondition[];
  conditionLogic?: "AND" | "OR" | "and" | "or";
}

export interface FormStep {
  id: string;
  title: string;
  fields: FormField[];
}

export interface FormSchema {
  steps: FormStep[];
}

export interface FormDataValidationResult {
  valid: boolean;
  errors: FormDataFieldError[];
  data?: Record<string, unknown>;
}

export interface FormDataFieldError {
  fieldId: string;
  fieldName: string;
  message: string;
  code: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract display label from field.
 */
function getFieldLabel(field: FormField): string {
  return field.label ?? field.id;
}

function extractSchemaSteps(formSchema: unknown): FormStep[] | null {
  if (!formSchema || typeof formSchema !== "object") {
    return null;
  }

  const schema = formSchema as {
    steps?: unknown;
    sponsorSteps?: unknown;
    beneficiaryTemplate?: { steps?: unknown };
  };
  if (Array.isArray(schema.steps)) {
    return schema.steps as FormStep[];
  }
  const sponsorSteps = Array.isArray(schema.sponsorSteps)
    ? (schema.sponsorSteps as FormStep[])
    : [];
  const beneficiarySteps = Array.isArray(schema.beneficiaryTemplate?.steps)
    ? (schema.beneficiaryTemplate.steps as FormStep[])
    : [];
  if (sponsorSteps.length > 0 || beneficiarySteps.length > 0) {
    return [...sponsorSteps, ...beneficiarySteps];
  }
  return null;
}

function invalidSchemaResult(): FormDataValidationResult {
  return {
    valid: false,
    errors: [
      {
        fieldId: "schema",
        fieldName: "Form schema",
        message: "Form schema is missing steps",
        code: "invalid_schema",
      },
    ],
  };
}

/**
 * Format file size in human-readable format.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================================
// Condition Evaluation (delegates to shared evaluator)
// ============================================================================

/**
 * Determine if a field should be validated based on its conditions.
 * Hidden fields (conditions not met) should be skipped during validation.
 */
function shouldValidateField(
  field: FormField,
  formData: Record<string, unknown>,
  allFields: FormField[],
): boolean {
  if (!field.conditions || field.conditions.length === 0) {
    return true; // No conditions, always validate
  }

  // Filter conditions to only those referencing fields that exist in the schema.
  // Missing-field conditions are treated as met (field visible by default).
  const applicableConditions = field.conditions.filter((c) =>
    allFields.some((f) => f.id === c.fieldId),
  );

  if (applicableConditions.length === 0) {
    return true; // All referenced fields missing — treat as visible
  }

  const logic = field.conditionLogic ?? "AND";
  return evaluateConditions(applicableConditions, logic, formData);
}

// ============================================================================
// Field Schema Builders
// ============================================================================

function buildTextSchema(
  field: FormField,
  validation?: FieldValidation,
): ZodTypeAny {
  let schema = z.string().trim();
  const label = getFieldLabel(field);

  if (validation?.minLength) {
    schema = schema.min(
      validation.minLength,
      `${label} must be at least ${validation.minLength} characters`,
    );
  }
  if (validation?.maxLength) {
    schema = schema.max(
      validation.maxLength,
      `${label} must be at most ${validation.maxLength} characters`,
    );
  }
  if (validation?.pattern) {
    if (isSafePattern(validation.pattern)) {
      const regex = new RegExp(validation.pattern);
      schema = schema.regex(regex, `${label} format is invalid`);
    } else {
      logger.warn(
        { fieldId: field.id, pattern: validation.pattern },
        "Skipping unsafe or invalid regex pattern (ReDoS protection)",
      );
    }
  }

  if (validation?.required) {
    return schema.min(1, `${label} is required`);
  }
  return schema.optional().or(z.literal(""));
}

function buildEmailSchema(
  field: FormField,
  validation?: FieldValidation,
): ZodTypeAny {
  const label = getFieldLabel(field);
  let schema = z.string().email(`${label} must be a valid email address`);

  if (validation?.minLength) {
    schema = schema.min(validation.minLength);
  }
  if (validation?.maxLength) {
    schema = schema.max(validation.maxLength);
  }

  if (validation?.required) {
    return schema;
  }
  return schema.optional().or(z.literal(""));
}

function buildPhoneSchema(
  field: FormField,
  validation?: FieldValidation,
): ZodTypeAny {
  let schema = z.string();
  const label = getFieldLabel(field);

  // Default minimum for phone numbers
  const minLen = validation?.minLength ?? MIN_PHONE_LENGTH;
  schema = schema.min(minLen, `${label} must be at least ${minLen} characters`);

  if (validation?.maxLength) {
    schema = schema.max(validation.maxLength);
  }
  if (validation?.pattern) {
    if (isSafePattern(validation.pattern)) {
      const regex = new RegExp(validation.pattern);
      schema = schema.regex(regex, `${label} format is invalid`);
    } else {
      logger.warn(
        { fieldId: field.id, pattern: validation.pattern },
        "Skipping unsafe or invalid regex pattern (ReDoS protection)",
      );
    }
  }

  if (validation?.required) {
    return schema;
  }
  return schema.optional().or(z.literal(""));
}

function buildNumberSchema(
  field: FormField,
  validation?: FieldValidation,
): ZodTypeAny {
  let schema = z.number();
  const label = getFieldLabel(field);
  const min = validation?.min ?? validation?.minValue;
  const max = validation?.max ?? validation?.maxValue;

  if (min !== undefined) {
    schema = schema.min(min, `${label} must be at least ${min}`);
  }
  if (max !== undefined) {
    schema = schema.max(max, `${label} must be at most ${max}`);
  }

  const parseNumberInput = (value: unknown) => {
    if (value === null || value === undefined) return undefined;
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : value;
    }
    if (typeof value !== "string") return value;

    const trimmed = value.trim();
    if (trimmed === "") return undefined;

    if (!/^[+-]?(?:\d+|\d*\.\d+)$/.test(trimmed)) {
      return value;
    }

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : value;
  };

  if (validation?.required) {
    return z.preprocess(parseNumberInput, schema);
  }
  return z.preprocess(parseNumberInput, schema.optional());
}

function buildDateSchema(
  field: FormField,
  validation?: FieldValidation,
): ZodTypeAny {
  let schema = z.string();
  const label = getFieldLabel(field);
  const parseDate = (value: string) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  schema = schema.refine(
    (value) => value === "" || parseDate(value) !== null,
    `${label} must be a valid date`,
  );

  if (validation?.minDate) {
    schema = schema.refine((value) => {
      const valueDate = parseDate(value);
      const minDate = parseDate(validation.minDate!);
      return valueDate !== null && (!minDate || valueDate >= minDate);
    }, `${label} must be on or after ${validation.minDate}`);
  }
  if (validation?.maxDate) {
    schema = schema.refine((value) => {
      const valueDate = parseDate(value);
      const maxDate = parseDate(validation.maxDate!);
      return valueDate !== null && (!maxDate || valueDate <= maxDate);
    }, `${label} must be on or before ${validation.maxDate}`);
  }

  if (validation?.required) {
    return schema.trim().min(1, `${label} is required`);
  }
  return schema.optional().or(z.literal(""));
}

function buildDropdownSchema(
  field: FormField,
  validation?: FieldValidation,
): ZodTypeAny {
  const label = getFieldLabel(field);
  const validValues = field.options?.map((o) => o.id) ?? [];

  if (validValues.length > 0) {
    const schema = z.enum(validValues as [string, ...string[]], {
      message: `${label} must be a valid option`,
    });
    if (validation?.required) {
      return schema;
    }
    return schema.optional().or(z.literal(""));
  }

  // No options defined, accept any string
  const schema = z.string();
  if (validation?.required) {
    return schema.min(1, `${label} is required`);
  }
  return schema.optional().or(z.literal(""));
}

function buildRadioSchema(
  field: FormField,
  validation?: FieldValidation,
): ZodTypeAny {
  // Radio behaves like dropdown - single selection
  return buildDropdownSchema(field, validation);
}

function buildCheckboxSchema(
  field: FormField,
  validation?: FieldValidation,
): ZodTypeAny {
  const label = getFieldLabel(field);
  const validValues = field.options?.map((o) => o.id) ?? [];

  let schema: ReturnType<typeof z.array>;

  if (validValues.length > 0) {
    schema = z.array(
      z.enum(validValues as [string, ...string[]], {
        message: `Invalid option selected for ${label}`,
      }),
    );
  } else {
    schema = z.array(z.string());
  }

  const minSelections = validation?.required
    ? Math.max(1, validation.minSelections ?? 1)
    : validation?.minSelections;
  if (minSelections !== undefined) {
    schema = schema.min(
      minSelections,
      minSelections === 1
        ? `${label} requires at least one selection`
        : `${label} requires at least ${minSelections} selections`,
    );
  }
  if (validation?.maxSelections !== undefined) {
    schema = schema.max(
      validation.maxSelections,
      `${label} allows at most ${validation.maxSelections} selections`,
    );
  }

  return validation?.required || validation?.minSelections !== undefined
    ? z.preprocess(
        (value) =>
          value === undefined || value === "" || value === null
            ? []
            : Array.isArray(value)
              ? value
              : [value],
        schema,
      )
    : z.preprocess(
        (value) =>
          value === undefined || value === "" || value === null
            ? undefined
            : Array.isArray(value)
              ? value
              : [value],
        schema.optional().default([]),
      );
}

function buildFileSchema(
  field: FormField,
  validation?: FieldValidation,
): ZodTypeAny {
  const label = getFieldLabel(field);
  const allowedFileTypes =
    validation?.fileTypes ?? validation?.acceptedFileTypes;

  const normalizeFileType = (value: string) =>
    value.trim().toLowerCase().replace(/^\./, "");

  const isAllowedFileType = (file: { name: string; type: string }) => {
    if (!allowedFileTypes || allowedFileTypes.length === 0) {
      return true;
    }

    const fileExtension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = file.type.trim().toLowerCase();

    return allowedFileTypes.some((allowed) => {
      const normalizedAllowed = normalizeFileType(allowed);
      if (normalizedAllowed.endsWith("/*")) {
        const prefix = normalizedAllowed.slice(0, -1);
        return mimeType.startsWith(prefix);
      }
      if (normalizedAllowed.includes("/")) {
        return mimeType === normalizedAllowed;
      }
      return fileExtension === normalizedAllowed;
    });
  };

  // File metadata schema: { name, size, type, url? }
  const fileMetadataSchema = z
    .object({
      name: z.string(),
      size: z.number(),
      type: z.string(),
      url: z.string().optional(),
    })
    .refine(
      (file) => {
        if (validation?.maxFileSize && file.size > validation.maxFileSize) {
          return false;
        }
        return true;
      },
      {
        message: validation?.maxFileSize
          ? `${label} exceeds maximum size of ${formatFileSize(validation.maxFileSize)}`
          : `${label} exceeds maximum file size`,
      },
    )
    .refine(
      (file) => {
        return isAllowedFileType(file);
      },
      {
        message: allowedFileTypes
          ? `${label} must be one of: ${allowedFileTypes.join(", ")}`
          : `${label} has invalid file type`,
      },
    );

  if (validation?.required) {
    return fileMetadataSchema;
  }
  return fileMetadataSchema.optional().nullable();
}

// ============================================================================
// Main Schema Builder
// ============================================================================

/**
 * Build the appropriate Zod schema for a single field based on its type.
 * Returns null for display-only fields (heading, paragraph).
 *
 * Note: merges field.required into validation.required so build functions
 * only need to check validation?.required (single source of truth inside builders).
 */
function buildFieldSchema(field: FormField): ZodTypeAny | null {
  // field.required is the top-level required flag; validation.required is nested.
  // Either source should make the field required.
  const isRequired = field.validation?.required || field.required || false;
  const validation: FieldValidation | undefined = field.validation
    ? { ...field.validation, required: isRequired }
    : isRequired
      ? { required: true }
      : undefined;

  switch (field.type) {
    case "text":
    case "firstName":
    case "lastName":
    case "textarea":
      return buildTextSchema(field, validation);

    case "email":
      return buildEmailSchema(field, validation);

    case "phone":
      return buildPhoneSchema(field, validation);

    case "number":
      return buildNumberSchema(field, validation);

    case "date":
      return buildDateSchema(field, validation);

    case "dropdown":
      return buildDropdownSchema(field, validation);

    case "radio":
      return buildRadioSchema(field, validation);

    case "checkbox":
      return buildCheckboxSchema(field, validation);

    case "file":
      return buildFileSchema(field, validation);

    case "governorate":
    case "country":
      return buildDropdownSchema(field, validation);

    case "heading":
    case "paragraph":
      // Display-only fields, no validation needed
      return null;

    default: {
      const _exhaustive: never = field.type;
      throw new Error(`Unsupported field type: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Build a form data validator function from a form schema.
 * The validator respects conditional field visibility.
 */
export function buildFormDataValidator(
  formSchema: unknown,
): (formData: Record<string, unknown>) => FormDataValidationResult {
  const steps = extractSchemaSteps(formSchema);
  if (!steps) {
    return () => invalidSchemaResult();
  }

  // Flatten all fields from all steps
  const allFields: FormField[] = steps.flatMap((step) =>
    Array.isArray(step.fields) ? step.fields : [],
  );
  return (formData: Record<string, unknown>): FormDataValidationResult => {
    const errors: FormDataFieldError[] = [];
    const validatedData: Record<string, unknown> = {};

    for (const field of allFields) {
      // Skip display-only fields
      if (field.type === "heading" || field.type === "paragraph") {
        continue;
      }

      // Check if field should be validated based on conditions
      if (!shouldValidateField(field, formData, allFields)) {
        // Field is hidden, skip validation and don't include in output
        continue;
      }

      const fieldSchema = buildFieldSchema(field);
      if (!fieldSchema) continue;

      const value = formData[field.id];
      const result = fieldSchema.safeParse(value);

      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            fieldId: field.id,
            fieldName: getFieldLabel(field),
            message: issue.message,
            code: issue.code,
          });
        }
      } else {
        validatedData[field.id] = result.data;
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      data: errors.length === 0 ? validatedData : undefined,
    };
  };
}

/**
 * Validate form data against a form schema.
 * Convenience function that creates a validator and runs it.
 */
export function validateFormData(
  formSchema: unknown,
  formData: Record<string, unknown>,
): FormDataValidationResult {
  const validator = buildFormDataValidator(formSchema);
  return validator(formData);
}

/**
 * Filter formData to only keep keys that are known field IDs in the form schema.
 * Preserves hidden/conditional field values (unlike validationResult.data which strips them).
 * Removes any injected/unknown keys.
 */
export function sanitizeFormData(
  formSchema: unknown,
  formData: Record<string, unknown>,
): Record<string, unknown> {
  const steps = extractSchemaSteps(formSchema);
  if (!steps) {
    return {};
  }

  const knownIds = new Set<string>();
  for (const step of steps) {
    const fields = Array.isArray(step.fields) ? step.fields : [];
    for (const field of fields) {
      knownIds.add(field.id);
    }
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(formData)) {
    if (knownIds.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
