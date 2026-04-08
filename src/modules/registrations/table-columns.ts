import { prisma } from "@/database/client.js";
import type { FormField } from "@forms";

// ============================================================================
// Types
// ============================================================================

type FormSchemaSteps = {
  steps: Array<{ fields: FormField[] }>;
};

export type RegistrationTableColumns = {
  formColumns: Array<{
    id: string;
    label: string;
    type: string;
    options?: Array<{ id: string; label: string }>;
    mergeWith?: {
      fieldId: string;
      triggerValue: string;
    };
  }>;
  fixedColumns: Array<{
    id: string;
    label: string;
    type: string;
  }>;
};

// ============================================================================
// Smart Merge Helpers
// ============================================================================

const SPECIFY_OTHER_TRIGGER_VALUES = ["other", "autre", "other_diet"];

/**
 * Find a "specify other" child field for a given parent field.
 * Returns the child field that:
 * - Has conditions referencing the parent field
 * - Uses 'equals' operator with an "other" value
 */
function findSpecifyOtherChild(
  parentField: FormField,
  allFields: FormField[],
): FormField | null {
  // Only for selection fields
  if (!["dropdown", "radio"].includes(parentField.type)) return null;

  // Check if parent has an "other" option (by option.id)
  const hasOtherOption = parentField.options?.some((opt) =>
    SPECIFY_OTHER_TRIGGER_VALUES.includes(opt.id.toLowerCase()),
  );
  if (!hasOtherOption) return null;

  // Find child field that depends on this parent with equals/other condition
  return (
    allFields.find((child) =>
      child.conditions?.some(
        (cond) =>
          cond.fieldId === parentField.id &&
          cond.operator === "equals" &&
          SPECIFY_OTHER_TRIGGER_VALUES.includes(
            String(cond.value ?? "").toLowerCase(),
          ),
      ),
    ) ?? null
  );
}

/**
 * Get default fixed columns when no form exists.
 */
function getDefaultFixedColumns() {
  return [
    { id: "email", label: "Email", type: "email" },
    { id: "firstName", label: "First Name", type: "text" },
    { id: "lastName", label: "Last Name", type: "text" },
    { id: "phone", label: "Phone", type: "phone" },
    { id: "paymentStatus", label: "Payment", type: "payment" },
    { id: "totalAmount", label: "Amount", type: "currency" },
    { id: "createdAt", label: "Registered", type: "datetime" },
  ];
}

/**
 * Get table column definitions for a registration table.
 * Returns dynamic columns from form schema + fixed columns from registration model.
 * Fixed column labels are derived from the form's first step fields.
 * Conditional "specify other" fields are merged with their parent columns.
 */
export async function getRegistrationTableColumns(
  eventId: string,
): Promise<RegistrationTableColumns> {
  const form = await prisma.form.findFirst({
    where: { eventId, type: "REGISTRATION" },
    select: { schema: true },
  });

  if (!form?.schema) {
    return { formColumns: [], fixedColumns: getDefaultFixedColumns() };
  }

  const schema = form.schema as FormSchemaSteps;
  const allFields = schema.steps.flatMap((s) => s.fields);
  const firstStep = schema.steps[0];
  const firstStepFields = firstStep?.fields ?? [];

  // Extract contact field labels from first step by type
  const emailField = firstStepFields.find((f) => f.type === "email");
  const phoneField = firstStepFields.find((f) => f.type === "phone");
  // Support new firstName/lastName types with fallback to positional text fields for legacy forms
  const textFields = firstStepFields.filter((f) => f.type === "text");
  const firstNameField = firstStepFields.find((f) => f.type === "firstName") ?? textFields[0];
  const lastNameField = firstStepFields.find((f) => f.type === "lastName") ?? textFields[1];

  const emailLabel = emailField?.label ?? "Email";
  const firstNameLabel = firstNameField?.label ?? "First Name";
  const lastNameLabel = lastNameField?.label ?? "Last Name";
  const phoneLabel = phoneField?.label ?? "Phone";

  // Track contact field IDs to exclude from formColumns (avoid duplicates)
  const contactFieldIds = new Set<string>(
    [
      emailField?.id,
      firstNameField?.id,
      lastNameField?.id,
      phoneField?.id,
    ].filter((id): id is string => Boolean(id)),
  );

  // Track which fields should be merged (excluded as standalone columns)
  const mergedChildFieldIds = new Set<string>();

  // First pass: identify all merged child fields
  for (const field of allFields) {
    const specifyOtherChild = findSpecifyOtherChild(field, allFields);
    if (specifyOtherChild) {
      mergedChildFieldIds.add(specifyOtherChild.id);
    }
  }

  // Build form columns with merge metadata
  const formColumns = schema.steps.flatMap((step, stepIndex) =>
    step.fields
      .filter((f) => !["heading", "paragraph"].includes(f.type))
      .filter((f) => !(stepIndex === 0 && contactFieldIds.has(f.id)))
      .filter((f) => !mergedChildFieldIds.has(f.id)) // Exclude merged children
      .map((field) => {
        const specifyOtherChild = findSpecifyOtherChild(field, allFields);

        if (specifyOtherChild) {
          // Find the trigger value from the child's condition
          const triggerCondition = specifyOtherChild.conditions?.find(
            (c) => c.fieldId === field.id && c.operator === "equals",
          );

          return {
            id: field.id,
            label: field.label ?? field.id,
            type: field.type,
            options: field.options?.map((opt) => ({
              id: opt.id,
              label: opt.label,
            })),
            mergeWith: {
              fieldId: specifyOtherChild.id,
              triggerValue: String(triggerCondition?.value ?? "other"),
            },
          };
        }

        return {
          id: field.id,
          label: field.label ?? field.id,
          type: field.type,
          options: field.options?.map((opt) => ({
            id: opt.id,
            label: opt.label,
          })),
        };
      }),
  );

  // Fixed columns with labels from form schema
  const fixedColumns = [
    { id: "email", label: emailLabel, type: "email" },
    { id: "firstName", label: firstNameLabel, type: "text" },
    { id: "lastName", label: lastNameLabel, type: "text" },
    { id: "phone", label: phoneLabel, type: "phone" },
    { id: "paymentStatus", label: "Payment", type: "payment" },
    { id: "totalAmount", label: "Amount", type: "currency" },
    { id: "createdAt", label: "Registered", type: "datetime" },
  ];

  return { formColumns, fixedColumns };
}
