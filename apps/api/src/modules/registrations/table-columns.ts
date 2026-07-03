import type { FormField } from "@app/shared";
import { getRegistrationFormSchemaForEvent, type DbExecutor } from "@app/db";
import type { RegistrationColumnsResponse } from "@app/contracts";

type FormSchemaSteps = {
  steps: Array<{ fields: FormField[] }>;
};

const SPECIFY_OTHER_TRIGGER_VALUES = ["other", "autre", "other_diet"];

function findSpecifyOtherChild(
  parentField: FormField,
  allFields: FormField[],
): FormField | null {
  if (!["dropdown", "radio"].includes(parentField.type)) return null;
  const hasOtherOption = parentField.options?.some((opt) =>
    SPECIFY_OTHER_TRIGGER_VALUES.includes(opt.id.toLowerCase()),
  );
  if (!hasOtherOption) return null;
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

function getDefaultFixedColumns() {
  return [
    { id: "email", label: "Email", type: "email" as const },
    { id: "firstName", label: "First Name", type: "text" as const },
    { id: "lastName", label: "Last Name", type: "text" as const },
    { id: "phone", label: "Phone", type: "phone" as const },
    { id: "paymentStatus", label: "Payment", type: "payment" as const },
    { id: "totalAmount", label: "Amount", type: "currency" as const },
    { id: "createdAt", label: "Registered", type: "datetime" as const },
  ];
}

/**
 * Dynamic column defs for the admin registrations grid. No form → default fixed
 * columns + empty form columns. With a form: derives contact-field labels from
 * the first step (typed fields, falling back to positional plain text fields),
 * excludes heading/paragraph and contact fields, and folds "specify other" child
 * fields into their parent column via mergeWith metadata.
 */
export async function getRegistrationTableColumns(
  eventId: string,
  db?: DbExecutor,
): Promise<RegistrationColumnsResponse> {
  const form = await getRegistrationFormSchemaForEvent(eventId, db);
  if (!form?.schema) {
    return { formColumns: [], fixedColumns: getDefaultFixedColumns() };
  }

  const schema = form.schema as FormSchemaSteps;
  const allFields = schema.steps.flatMap((s) => s.fields);
  const firstStepFields = schema.steps[0]?.fields ?? [];

  const emailField = firstStepFields.find((f) => f.type === "email");
  const phoneField = firstStepFields.find((f) => f.type === "phone");
  const textFields = firstStepFields.filter((f) => f.type === "text");
  const firstNameField =
    firstStepFields.find((f) => f.type === "firstName") ?? textFields[0];
  const lastNameField =
    firstStepFields.find((f) => f.type === "lastName") ?? textFields[1];

  const emailLabel = emailField?.label ?? "Email";
  const firstNameLabel = firstNameField?.label ?? "First Name";
  const lastNameLabel = lastNameField?.label ?? "Last Name";
  const phoneLabel = phoneField?.label ?? "Phone";

  const contactFieldIds = new Set<string>(
    [emailField?.id, firstNameField?.id, lastNameField?.id, phoneField?.id].filter(
      (id): id is string => Boolean(id),
    ),
  );

  const mergedChildFieldIds = new Set<string>();
  for (const field of allFields) {
    const child = findSpecifyOtherChild(field, allFields);
    if (child) mergedChildFieldIds.add(child.id);
  }

  const formColumns = schema.steps.flatMap((step, stepIndex) =>
    step.fields
      .filter((f) => !["heading", "paragraph"].includes(f.type))
      .filter((f) => !(stepIndex === 0 && contactFieldIds.has(f.id)))
      .filter((f) => !mergedChildFieldIds.has(f.id))
      .map((field) => {
        const child = findSpecifyOtherChild(field, allFields);
        const base = {
          id: field.id,
          label: field.label ?? field.id,
          type: field.type,
          options: field.options?.map((opt) => ({
            id: opt.id,
            label: opt.label,
          })),
        };
        if (child) {
          const triggerCondition = child.conditions?.find(
            (c) => c.fieldId === field.id && c.operator === "equals",
          );
          return {
            ...base,
            mergeWith: {
              fieldId: child.id,
              triggerValue: String(triggerCondition?.value ?? "other"),
            },
          };
        }
        return base;
      }),
  );

  const fixedColumns = [
    { id: "email", label: emailLabel, type: "email" as const },
    { id: "firstName", label: firstNameLabel, type: "text" as const },
    { id: "lastName", label: lastNameLabel, type: "text" as const },
    { id: "phone", label: phoneLabel, type: "phone" as const },
    { id: "paymentStatus", label: "Payment", type: "payment" as const },
    { id: "totalAmount", label: "Amount", type: "currency" as const },
    { id: "createdAt", label: "Registered", type: "datetime" as const },
  ];

  return { formColumns, fixedColumns } as RegistrationColumnsResponse;
}
