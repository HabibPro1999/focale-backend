import { z, type ZodTypeAny } from "zod";
import safeRegex from "safe-regex";
import type {
  FormField,
  FormStep,
  FieldCondition,
  FieldValidation,
} from "@forms";
import { logger } from "@shared/utils/logger.js";
import { evaluateSingleCondition as evaluateCondition } from "@shared/utils/condition-evaluator.js";

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
// Condition Evaluation (matches frontend logic)
// ============================================================================

/**
 * Wrapper around the shared condition evaluator that handles field existence checking.
 * Returns true if the field doesn't exist in the form (field not found = condition met).
 */
function evaluateFieldCondition(
  condition: FieldCondition,
  formData: Record<string, unknown>,
  allFields: FormField[],
): boolean {
  // Find target field by ID
  const targetField = allFields.find((f) => f.id === condition.fieldId);
  if (!targetField) return true; // Field not found, assume condition met

  // Delegate to shared evaluator with permissive unknown operator handling
  return evaluateCondition(condition, formData, {
    unknownOperatorDefault: true,
  });
}

/**
 * Determine if a field should be validated based on its conditions.
 * Hidden fields (conditions not met) should be skipped during validation.
 */
export function shouldValidateField(
  field: FormField & { conditionLogic?: "AND" | "OR" },
  formData: Record<string, unknown>,
  allFields: FormField[],
): boolean {
  if (!field.conditions || field.conditions.length === 0) {
    return true; // No conditions, always validate
  }

  // Use conditionLogic to determine how to combine conditions
  // 'AND' (default): all conditions must be met
  // 'OR': at least one condition must be met
  const conditionLogic = field.conditionLogic ?? "AND";

  if (conditionLogic === "OR") {
    return field.conditions.some((c) =>
      evaluateFieldCondition(c, formData, allFields),
    );
  } else {
    return field.conditions.every((c) =>
      evaluateFieldCondition(c, formData, allFields),
    );
  }
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
  const minLen = validation?.minLength ?? 8;
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

  // Use minValue/maxValue (frontend canonical) with fallback to min/max (legacy backend)
  const minVal = validation?.minValue ?? validation?.min;
  const maxVal = validation?.maxValue ?? validation?.max;

  if (minVal !== undefined) {
    schema = schema.min(minVal, `${label} must be at least ${minVal}`);
  }
  if (maxVal !== undefined) {
    schema = schema.max(maxVal, `${label} must be at most ${maxVal}`);
  }

  if (validation?.required) {
    return schema;
  }
  return schema.optional().nullable();
}

function buildDateSchema(
  field: FormField,
  validation?: FieldValidation,
): ZodTypeAny {
  const schema = z.string();
  const label = getFieldLabel(field);

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

  let schema: ZodTypeAny;

  if (validValues.length > 0) {
    schema = z.array(
      z.enum(validValues as [string, ...string[]], {
        message: `Invalid option selected for ${label}`,
      }),
    );
  } else {
    schema = z.array(z.string());
  }

  if (validation?.required) {
    return (schema as ReturnType<typeof z.array>).min(
      1,
      `${label} requires at least one selection`,
    );
  }
  return schema.optional().default([]);
}

function buildFileSchema(
  field: FormField,
  validation?: FieldValidation,
): ZodTypeAny {
  const label = getFieldLabel(field);

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
        if (validation?.fileTypes && validation.fileTypes.length > 0) {
          const fileExtension = file.name.split(".").pop()?.toLowerCase();
          const mimeType = file.type.toLowerCase();
          return validation.fileTypes.some((allowed) => {
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
        message: validation?.fileTypes
          ? `${label} must be one of: ${validation.fileTypes.join(", ")}`
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
 */
function buildFieldSchema(field: FormField): ZodTypeAny | null {
  const validation = field.validation;

  switch (field.type) {
    case "text":
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

    case "governorate":
    case "country":
      // Governorate and country behave like dropdown - single selection from options
      return buildDropdownSchema(field, validation);

    case "radio":
      return buildRadioSchema(field, validation);

    case "checkbox":
      return buildCheckboxSchema(field, validation);

    case "file":
      return buildFileSchema(field, validation);

    case "heading":
    case "paragraph":
      // Display-only fields, no validation needed
      return null;

    default:
      // Unknown field type, accept any value
      return z.any().optional();
  }
}

/**
 * Build a form data validator function from a form schema.
 * The validator respects conditional field visibility.
 */
export function buildFormDataValidator(
  formSchema: FormSchema,
): (formData: Record<string, unknown>) => FormDataValidationResult {
  // Flatten all fields from all steps
  const allFields: FormField[] = formSchema.steps.flatMap(
    (step) => step.fields,
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
  formSchema: FormSchema,
  formData: Record<string, unknown>,
): FormDataValidationResult {
  const validator = buildFormDataValidator(formSchema);
  return validator(formData);
}
