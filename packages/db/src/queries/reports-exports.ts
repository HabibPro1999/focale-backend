// Read-only exports use the caller's executor and keep sequential queries on that connection.
import { and, asc, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import { groupBy } from "../helpers";
import { getDb, type DbExecutor } from "../client";
import { registrations, paymentTransaction } from "../schema/registrations";
import { events, eventAccess, accessCheckIns } from "../schema/events-access";
import { eventPricing } from "../schema/pricing";
import { deriveRegistrationTableColumns, type RegistrationTableColumns } from "../registration-columns";
import { findRegistrationFormSchema } from "./forms";
import { sponsorships, sponsorshipBatches, sponsorshipUsages } from "../schema/sponsorships";
import { buildSponsorshipWhere } from "./sponsorships";
import { registrationWhereClauses } from "./registrations";

type RegistrationRow = typeof registrations.$inferSelect;

/**
 * Port of the legacy `buildRegistrationWhere` (registrations module). Search
 * uses the list's `registrationSearchClause`, so an export returns the rows
 * the list showed. `role` filter param exists in legacy but reports never
 * passes it — omitted.
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
  const clauses = registrationWhereClauses(eventId, {
    paymentStatus: filters.paymentStatus,
    paymentMethod: filters.paymentMethod,
    search: filters.search,
  });
  // Date range merged with the same only-set-what-was-given semantics.
  if (filters.startDate) clauses.push(gte(registrations.submittedAt, new Date(filters.startDate)));
  if (filters.endDate) clauses.push(lte(registrations.submittedAt, new Date(filters.endDate)));
  return and(...clauses) as SQL;
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
  db: DbExecutor = getDb(),
): Promise<ExportRegistrationRow[]> {
  return db
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

export type { RegistrationFormColumn, RegistrationTableColumns } from "../registration-columns";

export async function getRegistrationTableColumns(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<RegistrationTableColumns> {
  const form = await findRegistrationFormSchema(eventId, db);
  return deriveRegistrationTableColumns(form?.schema);
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
  db: DbExecutor = getDb(),
): Promise<ModularRegistrationRow[]> {
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
    const byReg = groupBy(checkIns, (c) => c.registrationId, (c) => ({
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
    const byReg = groupBy(txs, (t) => t.registrationId, (t) => ({
      type: t.type,
      amount: t.amount,
      method: t.method,
      reference: t.reference,
      performedBy: t.performedBy,
      createdAt: t.createdAt,
    }));
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
// ============================================================================

export interface EventSummaryData {
  event: { name: string; slug: string } | null;
  accessTypes: Array<{ id: string; name: string; type: string }>;
  registrations: Array<{
    paymentStatus: string;
    accessTypeIds: string[];
  }>;
}

export async function getEventSummaryData(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<EventSummaryData> {
  const event = await getEventSlugAndName(eventId, db);
  const accessTypes = await db
    .select({ id: eventAccess.id, name: eventAccess.name, type: eventAccess.type })
    .from(eventAccess)
    .where(eq(eventAccess.eventId, eventId))
    .orderBy(asc(eventAccess.sortOrder));
  const regs = await db
    .select({
      paymentStatus: registrations.paymentStatus,
      accessTypeIds: registrations.accessTypeIds,
    })
    .from(registrations)
    .where(eq(registrations.eventId, eventId));
  return {
    event,
    accessTypes,
    registrations: regs.map((r) => ({ ...r, accessTypeIds: r.accessTypeIds ?? [] })),
  };
}

export interface AccessRegistrantsReportData {
  event: { name: string; slug: string } | null;
  accessItems: Array<{ id: string; name: string }>;
  registrations: Array<{
    firstName: string | null;
    lastName: string | null;
    email: string;
    phone: string | null;
    paymentStatus: string;
    totalAmount: number;
    submittedAt: Date;
    accessTypeIds: string[];
  }>;
}

export async function getAccessRegistrantsReportData(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<AccessRegistrantsReportData> {
  const event = await getEventSlugAndName(eventId, db);
  const accessItems = await getEventAccessNames(eventId, db);
  const regs = await db
    .select({
      firstName: registrations.firstName,
      lastName: registrations.lastName,
      email: registrations.email,
      phone: registrations.phone,
      paymentStatus: registrations.paymentStatus,
      totalAmount: registrations.totalAmount,
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
  db: DbExecutor = getDb(),
): Promise<SponsorshipsReportData> {
  const where = buildSponsorshipWhere(eventId, filters);

  const event = await getEventSlugAndName(eventId, db);
  const pricing = await db
    .select({ currency: eventPricing.currency })
    .from(eventPricing)
    .where(eq(eventPricing.eventId, eventId))
    .limit(1);
  const accessItems = await getEventAccessNames(eventId, db);
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
    .where(where)
    .orderBy(desc(sponsorships.createdAt));

  // Usages (+ registration) for the fetched sponsorships, ordered appliedAt asc.
  const sponsorshipIds = sponsorshipRows.map((s) => s.sponsorship.id);
  let usagesById = new Map<string, SponsorshipReportUsage[]>();
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
    usagesById = groupBy(usageRows, (u) => u.sponsorshipId, (u) => ({
      amountApplied: u.amountApplied,
      appliedAt: u.appliedAt,
      registration:
        u.registrationId && u.regEmail
          ? { firstName: u.regFirstName, lastName: u.regLastName, email: u.regEmail }
          : null,
    }));
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
    checkedInAt: Date | null;
    accessTypeIds: string[];
    accessCheckIns: Array<{ accessId: string; checkedInAt: Date }>;
  }>;
}

export async function getCheckInReportData(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<CheckInReportData> {
  const event = await getEventSlugAndName(eventId, db);
  const accessItems = await getEventAccessNames(eventId, db);

  const regs = await db
    .select({
      id: registrations.id,
      referenceNumber: registrations.referenceNumber,
      firstName: registrations.firstName,
      lastName: registrations.lastName,
      email: registrations.email,
      phone: registrations.phone,
      paymentStatus: registrations.paymentStatus,
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
  const byReg = groupBy(checkInRows, (c) => c.registrationId, (c) => ({
    accessId: c.accessId, checkedInAt: c.checkedInAt,
  }));

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
