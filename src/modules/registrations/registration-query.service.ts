import { prisma } from "@/database/client.js";
import {
  paginate,
  getSkip,
  type PaginatedResult,
} from "@shared/utils/pagination.js";
import type {
  ListRegistrationAuditLogsQuery,
  RegistrationAuditLog,
  ListRegistrationEmailLogsQuery,
  RegistrationEmailLog,
  SearchRegistrantsQuery,
  RegistrantSearchResult,
} from "./registrations.schema.js";
import { Prisma } from "@/generated/prisma/client.js";

// ============================================================================
// Form Schema Types (lightweight types for raw JSONB form data)
// ============================================================================

type FieldCondition = {
  fieldId: string;
  operator: string;
  value?: string | number | boolean;
};

type FormField = {
  id: string;
  type: string;
  label?: string;
  options?: Array<{ id: string; label: string; value?: string }>;
  conditions?: FieldCondition[];
};

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

// ============================================================================
// Table Columns (for dynamic table rendering)
// ============================================================================

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
    return {
      formColumns: [],
      fixedColumns: [
        { id: "email", label: "Email", type: "email" },
        { id: "firstName", label: "First Name", type: "text" },
        { id: "lastName", label: "Last Name", type: "text" },
        { id: "phone", label: "Phone", type: "phone" },
        { id: "paymentStatus", label: "Payment", type: "payment" },
        { id: "totalAmount", label: "Amount", type: "currency" },
        { id: "createdAt", label: "Registered", type: "datetime" },
      ],
    };
  }

  const schema = form.schema as FormSchemaSteps;
  const allFields = schema.steps.flatMap((s) => s.fields);
  const firstStep = schema.steps[0];
  const firstStepFields = firstStep?.fields ?? [];

  // Extract contact field labels from first step by type
  const emailField = firstStepFields.find((f) => f.type === "email");
  const textFields = firstStepFields.filter((f) => f.type === "text");
  const phoneField = firstStepFields.find((f) => f.type === "phone");

  const emailLabel = emailField?.label ?? "Email";
  const firstNameLabel = textFields[0]?.label ?? "First Name";
  const lastNameLabel = textFields[1]?.label ?? "Last Name";
  const phoneLabel = phoneField?.label ?? "Phone";

  // Track contact field IDs to exclude from formColumns (avoid duplicates)
  const contactFieldIds = new Set<string>(
    [
      emailField?.id,
      textFields[0]?.id,
      textFields[1]?.id,
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

// ============================================================================
// Audit & Email Log Queries
// ============================================================================

/**
 * List audit logs for a registration.
 * Returns paginated results with resolved performer names.
 */
export async function listRegistrationAuditLogs(
  registrationId: string,
  query: ListRegistrationAuditLogsQuery,
): Promise<PaginatedResult<RegistrationAuditLog>> {
  const { page, limit } = query;
  const skip = getSkip({ page, limit });

  const where = { entityType: "Registration", entityId: registrationId };

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      skip,
      take: limit,
      orderBy: { performedAt: "desc" },
    }),
    prisma.auditLog.count({ where }),
  ]);

  // Collect user IDs to resolve names
  const userIds = logs
    .map((l) => l.performedBy)
    .filter(
      (id): id is string => id !== null && id !== "SYSTEM" && id !== "PUBLIC",
    );

  const uniqueUserIds = [...new Set(userIds)];

  const users =
    uniqueUserIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: uniqueUserIds } },
          select: { id: true, name: true },
        })
      : [];

  const userMap = new Map(users.map((u) => [u.id, u.name]));

  const enrichedLogs: RegistrationAuditLog[] = logs.map((log) => ({
    id: log.id,
    action: log.action as RegistrationAuditLog["action"],
    changes: log.changes as Record<
      string,
      { old: unknown; new: unknown }
    > | null,
    performedBy: log.performedBy,
    performedByName:
      log.performedBy === "SYSTEM"
        ? "System"
        : log.performedBy === "PUBLIC"
          ? "Registrant (Self-Edit)"
          : (userMap.get(log.performedBy!) ?? null),
    performedAt: log.performedAt.toISOString(),
    ipAddress: log.ipAddress,
  }));

  return paginate(enrichedLogs, total, { page, limit });
}

/**
 * List email logs for a registration.
 * Returns paginated results with template names.
 */
export async function listRegistrationEmailLogs(
  registrationId: string,
  query: ListRegistrationEmailLogsQuery,
): Promise<PaginatedResult<RegistrationEmailLog>> {
  const { page, limit } = query;
  const skip = getSkip({ page, limit });

  const where = { registrationId };

  const [logs, total] = await Promise.all([
    prisma.emailLog.findMany({
      where,
      skip,
      take: limit,
      include: {
        template: { select: { name: true } },
      },
      orderBy: { queuedAt: "desc" },
    }),
    prisma.emailLog.count({ where }),
  ]);

  const enrichedLogs: RegistrationEmailLog[] = logs.map((log) => ({
    id: log.id,
    subject: log.subject,
    status: log.status as RegistrationEmailLog["status"],
    trigger: log.trigger as RegistrationEmailLog["trigger"],
    templateName: log.template?.name ?? null,
    errorMessage: log.errorMessage,
    queuedAt: log.queuedAt.toISOString(),
    sentAt: log.sentAt?.toISOString() ?? null,
    deliveredAt: log.deliveredAt?.toISOString() ?? null,
    openedAt: log.openedAt?.toISOString() ?? null,
    clickedAt: log.clickedAt?.toISOString() ?? null,
    bouncedAt: log.bouncedAt?.toISOString() ?? null,
    failedAt: log.failedAt?.toISOString() ?? null,
  }));

  return paginate(enrichedLogs, total, { page, limit });
}

// ============================================================================
// Registrant Search (for Linked Account Sponsorship)
// ============================================================================

/**
 * Search registrants by name or email for sponsorship linking.
 * Used when sponsorship mode is LINKED_ACCOUNT.
 */
export async function searchRegistrantsForSponsorship(
  eventId: string,
  query: SearchRegistrantsQuery,
): Promise<RegistrantSearchResult[]> {
  const { query: searchQuery, unpaidOnly, limit } = query;

  const where: Prisma.RegistrationWhereInput = {
    eventId,
    OR: [
      { email: { contains: searchQuery, mode: "insensitive" } },
      { firstName: { contains: searchQuery, mode: "insensitive" } },
      { lastName: { contains: searchQuery, mode: "insensitive" } },
    ],
  };

  // Filter to unpaid only if requested
  if (unpaidOnly) {
    where.paymentStatus = { in: ["PENDING", "VERIFYING"] };
  }

  const registrations = await prisma.registration.findMany({
    where,
    take: limit,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      paymentStatus: true,
      totalAmount: true,
      sponsorshipAmount: true,
      accessTypeIds: true,
      phone: true,
      formData: true,
      sponsorshipUsages: {
        select: {
          sponsorship: {
            select: {
              status: true,
              coversBasePrice: true,
              coveredAccessIds: true,
            },
          },
        },
      },
    },
  });

  return registrations.map((r) => {
    // Aggregate coverage from USED sponsorships only
    const usedSponsorships = r.sponsorshipUsages
      .map((u) => u.sponsorship)
      .filter((s) => s.status === "USED");

    const isBasePriceCovered = usedSponsorships.some((s) => s.coversBasePrice);
    const coveredAccessIds = [
      ...new Set(usedSponsorships.flatMap((s) => s.coveredAccessIds)),
    ];

    return {
      id: r.id,
      email: r.email,
      firstName: r.firstName,
      lastName: r.lastName,
      paymentStatus: r.paymentStatus as RegistrantSearchResult["paymentStatus"],
      totalAmount: r.totalAmount,
      sponsorshipAmount: r.sponsorshipAmount,
      accessTypeIds: r.accessTypeIds,
      coveredAccessIds,
      isBasePriceCovered,
      phone: r.phone,
      formData: r.formData as Record<string, unknown> | null,
    };
  });
}
