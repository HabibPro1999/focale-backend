import { z, type ZodTypeAny } from "zod";
import safeRegex from "safe-regex";

const MIN_PHONE_LENGTH = 8;
import type {
  FormField,
  FormStep,
  FieldValidation,
} from "./forms.schema.js";
import { logger } from "@shared/utils/logger.js";
import { evaluateConditions } from "@shared/utils/conditions.js";

// ============================================================================
// Types
// ============================================================================

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

function hasValidSteps(formSchema: unknown): formSchema is FormSchema {
  return (
    !!formSchema &&
    typeof formSchema === "object" &&
    Array.isArray((formSchema as { steps?: unknown }).steps)
  );
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

/**
 * Check if a regex pattern is safe (no catastrophic backtracking potential).
 * Uses safe-regex to detect ReDoS vulnerabilities.
 */
function isSafePattern(pattern: string): boolean {
  try {
    // Check for catastrophic backtracking potential
    if (!safeRegex(pattern)) {
      return false;
    }
    // Also verify it's valid syntax
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
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
  let schema = z.string();
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
  let schema = z.coerce.number();
  const label = getFieldLabel(field);
  const min = validation?.min ?? validation?.minValue;
  const max = validation?.max ?? validation?.maxValue;

  if (min !== undefined) {
    schema = schema.min(min, `${label} must be at least ${min}`);
  }
  if (max !== undefined) {
    schema = schema.max(max, `${label} must be at most ${max}`);
  }

  const blankToUndefined = (value: unknown) =>
    value === "" || value === null || value === undefined ? undefined : value;

  if (validation?.required) {
    return z.preprocess(blankToUndefined, schema);
  }
  return z.preprocess(blankToUndefined, schema.optional());
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

  if (validation?.minDate) {
    schema = schema.refine(
      (value) => {
        const valueDate = parseDate(value);
        const minDate = parseDate(validation.minDate!);
        return !valueDate || !minDate || valueDate >= minDate;
      },
      `${label} must be on or after ${validation.minDate}`,
    );
  }
  if (validation?.maxDate) {
    schema = schema.refine(
      (value) => {
        const valueDate = parseDate(value);
        const maxDate = parseDate(validation.maxDate!);
        return !valueDate || !maxDate || valueDate <= maxDate;
      },
      `${label} must be on or before ${validation.maxDate}`,
    );
  }

  if (validation?.required) {
    return schema.min(1, `${label} is required`);
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
    ? schema
    : schema.optional().default([]);
}

function buildFileSchema(
  field: FormField,
  validation?: FieldValidation,
): ZodTypeAny {
  const label = getFieldLabel(field);
  const allowedFileTypes = validation?.fileTypes ?? validation?.acceptedFileTypes;

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
        if (allowedFileTypes && allowedFileTypes.length > 0) {
          const fileExtension = file.name.split(".").pop()?.toLowerCase();
          const mimeType = file.type.toLowerCase();
          return allowedFileTypes.some((allowed) => {
            const normalizedAllowed = allowed.toLowerCase().replace(".", "");
            return (
              mimeType.includes(normalizedAllowed) ||
              fileExtension === normalizedAllowed
            );
          });
        }
        return true;
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
  if (!hasValidSteps(formSchema)) {
    return () => invalidSchemaResult();
  }

  // Flatten all fields from all steps
  const allFields: FormField[] = formSchema.steps.flatMap((step) =>
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
  if (!hasValidSteps(formSchema)) {
    return {};
  }

  const knownIds = new Set<string>();
  for (const step of formSchema.steps) {
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
