// Report and export file reads: the small header reads a file export runs
// inside withExportStatementTimeout, and the keyset/id-chunk row pages. Read-only;
// see ../reports.ts.

import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { FormField } from "@app/contracts";
import { FULLY_SETTLED_STATUSES } from "@app/shared";
import { getDb, type DbExecutor } from "../../client";
import { rowsOf } from "../../helpers";
import { registrations, paymentTransaction } from "../../schema/registrations";
import { events, eventAccess, accessCheckIns } from "../../schema/events-access";
import { eventPricing } from "../../schema/pricing";
import { forms } from "../../schema/forms";
import {
  sponsorships,
  sponsorshipBatches,
  sponsorshipUsages,
} from "../../schema/sponsorships";
// Reports filters sponsorships exactly the way the sponsorships module does.
import { buildSponsorshipWhere } from "../sponsorships";
// ...and filters registrants with the registrations list's WHERE.
import { buildRegistrationWhere, type RegistrationFilters } from "../registrations";
import { withExportStatementTimeout } from "../../txn";
import { readFormSchema } from "../stored-json";
import {
  exportPageSize,
  pagesByIds,
  type ExportPageOptions,
} from "../export-pages";
import { groupRows } from "./group-rows";

type RegistrationRow = typeof registrations.$inferSelect;

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

const EXPORT_REGISTRATION_COLUMNS = {
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
} satisfies Record<keyof ExportRegistrationRow, unknown>;

// ----------------------------------------------------------------------------
// Keyset paging for exports
// ----------------------------------------------------------------------------

export { EXPORT_PAGE_SIZE, type ExportPageOptions } from "../export-pages";

/** Position after the last row of a page, in export order. */
export interface RegistrationExportCursor {
  submittedAt: Date;
  id: string;
}

/** Export order: newest submission first, id breaking ties. */
const EXPORT_ORDER = [desc(registrations.submittedAt), desc(registrations.id)];
/** Check-in sheets list registrations in submission order. */
const SUBMISSION_ORDER = [asc(registrations.submittedAt), asc(registrations.id)];

/**
 * Rows after `cursor` in EXPORT_ORDER. The `<=` bound on submitted_at keeps
 * the (event_id, submitted_at) index usable; values bind through the column
 * encoders, so the comparison does not depend on the process time zone.
 */
export function registrationsAfter(cursor: RegistrationExportCursor): SQL {
  return and(
    lte(registrations.submittedAt, cursor.submittedAt),
    or(
      lt(registrations.submittedAt, cursor.submittedAt),
      lt(registrations.id, cursor.id),
    ),
  ) as SQL;
}

/** Rows after `cursor` in SUBMISSION_ORDER (the mirror of registrationsAfter). */
export function registrationsAfterAscending(cursor: RegistrationExportCursor): SQL {
  return and(
    gte(registrations.submittedAt, cursor.submittedAt),
    or(
      gt(registrations.submittedAt, cursor.submittedAt),
      gt(registrations.id, cursor.id),
    ),
  ) as SQL;
}

type KeysetDirection = "newest-first" | "oldest-first";

/**
 * Pages the registrations matching `base` by keyset on (submitted_at, id),
 * newest first unless asked otherwise. Each page runs in its own short
 * transaction under the export statement timeout (a slow client never holds
 * a transaction open); `fetchPage` receives the page's WHERE, orders by the
 * same direction, and may load the page's relations in the same transaction.
 */
async function* keysetRegistrationPages<T extends RegistrationExportCursor>(
  base: SQL,
  options: ExportPageOptions,
  fetchPage: (where: SQL, limit: number, tx: DbExecutor) => Promise<T[]>,
  direction: KeysetDirection = "newest-first",
): AsyncGenerator<T[]> {
  const pageSize = exportPageSize(options);
  const after = direction === "newest-first" ? registrationsAfter : registrationsAfterAscending;
  let cursor: RegistrationExportCursor | null = null;
  for (;;) {
    options.signal?.throwIfAborted();
    const where: SQL = cursor ? (and(base, after(cursor)) as SQL) : base;
    const page = await withExportStatementTimeout((tx) => fetchPage(where, pageSize, tx));
    if (page.length > 0) {
      const last = page[page.length - 1]!;
      cursor = { submittedAt: last.submittedAt, id: last.id };
      yield page;
    }
    if (page.length < pageSize) return;
  }
}

/** GET export rows, page by page (see keysetRegistrationPages). */
export function iterateRegistrationsForExport(
  eventId: string,
  filters: RegistrationFilters,
  options: ExportPageOptions = {},
): AsyncGenerator<ExportRegistrationRow[]> {
  return keysetRegistrationPages(buildRegistrationWhere(eventId, filters), options, (where, limit, tx) =>
    tx
      .select(EXPORT_REGISTRATION_COLUMNS)
      .from(registrations)
      .where(where)
      .orderBy(...EXPORT_ORDER)
      .limit(limit),
  );
}

/**
 * Every top-level form_data key of the filtered registrations, sorted (JS
 * string order), for the CSV/XLSX header written before the first row. Rows
 * whose form_data is not an object contribute nothing.
 */
export async function getRegistrationFormDataKeys(
  eventId: string,
  filters: RegistrationFilters,
  db: DbExecutor = getDb(),
): Promise<string[]> {
  const rows = rowsOf<{ field_key: string }>(
    await db.execute(sql`
      SELECT DISTINCT k.field_key
      FROM ${registrations},
        jsonb_object_keys(
          CASE WHEN jsonb_typeof(${registrations.formData}) = 'object'
            THEN ${registrations.formData}
            ELSE '{}'::jsonb
          END
        ) AS k(field_key)
      WHERE ${buildRegistrationWhere(eventId, filters)}
    `),
  );
  return rows.map((row) => row.field_key).sort();
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
  db: DbExecutor = getDb(),
): Promise<RegistrationTableColumns> {
  const form = (
    await db
      .select({ id: forms.id, schema: forms.schema })
      .from(forms)
      .where(and(eq(forms.eventId, eventId), eq(forms.type, "REGISTRATION")))
      .limit(1)
  )[0];

  if (!form?.schema) {
    return { formColumns: [], fixedColumns: getDefaultFixedColumns() };
  }

  const schema = readFormSchema(form.schema, form.id) as FormSchemaSteps;
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

export async function getEventAccessNames(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<EventAccessNameRow[]> {
  return db
    .select({ id: eventAccess.id, name: eventAccess.name })
    .from(eventAccess)
    .where(eq(eventAccess.eventId, eventId))
    .orderBy(asc(eventAccess.sortOrder));
}

export async function getEventSlugAndName(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<{ slug: string; name: string } | null> {
  const rows = await db
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

export interface ModularExportOptions extends RegistrationFilters {
  needCheckIns: boolean;
  needTransactions: boolean;
}

/**
 * Modular export rows (all scalar columns, plus the accessCheckIns and
 * transactions relations when asked), page by page in EXPORT_ORDER. Each
 * page loads its relations for its own ids (at most one page of them) in the
 * page's transaction.
 */
export function iterateRegistrationsForModularExport(
  eventId: string,
  opts: ModularExportOptions,
  options: ExportPageOptions = {},
): AsyncGenerator<ModularRegistrationRow[]> {
  const { needCheckIns, needTransactions, ...filters } = opts;
  const base = buildRegistrationWhere(eventId, filters);
  return keysetRegistrationPages(base, options, async (where, limit, tx) => {
    const rows = await tx
      .select()
      .from(registrations)
      .where(where)
      .orderBy(...EXPORT_ORDER)
      .limit(limit);
    const result: ModularRegistrationRow[] = rows.map((r) => ({
      ...r,
      accessTypeIds: r.accessTypeIds ?? [],
      droppedAccessIds: r.droppedAccessIds ?? [],
    }));
    if (result.length === 0) return result;
    await loadModularRelations(result, { needCheckIns, needTransactions }, tx);
    return result;
  });
}

async function loadModularRelations(
  result: ModularRegistrationRow[],
  opts: Pick<ModularExportOptions, "needCheckIns" | "needTransactions">,
  db: DbExecutor,
): Promise<void> {
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
    const byReg = groupRows(checkIns, (c) => c.registrationId, (c) => ({
      accessId: c.accessId, checkedInAt: c.checkedInAt,
    }));
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
        performedBy: paymentTransaction.performedBy,
        createdAt: paymentTransaction.createdAt,
      })
      .from(paymentTransaction)
      .where(inArray(paymentTransaction.registrationId, ids))
      .orderBy(asc(paymentTransaction.createdAt));
    const byReg = groupRows(txs, (t) => t.registrationId, (t) => ({
      type: t.type,
      amount: t.amount,
      method: t.method,
      reference: t.reference,
      performedBy: t.performedBy,
      createdAt: t.createdAt,
    }));
    for (const r of result) r.transactions = byReg.get(r.id) ?? [];
  }
}

export interface SponsorshipLabDetail {
  code: string;
  beneficiaryAddress: string | null;
  batch: { labName: string; contactName: string; email: string; phone: string | null };
}

export async function getSponsorshipLabDetails(
  eventId: string,
  codes: string[],
  db: DbExecutor = getDb(),
): Promise<SponsorshipLabDetail[]> {
  const uniqueCodes = Array.from(new Set(codes.filter(Boolean)));
  if (uniqueCodes.length === 0) return [];
  return db
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
// Each report reads its small header data (event, access items, counts or
// sort keys) in one export transaction up front, then its rows page by page:
// keyset pages on registrations, or id chunks when the row order is decided
// in JS. Nothing loads a whole event's rows at once.
// ============================================================================

async function getEventAccessItems(
  eventId: string,
  db: DbExecutor,
): Promise<Array<{ id: string; name: string; type: string }>> {
  return db
    .select({ id: eventAccess.id, name: eventAccess.name, type: eventAccess.type })
    .from(eventAccess)
    .where(eq(eventAccess.eventId, eventId))
    .orderBy(asc(eventAccess.sortOrder));
}

export interface EventSummaryData {
  event: { name: string; slug: string } | null;
  accessTypes: Array<{ id: string; name: string; type: string }>;
  /** Registrations of the event. */
  total: number;
  /** Registrations per payment status (statuses with none are absent). */
  byStatus: Array<{ paymentStatus: string; count: number }>;
  /**
   * Per access id listed on registrations: how many list it, and how many of
   * those are confirmed (PAID, SPONSORED or WAIVED). A registration listing
   * an id twice counts twice, as the in-memory count did.
   */
  byAccess: Array<{ accessId: string; registered: number; confirmed: number }>;
}

/** Event summary counts, aggregated in SQL (no registration rows loaded). */
export async function getEventSummaryData(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<EventSummaryData> {
  const event = await getEventSlugAndName(eventId, db);
  const accessTypes = await getEventAccessItems(eventId, db);
  const byStatus = await db
    .select({ paymentStatus: registrations.paymentStatus, count: count() })
    .from(registrations)
    .where(eq(registrations.eventId, eventId))
    .groupBy(registrations.paymentStatus);
  const byAccess = rowsOf<{
    access_id: string;
    registered: number | string;
    confirmed: number | string;
  }>(
    await db.execute(sql`
      SELECT a.access_id,
        count(*) AS registered,
        count(*) FILTER (WHERE r.payment_status IN (${sql.join(
          FULLY_SETTLED_STATUSES.map((status) => sql`${status}`),
          sql`, `,
        )})) AS confirmed
      FROM ${registrations} r,
        LATERAL unnest(r.access_type_ids) AS a(access_id)
      WHERE r.event_id = ${eventId}
      GROUP BY a.access_id
    `),
  );
  return {
    event,
    accessTypes,
    total: byStatus.reduce((sum, row) => sum + row.count, 0),
    byStatus: byStatus.map((row) => ({ paymentStatus: row.paymentStatus, count: row.count })),
    byAccess: byAccess.map((row) => ({
      accessId: row.access_id,
      registered: Number(row.registered),
      confirmed: Number(row.confirmed),
    })),
  };
}

export interface ReportEventAndAccess {
  event: { name: string; slug: string } | null;
  accessItems: Array<{ id: string; name: string; type: string }>;
}

/** The event and its access items (sort order), for the per-access reports. */
export async function getReportEventAndAccess(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<ReportEventAndAccess> {
  return {
    event: await getEventSlugAndName(eventId, db),
    accessItems: await getEventAccessItems(eventId, db),
  };
}

export interface AccessRegistrantReportRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  paymentStatus: string;
  totalAmount: number;
  submittedAt: Date;
}

/** Registrations listing `accessId`, newest first, page by page. */
export function iterateAccessRegistrantsForReport(
  eventId: string,
  accessId: string,
  options: ExportPageOptions = {},
): AsyncGenerator<AccessRegistrantReportRow[]> {
  const base = and(eq(registrations.eventId, eventId), hasAccess(accessId)) as SQL;
  return keysetRegistrationPages(base, options, (where, limit, tx) =>
    tx
      .select({
        id: registrations.id,
        firstName: registrations.firstName,
        lastName: registrations.lastName,
        email: registrations.email,
        phone: registrations.phone,
        paymentStatus: registrations.paymentStatus,
        totalAmount: registrations.totalAmount,
        submittedAt: registrations.submittedAt,
      })
      .from(registrations)
      .where(where)
      .orderBy(...EXPORT_ORDER)
      .limit(limit),
  );
}

function hasAccess(accessId: string): SQL {
  return sql`${accessId}::text = ANY(${registrations.accessTypeIds})`;
}

export interface SponsorshipReportUsage {
  amountApplied: number;
  appliedAt: Date;
  registration: { firstName: string | null; lastName: string | null; email: string } | null;
}

export interface SponsorshipReportRow {
  id: string;
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

/** What the sponsorships report sorts and totals by, for every filtered row. */
export interface SponsorshipReportKey {
  id: string;
  labName: string;
  totalAmount: number;
  createdAt: Date;
}

export interface SponsorshipsReportData {
  event: { name: string; slug: string } | null;
  currency: string;
  accessItems: Array<{ id: string; name: string }>;
  /** Every filtered sponsorship's sort key, newest first. */
  keys: SponsorshipReportKey[];
}

/**
 * The sponsorships report's header data and the sort key of every filtered
 * sponsorship (four small columns each); the rows themselves are read by
 * iterateSponsorshipsForReport in the order the caller settles on.
 */
export async function getSponsorshipsReportData(
  eventId: string,
  filters?: { status?: string; search?: string },
  db: DbExecutor = getDb(),
): Promise<SponsorshipsReportData> {
  const event = await getEventSlugAndName(eventId, db);
  const pricing = await db
    .select({ currency: eventPricing.currency })
    .from(eventPricing)
    .where(eq(eventPricing.eventId, eventId))
    .limit(1);
  const accessItems = await getEventAccessNames(eventId, db);
  const keys = await db
    .select({
      id: sponsorships.id,
      labName: sponsorshipBatches.labName,
      totalAmount: sponsorships.totalAmount,
      createdAt: sponsorships.createdAt,
    })
    .from(sponsorships)
    .innerJoin(sponsorshipBatches, eq(sponsorships.batchId, sponsorshipBatches.id))
    .where(buildSponsorshipWhere(eventId, filters))
    .orderBy(desc(sponsorships.createdAt), desc(sponsorships.id));
  return {
    event,
    currency: pricing[0]?.currency ?? "TND",
    accessItems,
    keys,
  };
}

/**
 * Sponsorship rows (with their batch and usages, usages by applied_at) for
 * `ids` in that order, EXPORT_PAGE_SIZE ids per page.
 */
export function iterateSponsorshipsForReport(
  ids: readonly string[],
  options: ExportPageOptions = {},
): AsyncGenerator<SponsorshipReportRow[]> {
  return pagesByIds(ids, options, loadSponsorshipReportRows, (row) => row.id);
}

async function loadSponsorshipReportRows(
  ids: string[],
  db: DbExecutor,
): Promise<SponsorshipReportRow[]> {
  const sponsorshipRows = await db
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
    .where(inArray(sponsorships.id, ids));
  if (sponsorshipRows.length === 0) return [];

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
    .where(inArray(sponsorshipUsages.sponsorshipId, ids))
    .orderBy(asc(sponsorshipUsages.appliedAt));
  const usagesById = groupRows(usageRows, (u) => u.sponsorshipId, (u) => ({
    amountApplied: u.amountApplied,
    appliedAt: u.appliedAt,
    registration:
      u.registrationId && u.regEmail
        ? { firstName: u.regFirstName, lastName: u.regLastName, email: u.regEmail }
        : null,
  }));

  return sponsorshipRows.map((s) => ({
    id: s.sponsorship.id,
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
  }));
}

export interface CheckInReportRow {
  id: string;
  referenceNumber: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  paymentStatus: string;
  submittedAt: Date;
  /** Event check-in, or the access check-in on an access sheet; null when absent. */
  checkedInAt: Date | null;
}

export interface CheckInReportScope {
  /** Omitted: the event check-in; set: that access item's check-in. */
  accessId?: string;
  /** Which half of the sheet: the checked-in registrations, or the others. */
  checkedIn: boolean;
}

/**
 * One half of a check-in sheet, oldest submission first, page by page. The
 * global sheet reads the event's registrations by registrations.checked_in_at;
 * an access sheet reads the registrations listing that access by their
 * access_check_ins row (unique per registration and access).
 */
export function iterateCheckInReportRows(
  eventId: string,
  scope: CheckInReportScope,
  options: ExportPageOptions = {},
): AsyncGenerator<CheckInReportRow[]> {
  const columns = {
    id: registrations.id,
    referenceNumber: registrations.referenceNumber,
    firstName: registrations.firstName,
    lastName: registrations.lastName,
    email: registrations.email,
    phone: registrations.phone,
    paymentStatus: registrations.paymentStatus,
    submittedAt: registrations.submittedAt,
  };
  const { accessId, checkedIn } = scope;

  if (accessId === undefined) {
    const base = and(
      eq(registrations.eventId, eventId),
      checkedIn ? isNotNull(registrations.checkedInAt) : isNull(registrations.checkedInAt),
    ) as SQL;
    return keysetRegistrationPages(
      base,
      options,
      (where, limit, tx) =>
        tx
          .select({ ...columns, checkedInAt: registrations.checkedInAt })
          .from(registrations)
          .where(where)
          .orderBy(...SUBMISSION_ORDER)
          .limit(limit),
      "oldest-first",
    );
  }

  const listed = and(eq(registrations.eventId, eventId), hasAccess(accessId)) as SQL;
  if (checkedIn) {
    return keysetRegistrationPages(
      listed,
      options,
      (where, limit, tx) =>
        tx
          .select({ ...columns, checkedInAt: accessCheckIns.checkedInAt })
          .from(registrations)
          .innerJoin(
            accessCheckIns,
            and(
              eq(accessCheckIns.registrationId, registrations.id),
              eq(accessCheckIns.accessId, accessId),
            ),
          )
          .where(where)
          .orderBy(...SUBMISSION_ORDER)
          .limit(limit),
      "oldest-first",
    );
  }
  const notCheckedIn = and(
    listed,
    notExists(
      getDb()
        .select({ one: sql`1` })
        .from(accessCheckIns)
        .where(
          and(
            eq(accessCheckIns.registrationId, registrations.id),
            eq(accessCheckIns.accessId, accessId),
          ),
        ),
    ),
  ) as SQL;
  return keysetRegistrationPages(
    notCheckedIn,
    options,
    async (where, limit, tx) =>
      (
        await tx
          .select(columns)
          .from(registrations)
          .where(where)
          .orderBy(...SUBMISSION_ORDER)
          .limit(limit)
      ).map((row) => ({ ...row, checkedInAt: null })),
    "oldest-first",
  );
}
