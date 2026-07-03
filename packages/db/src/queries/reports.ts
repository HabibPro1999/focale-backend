// ============================================================================
// Reports Module — DB query layer (read-only)
//
// Every fn here is a pure data fetch (no writes, no transactions — the legacy
// reports module was entirely read-only; READ COMMITTED default is fine). The
// api-layer service/generators consume these and do all formatting/aggregation
// math. Raw-SQL semantics (jsonb_array_elements LATERAL, DATE() grouping,
// settled-only access breakdown) are preserved byte-for-byte via drizzle `sql`.
// ============================================================================

import {
  and,
  asc,
  avg,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  sum,
  type SQL,
} from "drizzle-orm";
import type { FormField } from "@app/contracts";
import { getDb } from "../client";
import { rowsOf } from "../helpers";
import { registrations, paymentTransaction } from "../schema/registrations";
import { events, eventAccess, accessCheckIns } from "../schema/events-access";
import { eventPricing } from "../schema/pricing";
import { forms } from "../schema/forms";
import {
  sponsorships,
  sponsorshipBatches,
  sponsorshipUsages,
} from "../schema/sponsorships";
// Reports filters sponsorships exactly the way the sponsorships module does.
import { buildSponsorshipWhere } from "./sponsorships";

type RegistrationRow = typeof registrations.$inferSelect;

/** sum() over an integer column returns string|null; coerce to a JS number. */
function num(v: string | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

// ============================================================================
// Shared where builders
// ============================================================================

export interface DateRange {
  startDate: Date | null;
  endDate: Date | null;
}

/**
 * eventId + optional submitted_at gte/lte. Merge semantics match the legacy
 * dateWhere object (only-endDate sets lte, only-startDate sets gte).
 */
function eventDateWhere(eventId: string, dateRange: DateRange, extra?: SQL): SQL {
  const clauses: (SQL | undefined)[] = [eq(registrations.eventId, eventId)];
  if (dateRange.startDate) clauses.push(gte(registrations.submittedAt, dateRange.startDate));
  if (dateRange.endDate) clauses.push(lte(registrations.submittedAt, dateRange.endDate));
  if (extra) clauses.push(extra);
  return and(...clauses) as SQL;
}

/**
 * Port of the legacy `buildRegistrationWhere` (registrations module). Case-
 * insensitive search OR across email/firstName/lastName/phone/referenceNumber.
 * `role` filter param exists in legacy but reports never passes it — omitted.
 */
export interface RegistrationExportFilters {
  paymentStatus?: string;
  paymentMethod?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
}

function buildRegistrationWhere(
  eventId: string,
  filters: RegistrationExportFilters,
): SQL {
  const clauses: (SQL | undefined)[] = [eq(registrations.eventId, eventId)];
  if (filters.paymentStatus) {
    clauses.push(
      eq(registrations.paymentStatus, filters.paymentStatus as RegistrationRow["paymentStatus"]),
    );
  }
  if (filters.paymentMethod) {
    clauses.push(
      eq(
        registrations.paymentMethod,
        filters.paymentMethod as NonNullable<RegistrationRow["paymentMethod"]>,
      ),
    );
  }
  if (filters.search) {
    const term = `%${filters.search}%`;
    clauses.push(
      or(
        ilike(registrations.email, term),
        ilike(registrations.firstName, term),
        ilike(registrations.lastName, term),
        ilike(registrations.phone, term),
        ilike(registrations.referenceNumber, term),
      ),
    );
  }
  // Date range merged with the same only-set-what-was-given semantics.
  if (filters.startDate) clauses.push(gte(registrations.submittedAt, new Date(filters.startDate)));
  if (filters.endDate) clauses.push(lte(registrations.submittedAt, new Date(filters.endDate)));
  return and(...clauses) as SQL;
}

// ============================================================================
// Financial report
// ============================================================================

export interface FinancialCurrencyRow {
  currency: string;
  totalAmount: number;
  paidAmount: number;
  baseAmount: number;
  accessAmount: number;
  discountAmount: number;
  sponsorshipAmount: number;
  count: number;
}

export interface FinancialSummaryAggregates {
  byCurrency: FinancialCurrencyRow[];
  pendingByCurrency: Array<{ currency: string; totalAmount: number; paidAmount: number }>;
  refundedByCurrency: Array<{ currency: string; totalAmount: number }>;
  revenueByCurrency: Array<{ currency: string; paidAmount: number }>;
  overall: {
    totalAmount: number;
    paidAmount: number;
    baseAmount: number;
    accessAmount: number;
    discountAmount: number;
    sponsorshipAmount: number;
    avgTotalAmount: number;
    count: number;
  };
  overallRevenuePaid: number;
}

const PENDING_STATUSES = ["PENDING", "VERIFYING", "PARTIAL"] as const;

export async function getFinancialSummaryAggregates(
  eventId: string,
  dateRange: DateRange,
): Promise<FinancialSummaryAggregates> {
  const db = getDb();
  const base = eventDateWhere(eventId, dateRange);

  const [byCurrency, pendingByCurrency, refundedByCurrency, revenueByCurrency, overallRow, overallRevenueRow] =
    await Promise.all([
      db
        .select({
          currency: registrations.currency,
          totalAmount: sum(registrations.totalAmount),
          paidAmount: sum(registrations.paidAmount),
          baseAmount: sum(registrations.baseAmount),
          accessAmount: sum(registrations.accessAmount),
          discountAmount: sum(registrations.discountAmount),
          sponsorshipAmount: sum(registrations.sponsorshipAmount),
          count: count(),
        })
        .from(registrations)
        .where(base)
        .groupBy(registrations.currency),
      db
        .select({
          currency: registrations.currency,
          totalAmount: sum(registrations.totalAmount),
          paidAmount: sum(registrations.paidAmount),
        })
        .from(registrations)
        .where(
          eventDateWhere(
            eventId,
            dateRange,
            inArray(registrations.paymentStatus, PENDING_STATUSES as unknown as RegistrationRow["paymentStatus"][]),
          ),
        )
        .groupBy(registrations.currency),
      db
        .select({
          currency: registrations.currency,
          totalAmount: sum(registrations.totalAmount),
        })
        .from(registrations)
        .where(eventDateWhere(eventId, dateRange, eq(registrations.paymentStatus, "REFUNDED")))
        .groupBy(registrations.currency),
      db
        .select({
          currency: registrations.currency,
          paidAmount: sum(registrations.paidAmount),
        })
        .from(registrations)
        .where(
          eventDateWhere(
            eventId,
            dateRange,
            sql`${registrations.paymentStatus} != 'REFUNDED'`,
          ),
        )
        .groupBy(registrations.currency),
      db
        .select({
          totalAmount: sum(registrations.totalAmount),
          paidAmount: sum(registrations.paidAmount),
          baseAmount: sum(registrations.baseAmount),
          accessAmount: sum(registrations.accessAmount),
          discountAmount: sum(registrations.discountAmount),
          sponsorshipAmount: sum(registrations.sponsorshipAmount),
          avgTotalAmount: avg(registrations.totalAmount),
          count: count(),
        })
        .from(registrations)
        .where(base),
      db
        .select({ paidAmount: sum(registrations.paidAmount) })
        .from(registrations)
        .where(eventDateWhere(eventId, dateRange, sql`${registrations.paymentStatus} != 'REFUNDED'`)),
    ]);

  const overall = overallRow[0];
  return {
    byCurrency: byCurrency.map((c) => ({
      currency: c.currency,
      totalAmount: num(c.totalAmount),
      paidAmount: num(c.paidAmount),
      baseAmount: num(c.baseAmount),
      accessAmount: num(c.accessAmount),
      discountAmount: num(c.discountAmount),
      sponsorshipAmount: num(c.sponsorshipAmount),
      count: c.count,
    })),
    pendingByCurrency: pendingByCurrency.map((p) => ({
      currency: p.currency,
      totalAmount: num(p.totalAmount),
      paidAmount: num(p.paidAmount),
    })),
    refundedByCurrency: refundedByCurrency.map((r) => ({
      currency: r.currency,
      totalAmount: num(r.totalAmount),
    })),
    revenueByCurrency: revenueByCurrency.map((r) => ({
      currency: r.currency,
      paidAmount: num(r.paidAmount),
    })),
    overall: {
      totalAmount: num(overall?.totalAmount),
      paidAmount: num(overall?.paidAmount),
      baseAmount: num(overall?.baseAmount),
      accessAmount: num(overall?.accessAmount),
      discountAmount: num(overall?.discountAmount),
      sponsorshipAmount: num(overall?.sponsorshipAmount),
      avgTotalAmount: num(overall?.avgTotalAmount),
      count: overall?.count ?? 0,
    },
    overallRevenuePaid: num(overallRevenueRow[0]?.paidAmount),
  };
}

export interface PaymentStatusBreakdownRow {
  paymentStatus: string;
  count: number;
  totalAmount: number;
}

export async function getPaymentStatusBreakdown(
  eventId: string,
  dateRange: DateRange,
): Promise<PaymentStatusBreakdownRow[]> {
  const rows = await getDb()
    .select({
      paymentStatus: registrations.paymentStatus,
      count: count(),
      totalAmount: sum(registrations.totalAmount),
    })
    .from(registrations)
    .where(eventDateWhere(eventId, dateRange))
    .groupBy(registrations.paymentStatus);
  return rows.map((g) => ({
    paymentStatus: g.paymentStatus,
    count: g.count,
    totalAmount: num(g.totalAmount),
  }));
}

export interface AccessBreakdownRow {
  accessType: string;
  count: number;
  totalAmount: number;
}

/**
 * Settled-only (PAID/SPONSORED/WAIVED) breakdown unnested from the
 * price_breakdown JSONB accessItems array. NOTE the deliberate divergence from
 * the top-level financial summary, which counts ALL statuses — this raw SQL
 * counts only settled registrations. Ported byte-for-byte.
 */
export async function getAccessBreakdown(
  eventId: string,
  dateRange: DateRange,
): Promise<AccessBreakdownRow[]> {
  const db = getDb();
  const startDateCondition = dateRange.startDate
    ? sql` AND r.submitted_at >= ${dateRange.startDate}`
    : sql``;
  const endDateCondition = dateRange.endDate
    ? sql` AND r.submitted_at <= ${dateRange.endDate}`
    : sql``;

  const res = await db.execute(sql`
    SELECT
      (item->>'accessId')::TEXT AS access_id,
      COUNT(*) AS count,
      COALESCE(SUM((item->>'subtotal')::INTEGER), 0) AS total_amount
    FROM registrations r,
    LATERAL jsonb_array_elements(r.price_breakdown->'accessItems') AS item
    WHERE r.event_id = ${eventId}
      AND r.payment_status IN ('PAID', 'SPONSORED', 'WAIVED')
      AND jsonb_array_length(COALESCE(r.price_breakdown->'accessItems', '[]'::jsonb)) > 0
      ${startDateCondition}
      ${endDateCondition}
    GROUP BY (item->>'accessId')::TEXT
  `);
  const accessData = rowsOf<{ access_id: string; count: bigint | string; total_amount: bigint | string }>(res);

  const accessIds = accessData.map((a) => a.access_id);
  if (accessIds.length === 0) return [];

  const accessItems = await db
    .select({ id: eventAccess.id, name: eventAccess.name, type: eventAccess.type })
    .from(eventAccess)
    .where(inArray(eventAccess.id, accessIds));

  const accessMap = new Map(accessItems.map((a) => [a.id, a]));
  return accessData.map((g) => {
    const access = accessMap.get(g.access_id);
    return {
      accessType: access?.name ?? access?.type ?? "Unknown",
      count: Number(g.count),
      totalAmount: Number(g.total_amount),
    };
  });
}

export interface DailyTrendRow {
  date: Date;
  count: number;
  totalAmount: number;
}

/** DATE(submitted_at) grouping — the service formats date -> YYYY-MM-DD. */
export async function getDailyTrendRows(
  eventId: string,
  dateRange: DateRange,
): Promise<DailyTrendRow[]> {
  const endDate = dateRange.endDate ?? new Date();
  const startDate =
    dateRange.startDate ?? new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  const res = await getDb().execute(sql`
    SELECT
      DATE(submitted_at) as date,
      COUNT(*) as count,
      COALESCE(SUM(total_amount), 0) as total_amount
    FROM registrations
    WHERE event_id = ${eventId}
      AND submitted_at >= ${startDate}
      AND submitted_at <= ${endDate}
    GROUP BY DATE(submitted_at)
    ORDER BY date ASC
  `);
  return rowsOf<{ date: Date; count: bigint | string; total_amount: bigint | string }>(res).map(
    (r) => ({
      date: r.date instanceof Date ? r.date : new Date(r.date),
      count: Number(r.count),
      totalAmount: Number(r.total_amount),
    }),
  );
}

// ============================================================================
// Event analytics
// ============================================================================

export interface EventAnalyticsData {
  paymentsByStatus: Array<{ paymentStatus: string; count: number }>;
  paymentsByMethod: Array<{ paymentMethod: string | null; count: number }>;
  accessItems: Array<{
    id: string;
    name: string;
    type: string;
    registeredCount: number;
    maxCapacity: number | null;
  }>;
  sponsorshipsByStatus: Array<{ status: string; count: number }>;
}

export async function getEventAnalyticsData(eventId: string): Promise<EventAnalyticsData> {
  const db = getDb();
  const [paymentsByStatus, paymentsByMethod, accessItems, sponsorshipsByStatus] =
    await Promise.all([
      db
        .select({ paymentStatus: registrations.paymentStatus, count: count() })
        .from(registrations)
        .where(eq(registrations.eventId, eventId))
        .groupBy(registrations.paymentStatus),
      db
        .select({ paymentMethod: registrations.paymentMethod, count: count() })
        .from(registrations)
        .where(eq(registrations.eventId, eventId))
        .groupBy(registrations.paymentMethod),
      db
        .select({
          id: eventAccess.id,
          name: eventAccess.name,
          type: eventAccess.type,
          registeredCount: eventAccess.registeredCount,
          maxCapacity: eventAccess.maxCapacity,
        })
        .from(eventAccess)
        .where(eq(eventAccess.eventId, eventId))
        .orderBy(asc(eventAccess.startsAt)),
      db
        .select({ status: sponsorships.status, count: count() })
        .from(sponsorships)
        .where(eq(sponsorships.eventId, eventId))
        .groupBy(sponsorships.status),
    ]);
  return { paymentsByStatus, paymentsByMethod, accessItems, sponsorshipsByStatus };
}

// ============================================================================
// Access registrants drill-down
// ============================================================================

export interface AccessRegistrantRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  paymentStatus: string;
  paidAmount: number;
  totalAmount: number;
  currency: string;
  submittedAt: Date;
}

export interface AccessRegistrantsData {
  access: { name: string; type: string } | null;
  registrations: AccessRegistrantRow[];
}

export async function getAccessRegistrantsData(
  eventId: string,
  accessId: string,
): Promise<AccessRegistrantsData> {
  const db = getDb();
  const [access, regs] = await Promise.all([
    db
      .select({ name: eventAccess.name, type: eventAccess.type })
      .from(eventAccess)
      .where(and(eq(eventAccess.id, accessId), eq(eventAccess.eventId, eventId)))
      .limit(1),
    db
      .select({
        id: registrations.id,
        firstName: registrations.firstName,
        lastName: registrations.lastName,
        email: registrations.email,
        phone: registrations.phone,
        paymentStatus: registrations.paymentStatus,
        paidAmount: registrations.paidAmount,
        totalAmount: registrations.totalAmount,
        currency: registrations.currency,
        submittedAt: registrations.submittedAt,
      })
      .from(registrations)
      .where(
        and(
          eq(registrations.eventId, eventId),
          sql`${accessId} = ANY(${registrations.accessTypeIds})`,
        ),
      )
      .orderBy(desc(registrations.submittedAt)),
  ]);
  return { access: access[0] ?? null, registrations: regs };
}

// ============================================================================
// CSV / JSON / XLSX registrations export (GET)
// ============================================================================

export async function getEventSlug(eventId: string): Promise<{ slug: string } | null> {
  const rows = await getDb()
    .select({ slug: events.slug })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return rows[0] ?? null;
}

export interface ExportRegistrationRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  paymentStatus: string;
  paymentMethod: string | null;
  totalAmount: number;
  paidAmount: number;
  baseAmount: number;
  accessAmount: number;
  discountAmount: number;
  sponsorshipCode: string | null;
  sponsorshipAmount: number;
  submittedAt: Date;
  paidAt: Date | null;
  formData: unknown;
}

export async function getRegistrationsForExport(
  eventId: string,
  filters: RegistrationExportFilters,
): Promise<ExportRegistrationRow[]> {
  return getDb()
    .select({
      id: registrations.id,
      email: registrations.email,
      firstName: registrations.firstName,
      lastName: registrations.lastName,
      phone: registrations.phone,
      paymentStatus: registrations.paymentStatus,
      paymentMethod: registrations.paymentMethod,
      totalAmount: registrations.totalAmount,
      paidAmount: registrations.paidAmount,
      baseAmount: registrations.baseAmount,
      accessAmount: registrations.accessAmount,
      discountAmount: registrations.discountAmount,
      sponsorshipCode: registrations.sponsorshipCode,
      sponsorshipAmount: registrations.sponsorshipAmount,
      submittedAt: registrations.submittedAt,
      paidAt: registrations.paidAt,
      formData: registrations.formData,
    })
    .from(registrations)
    .where(buildRegistrationWhere(eventId, filters))
    .orderBy(desc(registrations.submittedAt));
}

// ============================================================================
// getRegistrationTableColumns — form-schema-derived dynamic columns
// (ported from legacy registrations/table-columns.ts; only reports consumes it)
// ============================================================================

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

export async function getRegistrationTableColumns(
  eventId: string,
): Promise<RegistrationTableColumns> {
  const form = (
    await getDb()
      .select({ schema: forms.schema })
      .from(forms)
      .where(and(eq(forms.eventId, eventId), eq(forms.type, "REGISTRATION")))
      .limit(1)
  )[0];

  if (!form?.schema) {
    return { formColumns: [], fixedColumns: getDefaultFixedColumns() };
  }

  const schema = form.schema as FormSchemaSteps;
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

// ============================================================================
// Modular xlsx export (POST) — data fetch with conditional relations
// ============================================================================

export interface EventAccessNameRow {
  id: string;
  name: string;
}

export async function getEventAccessNames(eventId: string): Promise<EventAccessNameRow[]> {
  return getDb()
    .select({ id: eventAccess.id, name: eventAccess.name })
    .from(eventAccess)
    .where(eq(eventAccess.eventId, eventId))
    .orderBy(asc(eventAccess.sortOrder));
}

export async function getEventSlugAndName(
  eventId: string,
): Promise<{ slug: string; name: string } | null> {
  const rows = await getDb()
    .select({ slug: events.slug, name: events.name })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return rows[0] ?? null;
}

export interface ModularTransactionRow {
  type: string;
  amount: number;
  method: string | null;
  reference: string | null;
  note: string | null;
  performedBy: string | null;
  createdAt: Date;
}

export interface ModularAccessCheckInRow {
  accessId: string;
  checkedInAt: Date;
}

// accessTypeIds/droppedAccessIds are nullable STRING[] in the schema but this
// fetch normalizes them to [] (below), so the exposed type is non-null.
export type ModularRegistrationRow = Omit<
  RegistrationRow,
  "accessTypeIds" | "droppedAccessIds"
> & {
  accessTypeIds: string[];
  droppedAccessIds: string[];
  accessCheckIns?: ModularAccessCheckInRow[];
  transactions?: ModularTransactionRow[];
};

export interface ModularExportOptions {
  paymentStatus?: string;
  paymentMethod?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
  needCheckIns: boolean;
  needTransactions: boolean;
}

/**
 * Base registration rows (all scalar columns) + optionally the accessCheckIns
 * and transactions relations. formData is always selected (single jsonb column);
 * the builder only reads it when formFieldIds are requested, so this is output-
 * identical to the legacy conditional select — perf-only divergence.
 */
export async function getRegistrationsForModularExport(
  eventId: string,
  opts: ModularExportOptions,
): Promise<ModularRegistrationRow[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(registrations)
    .where(
      buildRegistrationWhere(eventId, {
        paymentStatus: opts.paymentStatus,
        paymentMethod: opts.paymentMethod,
        search: opts.search,
        startDate: opts.startDate,
        endDate: opts.endDate,
      }),
    )
    .orderBy(desc(registrations.submittedAt));

  const result: ModularRegistrationRow[] = rows.map((r) => ({
    ...r,
    accessTypeIds: r.accessTypeIds ?? [],
    droppedAccessIds: r.droppedAccessIds ?? [],
  }));
  if (result.length === 0) return result;

  const ids = result.map((r) => r.id);

  if (opts.needCheckIns) {
    const checkIns = await db
      .select({
        registrationId: accessCheckIns.registrationId,
        accessId: accessCheckIns.accessId,
        checkedInAt: accessCheckIns.checkedInAt,
      })
      .from(accessCheckIns)
      .where(inArray(accessCheckIns.registrationId, ids));
    const byReg = new Map<string, ModularAccessCheckInRow[]>();
    for (const c of checkIns) {
      const list = byReg.get(c.registrationId) ?? [];
      list.push({ accessId: c.accessId, checkedInAt: c.checkedInAt });
      byReg.set(c.registrationId, list);
    }
    for (const r of result) r.accessCheckIns = byReg.get(r.id) ?? [];
  }

  if (opts.needTransactions) {
    const txs = await db
      .select({
        registrationId: paymentTransaction.registrationId,
        type: paymentTransaction.type,
        amount: paymentTransaction.amount,
        method: paymentTransaction.method,
        reference: paymentTransaction.reference,
        note: paymentTransaction.note,
        performedBy: paymentTransaction.performedBy,
        createdAt: paymentTransaction.createdAt,
      })
      .from(paymentTransaction)
      .where(inArray(paymentTransaction.registrationId, ids))
      .orderBy(asc(paymentTransaction.createdAt));
    const byReg = new Map<string, ModularTransactionRow[]>();
    for (const t of txs) {
      const list = byReg.get(t.registrationId) ?? [];
      list.push({
        type: t.type,
        amount: t.amount,
        method: t.method,
        reference: t.reference,
        note: t.note,
        performedBy: t.performedBy,
        createdAt: t.createdAt,
      });
      byReg.set(t.registrationId, list);
    }
    for (const r of result) r.transactions = byReg.get(r.id) ?? [];
  }

  return result;
}

export interface SponsorshipLabDetail {
  code: string;
  beneficiaryAddress: string | null;
  batch: { labName: string; contactName: string; email: string; phone: string | null };
}

export async function getSponsorshipLabDetails(
  eventId: string,
  codes: string[],
): Promise<SponsorshipLabDetail[]> {
  const uniqueCodes = Array.from(new Set(codes.filter(Boolean)));
  if (uniqueCodes.length === 0) return [];
  return getDb()
    .select({
      code: sponsorships.code,
      beneficiaryAddress: sponsorships.beneficiaryAddress,
      batch: {
        labName: sponsorshipBatches.labName,
        contactName: sponsorshipBatches.contactName,
        email: sponsorshipBatches.email,
        phone: sponsorshipBatches.phone,
      },
    })
    .from(sponsorships)
    .innerJoin(sponsorshipBatches, eq(sponsorships.batchId, sponsorshipBatches.id))
    .where(and(inArray(sponsorships.code, uniqueCodes), eq(sponsorshipBatches.eventId, eventId)));
}

// ============================================================================
// Excel generators — data fetches
// ============================================================================

export interface EventSummaryData {
  event: { name: string; slug: string } | null;
  accessTypes: Array<{ id: string; name: string; type: string }>;
  registrations: Array<{
    id: string;
    paymentStatus: string;
    paymentMethod: string | null;
    accessTypeIds: string[];
    sponsorshipAmount: number;
    totalAmount: number;
  }>;
}

export async function getEventSummaryData(eventId: string): Promise<EventSummaryData> {
  const db = getDb();
  const [event, accessTypes, regs] = await Promise.all([
    getEventSlugAndName(eventId),
    db
      .select({ id: eventAccess.id, name: eventAccess.name, type: eventAccess.type })
      .from(eventAccess)
      .where(eq(eventAccess.eventId, eventId))
      .orderBy(asc(eventAccess.sortOrder)),
    db
      .select({
        id: registrations.id,
        paymentStatus: registrations.paymentStatus,
        paymentMethod: registrations.paymentMethod,
        accessTypeIds: registrations.accessTypeIds,
        sponsorshipAmount: registrations.sponsorshipAmount,
        totalAmount: registrations.totalAmount,
      })
      .from(registrations)
      .where(eq(registrations.eventId, eventId)),
  ]);
  return {
    event,
    accessTypes,
    registrations: regs.map((r) => ({ ...r, accessTypeIds: r.accessTypeIds ?? [] })),
  };
}

export interface AccessRegistrantsReportData {
  event: { name: string; slug: string } | null;
  accessItems: Array<{ id: string; name: string; type: string }>;
  registrations: Array<{
    firstName: string | null;
    lastName: string | null;
    email: string;
    phone: string | null;
    paymentStatus: string;
    totalAmount: number;
    currency: string;
    submittedAt: Date;
    accessTypeIds: string[];
  }>;
}

export async function getAccessRegistrantsReportData(
  eventId: string,
): Promise<AccessRegistrantsReportData> {
  const db = getDb();
  const [event, accessItems] = await Promise.all([
    getEventSlugAndName(eventId),
    db
      .select({ id: eventAccess.id, name: eventAccess.name, type: eventAccess.type })
      .from(eventAccess)
      .where(eq(eventAccess.eventId, eventId))
      .orderBy(asc(eventAccess.sortOrder)),
  ]);
  const regs = await db
    .select({
      firstName: registrations.firstName,
      lastName: registrations.lastName,
      email: registrations.email,
      phone: registrations.phone,
      paymentStatus: registrations.paymentStatus,
      totalAmount: registrations.totalAmount,
      currency: registrations.currency,
      submittedAt: registrations.submittedAt,
      accessTypeIds: registrations.accessTypeIds,
    })
    .from(registrations)
    .where(eq(registrations.eventId, eventId))
    .orderBy(desc(registrations.submittedAt));
  return {
    event,
    accessItems,
    registrations: regs.map((r) => ({ ...r, accessTypeIds: r.accessTypeIds ?? [] })),
  };
}

export interface SponsorshipReportUsage {
  amountApplied: number;
  appliedAt: Date;
  registration: { firstName: string | null; lastName: string | null; email: string } | null;
}

export interface SponsorshipReportRow {
  code: string;
  status: string;
  beneficiaryName: string;
  beneficiaryEmail: string;
  beneficiaryPhone: string | null;
  beneficiaryAddress: string | null;
  coversBasePrice: boolean;
  coveredAccessIds: string[];
  totalAmount: number;
  createdAt: Date;
  batch: { labName: string; contactName: string; email: string; phone: string | null };
  usages: SponsorshipReportUsage[];
}

export interface SponsorshipsReportData {
  event: { name: string; slug: string } | null;
  currency: string;
  accessItems: Array<{ id: string; name: string }>;
  sponsorships: SponsorshipReportRow[];
}

export async function getSponsorshipsReportData(
  eventId: string,
  filters?: { status?: string; search?: string },
): Promise<SponsorshipsReportData> {
  const db = getDb();
  const where = buildSponsorshipWhere(eventId, filters);

  const [event, pricing, accessItems, sponsorshipRows] = await Promise.all([
    getEventSlugAndName(eventId),
    db
      .select({ currency: eventPricing.currency })
      .from(eventPricing)
      .where(eq(eventPricing.eventId, eventId))
      .limit(1),
    db
      .select({ id: eventAccess.id, name: eventAccess.name })
      .from(eventAccess)
      .where(eq(eventAccess.eventId, eventId))
      .orderBy(asc(eventAccess.sortOrder)),
    db
      .select({
        sponsorship: sponsorships,
        batch: {
          labName: sponsorshipBatches.labName,
          contactName: sponsorshipBatches.contactName,
          email: sponsorshipBatches.email,
          phone: sponsorshipBatches.phone,
        },
      })
      .from(sponsorships)
      .innerJoin(sponsorshipBatches, eq(sponsorships.batchId, sponsorshipBatches.id))
      .where(where)
      .orderBy(desc(sponsorships.createdAt)),
  ]);

  // Usages (+ registration) for the fetched sponsorships, ordered appliedAt asc.
  const sponsorshipIds = sponsorshipRows.map((s) => s.sponsorship.id);
  const usagesById = new Map<string, SponsorshipReportUsage[]>();
  if (sponsorshipIds.length > 0) {
    const usageRows = await db
      .select({
        sponsorshipId: sponsorshipUsages.sponsorshipId,
        amountApplied: sponsorshipUsages.amountApplied,
        appliedAt: sponsorshipUsages.appliedAt,
        regFirstName: registrations.firstName,
        regLastName: registrations.lastName,
        regEmail: registrations.email,
        registrationId: sponsorshipUsages.registrationId,
      })
      .from(sponsorshipUsages)
      .leftJoin(registrations, eq(sponsorshipUsages.registrationId, registrations.id))
      .where(inArray(sponsorshipUsages.sponsorshipId, sponsorshipIds))
      .orderBy(asc(sponsorshipUsages.appliedAt));
    for (const u of usageRows) {
      const list = usagesById.get(u.sponsorshipId) ?? [];
      list.push({
        amountApplied: u.amountApplied,
        appliedAt: u.appliedAt,
        registration:
          u.registrationId && u.regEmail
            ? { firstName: u.regFirstName, lastName: u.regLastName, email: u.regEmail }
            : null,
      });
      usagesById.set(u.sponsorshipId, list);
    }
  }

  return {
    event,
    currency: pricing[0]?.currency ?? "TND",
    accessItems,
    sponsorships: sponsorshipRows.map((s) => ({
      code: s.sponsorship.code,
      status: s.sponsorship.status,
      beneficiaryName: s.sponsorship.beneficiaryName,
      beneficiaryEmail: s.sponsorship.beneficiaryEmail,
      beneficiaryPhone: s.sponsorship.beneficiaryPhone,
      beneficiaryAddress: s.sponsorship.beneficiaryAddress,
      coversBasePrice: s.sponsorship.coversBasePrice,
      coveredAccessIds: s.sponsorship.coveredAccessIds ?? [],
      totalAmount: s.sponsorship.totalAmount,
      createdAt: s.sponsorship.createdAt,
      batch: s.batch,
      usages: usagesById.get(s.sponsorship.id) ?? [],
    })),
  };
}

export interface CheckInReportData {
  event: { name: string; slug: string } | null;
  accessItems: Array<{ id: string; name: string }>;
  registrations: Array<{
    id: string;
    referenceNumber: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string;
    phone: string | null;
    paymentStatus: string;
    submittedAt: Date;
    checkedInAt: Date | null;
    accessTypeIds: string[];
    accessCheckIns: Array<{ accessId: string; checkedInAt: Date }>;
  }>;
}

export async function getCheckInReportData(eventId: string): Promise<CheckInReportData> {
  const db = getDb();
  const [event, accessItems] = await Promise.all([
    getEventSlugAndName(eventId),
    db
      .select({ id: eventAccess.id, name: eventAccess.name })
      .from(eventAccess)
      .where(eq(eventAccess.eventId, eventId))
      .orderBy(asc(eventAccess.sortOrder)),
  ]);

  const regs = await db
    .select({
      id: registrations.id,
      referenceNumber: registrations.referenceNumber,
      firstName: registrations.firstName,
      lastName: registrations.lastName,
      email: registrations.email,
      phone: registrations.phone,
      paymentStatus: registrations.paymentStatus,
      submittedAt: registrations.submittedAt,
      checkedInAt: registrations.checkedInAt,
      accessTypeIds: registrations.accessTypeIds,
    })
    .from(registrations)
    .where(eq(registrations.eventId, eventId))
    .orderBy(asc(registrations.submittedAt));

  const checkInRows =
    regs.length === 0
      ? []
      : await db
          .select({
            registrationId: accessCheckIns.registrationId,
            accessId: accessCheckIns.accessId,
            checkedInAt: accessCheckIns.checkedInAt,
          })
          .from(accessCheckIns)
          .where(
            inArray(
              accessCheckIns.registrationId,
              regs.map((r) => r.id),
            ),
          );
  const byReg = new Map<string, Array<{ accessId: string; checkedInAt: Date }>>();
  for (const c of checkInRows) {
    const list = byReg.get(c.registrationId) ?? [];
    list.push({ accessId: c.accessId, checkedInAt: c.checkedInAt });
    byReg.set(c.registrationId, list);
  }

  return {
    event,
    accessItems,
    registrations: regs.map((r) => ({
      ...r,
      accessTypeIds: r.accessTypeIds ?? [],
      accessCheckIns: byReg.get(r.id) ?? [],
    })),
  };
}
