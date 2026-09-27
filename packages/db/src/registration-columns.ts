import type { FormField } from "@app/contracts";

type FormSchemaSteps = { steps: Array<{ fields: FormField[] }> };

export interface RegistrationFormColumn {
  id: string;
  label: string;
  type: string;
  options?: Array<{ id: string; label: string }>;
  mergeWith?: { fieldId: string; triggerValue: string };
}

export interface RegistrationTableColumns {
  formColumns: RegistrationFormColumn[];
  fixedColumns: Array<{ id: string; label: string; type: string }>;
}

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
          SPECIFY_OTHER_TRIGGER_VALUES.includes(String(cond.value ?? "").toLowerCase()),
      ),
    ) ?? null
  );
}

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

/** Derive grid/export columns without reading the database or changing stored-schema semantics. */
export function deriveRegistrationTableColumns(
  formSchema: unknown,
): RegistrationTableColumns {
  if (!formSchema) {
    return { formColumns: [], fixedColumns: getDefaultFixedColumns() };
  }

  const schema = formSchema as FormSchemaSteps;
  const allFields = schema.steps.flatMap((s) => s.fields);
  const firstStep = schema.steps[0];
  const firstStepFields = firstStep?.fields ?? [];

  const emailField = firstStepFields.find((f) => f.type === "email");
  const phoneField = firstStepFields.find((f) => f.type === "phone");
  const textFields = firstStepFields.filter((f) => f.type === "text");
  const firstNameField = firstStepFields.find((f) => f.type === "firstName") ?? textFields[0];
  const lastNameField = firstStepFields.find((f) => f.type === "lastName") ?? textFields[1];

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
    const specifyOtherChild = findSpecifyOtherChild(field, allFields);
    if (specifyOtherChild) mergedChildFieldIds.add(specifyOtherChild.id);
  }

  const formColumns: RegistrationFormColumn[] = schema.steps.flatMap((step, stepIndex) =>
    step.fields
      .filter((f) => !["heading", "paragraph"].includes(f.type))
      .filter((f) => !(stepIndex === 0 && contactFieldIds.has(f.id)))
      .filter((f) => !mergedChildFieldIds.has(f.id))
      .map((field) => {
        const specifyOtherChild = findSpecifyOtherChild(field, allFields);
        if (specifyOtherChild) {
          const triggerCondition = specifyOtherChild.conditions?.find(
            (c) => c.fieldId === field.id && c.operator === "equals",
          );
          return {
            id: field.id,
            label: field.label ?? field.id,
            type: field.type,
            options: field.options?.map((opt) => ({ id: opt.id, label: opt.label })),
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
          options: field.options?.map((opt) => ({ id: opt.id, label: opt.label })),
        };
      }),
  );

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
