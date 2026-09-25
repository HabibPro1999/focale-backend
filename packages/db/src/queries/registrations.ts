import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  ne,
  or,
  sql,
  sum,
  type SQL,
} from "drizzle-orm";
import { getSkip } from "@app/shared";
import type { ListRegistrationsQuery } from "@app/contracts";
import { getDb, type DbExecutor } from "../client";
import { escapeLike } from "../like";
import { registrationReferenceCounters, registrations } from "../schema/registrations";
import { events, eventAccess, accessCheckIns } from "../schema/events-access";
import { forms } from "../schema/forms";
import { clients, users } from "../schema/users-clients";
import { sponsorships, sponsorshipUsages } from "../schema/sponsorships";
import { auditLogs } from "../schema/outbox-audit";
import { emailLogs, emailTemplates } from "../schema/email";

export type RegistrationRow = typeof registrations.$inferSelect;
export type NewRegistrationValues = typeof registrations.$inferInsert;
export type RegistrationPatch = Partial<NewRegistrationValues>;

/** Client module-gate slice (legacy CLIENT_MODULE_GATE_SELECT). */
export interface RegistrationClientGate {
  active: boolean;
  enabledModules: string[] | null;
}

export interface RegistrationFormMeta {
  id: string;
  name: string;
}
export interface RegistrationEventMeta {
  id: string;
  name: string;
  slug: string;
  clientId: string;
}

export interface RegistrationWithMeta extends RegistrationRow {
  form: RegistrationFormMeta;
  event: RegistrationEventMeta;
  accessCheckIns?: { accessId: string; checkedInAt: Date }[];
}

export interface AccessDisplayDetail {
  id: string;
  name: string;
  type: string;
  startsAt: Date | null;
  endsAt: Date | null;
}

// ============================================================================
// Access display metadata (enrichment joins)
// ============================================================================

export async function findAccessDetailsByIds(
  ids: string[],
  db: DbExecutor = getDb(),
): Promise<AccessDisplayDetail[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      id: eventAccess.id,
      name: eventAccess.name,
      type: sql<string>`${eventAccess.type}`,
      startsAt: eventAccess.startsAt,
      endsAt: eventAccess.endsAt,
    })
    .from(eventAccess)
    .where(inArray(eventAccess.id, ids));
}

// ============================================================================
// Reads
// ============================================================================

const EVENT_META = {
  eventMetaId: events.id,
  eventName: events.name,
  eventSlug: events.slug,
  eventClientId: events.clientId,
};

export async function getRegistrationByIdRow(
  id: string,
  db: DbExecutor = getDb(),
): Promise<RegistrationWithMeta | null> {
  const [row] = await db
    .select({
      reg: registrations,
      formId: forms.id,
      formName: forms.name,
      ...EVENT_META,
    })
    .from(registrations)
    .innerJoin(forms, eq(registrations.formId, forms.id))
    .innerJoin(events, eq(registrations.eventId, events.id))
    .where(eq(registrations.id, id))
    .limit(1);
  if (!row) return null;

  const checkIns = await db
    .select({
      accessId: accessCheckIns.accessId,
      checkedInAt: accessCheckIns.checkedInAt,
    })
    .from(accessCheckIns)
    .where(eq(accessCheckIns.registrationId, id));

  return {
    ...row.reg,
    form: { id: row.formId, name: row.formName },
    event: {
      id: row.eventMetaId,
      name: row.eventName,
      slug: row.eventSlug,
      clientId: row.eventClientId,
    },
    accessCheckIns: checkIns,
  };
}

export async function getRegistrationByIdempotencyKeyRow(
  idempotencyKey: string,
  db: DbExecutor = getDb(),
): Promise<RegistrationWithMeta | null> {
  const [row] = await db
    .select({
      reg: registrations,
      formId: forms.id,
      formName: forms.name,
      ...EVENT_META,
    })
    .from(registrations)
    .innerJoin(forms, eq(registrations.formId, forms.id))
    .innerJoin(events, eq(registrations.eventId, events.id))
    .where(eq(registrations.idempotencyKey, idempotencyKey))
    .limit(1);
  if (!row) return null;
  return {
    ...row.reg,
    form: { id: row.formId, name: row.formName },
    event: {
      id: row.eventMetaId,
      name: row.eventName,
      slug: row.eventSlug,
      clientId: row.eventClientId,
    },
  };
}

export function buildRegistrationWhere(
  eventId: string,
  filters?: {
    paymentStatus?: string;
    paymentMethod?: string;
    role?: string;
    search?: string;
  },
): SQL | undefined {
  const clauses: (SQL | undefined)[] = [eq(registrations.eventId, eventId)];
  if (filters?.paymentStatus) {
    clauses.push(
      eq(
        registrations.paymentStatus,
        filters.paymentStatus as RegistrationRow["paymentStatus"],
      ),
    );
  }
  if (filters?.paymentMethod) {
    clauses.push(
      eq(
        registrations.paymentMethod,
        filters.paymentMethod as NonNullable<RegistrationRow["paymentMethod"]>,
      ),
    );
  }
  if (filters?.role) {
    clauses.push(eq(registrations.role, filters.role as RegistrationRow["role"]));
  }
  if (filters?.search) {
    clauses.push(registrationSearchClause(filters.search));
  }
  return and(...clauses);
}

/**
 * Registrant search shared by the list and the export: every whitespace-
 * separated word must match email, first/last name, phone or reference
 * number, so a full name ("Mehdi Trabelsi", either order) finds the
 * registrant. LIKE metacharacters are escaped so input matches literally.
 */
export function registrationSearchClause(search: string): SQL | undefined {
  const words = search.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  return and(
    ...words.map((word) => {
      const term = `%${word.replace(/[\\%_]/g, "\\$&")}%`;
      return or(
        ilike(registrations.email, term),
        ilike(registrations.firstName, term),
        ilike(registrations.lastName, term),
        ilike(registrations.phone, term),
        ilike(registrations.referenceNumber, term),
      );
    }),
  );
}

/**
 * Registration columns an admin response may carry: every column except the
 * self-edit credential (`editToken`) and the public-create `idempotencyKey`,
 * which replays the create response including that credential. A new schema
 * column fails typecheck here until it is listed or deliberately omitted.
 */
export type AdminRegistrationRow = Omit<RegistrationRow, "editToken" | "idempotencyKey">;

const ADMIN_REGISTRATION_COLUMNS = {
  id: registrations.id,
  formId: registrations.formId,
  eventId: registrations.eventId,
  formData: registrations.formData,
  networkingOptIn: registrations.networkingOptIn,
  submittedAt: registrations.submittedAt,
  formSchemaVersion: registrations.formSchemaVersion,
  email: registrations.email,
  firstName: registrations.firstName,
  lastName: registrations.lastName,
  phone: registrations.phone,
  referenceNumber: registrations.referenceNumber,
  paymentStatus: registrations.paymentStatus,
  totalAmount: registrations.totalAmount,
  paidAmount: registrations.paidAmount,
  currency: registrations.currency,
  paymentMethod: registrations.paymentMethod,
  paymentReference: registrations.paymentReference,
  paymentProofUrl: registrations.paymentProofUrl,
  priceBreakdown: registrations.priceBreakdown,
  baseAmount: registrations.baseAmount,
  discountAmount: registrations.discountAmount,
  accessAmount: registrations.accessAmount,
  sponsorshipCode: registrations.sponsorshipCode,
  sponsorshipAmount: registrations.sponsorshipAmount,
  labName: registrations.labName,
  paidAt: registrations.paidAt,
  createdAt: registrations.createdAt,
  updatedAt: registrations.updatedAt,
  lastEditedAt: registrations.lastEditedAt,
  linkBaseUrl: registrations.linkBaseUrl,
  note: registrations.note,
  role: registrations.role,
  accessTypeIds: registrations.accessTypeIds,
  droppedAccessIds: registrations.droppedAccessIds,
  checkedInAt: registrations.checkedInAt,
  checkedInBy: registrations.checkedInBy,
} satisfies Record<keyof AdminRegistrationRow, unknown>;

export interface RegistrationListRow extends AdminRegistrationRow {
  form: RegistrationFormMeta;
  event: RegistrationEventMeta;
}

export interface RegistrationStatRow {
  paymentStatus: string;
  cnt: number;
  totalAmount: number;
  paidAmount: number;
}

export async function listRegistrationRows(
  eventId: string,
  query: ListRegistrationsQuery,
  db: DbExecutor = getDb(),
): Promise<{
  rows: RegistrationListRow[];
  total: number;
  stats: RegistrationStatRow[];
}> {
  const { page, limit, paymentStatus, paymentMethod, role, search } = query;
  const where = buildRegistrationWhere(eventId, {
    paymentStatus,
    paymentMethod,
    role,
    search,
  });
  const skip = getSkip({ page, limit });

  const [rows, totalRows, statsRaw] = await Promise.all([
    db
      .select({
        reg: ADMIN_REGISTRATION_COLUMNS,
        formId: forms.id,
        formName: forms.name,
        ...EVENT_META,
      })
      .from(registrations)
      .innerJoin(forms, eq(registrations.formId, forms.id))
      .innerJoin(events, eq(registrations.eventId, events.id))
      .where(where)
      .orderBy(desc(registrations.createdAt))
      .limit(limit)
      .offset(skip),
    db.select({ value: count() }).from(registrations).where(where),
    db
      .select({
        paymentStatus: registrations.paymentStatus,
        cnt: count(),
        totalAmount: sum(registrations.totalAmount),
        paidAmount: sum(registrations.paidAmount),
      })
      .from(registrations)
      .where(where)
      .groupBy(registrations.paymentStatus),
  ]);

  return {
    rows: rows.map((r) => ({
      ...r.reg,
      form: { id: r.formId, name: r.formName },
      event: {
        id: r.eventMetaId,
        name: r.eventName,
        slug: r.eventSlug,
        clientId: r.eventClientId,
      },
    })),
    total: Number(totalRows[0]?.value ?? 0),
    stats: statsRaw.map((s) => ({
      paymentStatus: s.paymentStatus,
      cnt: Number(s.cnt),
      totalAmount: Number(s.totalAmount ?? 0),
      paidAmount: Number(s.paidAmount ?? 0),
    })),
  };
}

export async function getRegistrationClientId(
  id: string,
  db: DbExecutor = getDb(),
): Promise<string | null> {
  const [row] = await db
    .select({ clientId: events.clientId })
    .from(registrations)
    .innerJoin(events, eq(registrations.eventId, events.id))
    .where(eq(registrations.id, id))
    .limit(1);
  return row?.clientId ?? null;
}

// ============================================================================
// Event lookups for create/admin gates + capacity
// ============================================================================

export interface EventForRegistrationCreate {
  clientId: string;
  status: string;
  endDate: Date;
  maxCapacity: number | null;
  registeredCount: number;
  client: RegistrationClientGate;
}

export async function getEventForRegistrationCreate(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<EventForRegistrationCreate | null> {
  const [row] = await db
    .select({
      clientId: events.clientId,
      status: events.status,
      endDate: events.endDate,
      maxCapacity: events.maxCapacity,
      registeredCount: events.registeredCount,
      active: clients.active,
      enabledModules: clients.enabledModules,
    })
    .from(events)
    .innerJoin(clients, eq(events.clientId, clients.id))
    .where(eq(events.id, eventId))
    .limit(1);
  if (!row) return null;
  return {
    clientId: row.clientId,
    status: row.status,
    endDate: row.endDate,
    maxCapacity: row.maxCapacity,
    registeredCount: row.registeredCount,
    client: { active: row.active, enabledModules: row.enabledModules },
  };
}

export interface EventForRegistrationAdmin {
  clientId: string;
  status: string;
  maxCapacity: number | null;
  registeredCount: number;
  client: RegistrationClientGate;
}

export async function getEventForRegistrationAdmin(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<EventForRegistrationAdmin | null> {
  const [row] = await db
    .select({
      clientId: events.clientId,
      status: events.status,
      maxCapacity: events.maxCapacity,
      registeredCount: events.registeredCount,
      active: clients.active,
      enabledModules: clients.enabledModules,
    })
    .from(events)
    .innerJoin(clients, eq(events.clientId, clients.id))
    .where(eq(events.id, eventId))
    .limit(1);
  if (!row) return null;
  return {
    clientId: row.clientId,
    status: row.status,
    maxCapacity: row.maxCapacity,
    registeredCount: row.registeredCount,
    client: { active: row.active, enabledModules: row.enabledModules },
  };
}

/** REGISTRATION form for an event (admin create). */
export async function findRegistrationFormForEvent(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<{ id: string; schemaVersion: number } | null> {
  const [row] = await db
    .select({ id: forms.id, schemaVersion: forms.schemaVersion })
    .from(forms)
    .where(and(eq(forms.eventId, eventId), eq(forms.type, "REGISTRATION")))
    .limit(1);
  return row ?? null;
}

/** Case-insensitive email+form duplicate check (optionally excluding an id). */
export async function registrationExistsByEmailForm(
  email: string,
  formId: string,
  db: DbExecutor = getDb(),
  excludeId?: string,
): Promise<boolean> {
  const clauses: (SQL | undefined)[] = [
    // Case-insensitive EQUALITY (legacy Prisma equals + mode:"insensitive").
    // Not ilike: it would treat `_`/`%` in the email as LIKE wildcards.
    sql`lower(${registrations.email}) = lower(${email})`,
    eq(registrations.formId, formId),
  ];
  if (excludeId) clauses.push(ne(registrations.id, excludeId));
  const [row] = await db
    .select({ id: registrations.id })
    .from(registrations)
    .where(and(...clauses))
    .limit(1);
  return row !== undefined;
}

// ============================================================================
// Mutation fetches
// ============================================================================

export interface RegistrationForMutation extends RegistrationRow {
  event: { clientId: string; status: string; client: RegistrationClientGate };
}

export async function findRegistrationForMutation(
  id: string,
  db: DbExecutor,
): Promise<RegistrationForMutation | null> {
  const [row] = await db
    .select({
      reg: registrations,
      clientId: events.clientId,
      status: events.status,
      active: clients.active,
      enabledModules: clients.enabledModules,
    })
    .from(registrations)
    .innerJoin(events, eq(registrations.eventId, events.id))
    .innerJoin(clients, eq(events.clientId, clients.id))
    .where(eq(registrations.id, id))
    .limit(1);
  if (!row) return null;
  return {
    ...row.reg,
    event: {
      clientId: row.clientId,
      status: row.status,
      client: { active: row.active, enabledModules: row.enabledModules },
    },
  };
}

export interface RegistrationForEditFetch extends RegistrationRow {
  form: { id: string; name: string; schema: unknown };
  event: {
    id: string;
    name: string;
    slug: string;
    clientId: string;
    status: string;
    endDate: Date;
    client: RegistrationClientGate;
  };
}

/** Full registration + form.schema + event public fields + client gate.
 *  Used by getRegistrationForEdit (read) AND editRegistrationPublic (in-tx). */
export async function findRegistrationWithFormEvent(
  id: string,
  db: DbExecutor = getDb(),
): Promise<RegistrationForEditFetch | null> {
  const [row] = await db
    .select({
      reg: registrations,
      formId: forms.id,
      formName: forms.name,
      formSchema: forms.schema,
      eventMetaId: events.id,
      eventName: events.name,
      eventSlug: events.slug,
      eventClientId: events.clientId,
      eventStatus: events.status,
      eventEndDate: events.endDate,
      active: clients.active,
      enabledModules: clients.enabledModules,
    })
    .from(registrations)
    .innerJoin(forms, eq(registrations.formId, forms.id))
    .innerJoin(events, eq(registrations.eventId, events.id))
    .innerJoin(clients, eq(events.clientId, clients.id))
    .where(eq(registrations.id, id))
    .limit(1);
  if (!row) return null;
  return {
    ...row.reg,
    form: { id: row.formId, name: row.formName, schema: row.formSchema },
    event: {
      id: row.eventMetaId,
      name: row.eventName,
      slug: row.eventSlug,
      clientId: row.eventClientId,
      status: row.eventStatus,
      endDate: row.eventEndDate,
      client: { active: row.active, enabledModules: row.enabledModules },
    },
  };
}

// ============================================================================
// Inserts / updates
// ============================================================================

export async function insertRegistrationRow(
  values: NewRegistrationValues,
  db: DbExecutor,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(registrations)
    .values(values)
    .returning({ id: registrations.id });
  return row;
}

export async function updateRegistrationRow(
  id: string,
  patch: RegistrationPatch,
  db: DbExecutor,
): Promise<void> {
  await db.update(registrations).set(patch).where(eq(registrations.id, id));
}

export async function deleteRegistrationRow(
  id: string,
  db: DbExecutor,
): Promise<void> {
  await db.delete(registrations).where(eq(registrations.id, id));
}

/**
 * Optimistic-concurrency compare-and-swap on `updatedAt`. Returns rows affected
 * (0 => precondition failed => the caller raises CONCURRENT_MODIFICATION).
 */
export async function casUpdateRegistrationByUpdatedAt(
  id: string,
  expectedUpdatedAt: Date,
  patch: RegistrationPatch,
  db: DbExecutor,
): Promise<number> {
  const rows = await db
    .update(registrations)
    .set(patch)
    .where(
      and(
        eq(registrations.id, id),
        eq(registrations.updatedAt, expectedUpdatedAt),
      ),
    )
    .returning({ id: registrations.id });
  return rows.length;
}

// ============================================================================
// Linked sponsorship usages (settlement recalc + delete cleanup)
// ============================================================================

export interface RegistrationUsageForRecalc {
  id: string;
  amountApplied: number;
  sponsorship: {
    coversBasePrice: boolean;
    coveredAccessIds: string[];
    totalAmount: number;
  };
}

export async function findRegistrationUsagesForRecalc(
  registrationId: string,
  db: DbExecutor,
): Promise<RegistrationUsageForRecalc[]> {
  const rows = await db
    .select({
      id: sponsorshipUsages.id,
      amountApplied: sponsorshipUsages.amountApplied,
      coversBasePrice: sponsorships.coversBasePrice,
      coveredAccessIds: sponsorships.coveredAccessIds,
      totalAmount: sponsorships.totalAmount,
    })
    .from(sponsorshipUsages)
    .innerJoin(sponsorships, eq(sponsorshipUsages.sponsorshipId, sponsorships.id))
    .where(eq(sponsorshipUsages.registrationId, registrationId));
  return rows.map((r) => ({
    id: r.id,
    amountApplied: r.amountApplied,
    sponsorship: {
      coversBasePrice: r.coversBasePrice,
      coveredAccessIds: r.coveredAccessIds ?? [],
      totalAmount: r.totalAmount,
    },
  }));
}

export async function findRegistrationUsageLinks(
  registrationId: string,
  db: DbExecutor,
): Promise<Array<{ id: string; sponsorshipId: string }>> {
  return db
    .select({
      id: sponsorshipUsages.id,
      sponsorshipId: sponsorshipUsages.sponsorshipId,
    })
    .from(sponsorshipUsages)
    .where(eq(sponsorshipUsages.registrationId, registrationId));
}

export async function deleteRegistrationUsages(
  registrationId: string,
  db: DbExecutor,
): Promise<void> {
  await db
    .delete(sponsorshipUsages)
    .where(eq(sponsorshipUsages.registrationId, registrationId));
}

// ============================================================================
// Reference number: "YY-SLUGCODE-NNN", one counter row per prefix (0021).
// ============================================================================

/**
 * "YY-SLUGCODE-": the two-digit year of the event's start in UTC (never the
 * process time zone) and the first 12 characters of the slug, upper-cased,
 * with "." and "_" turned into "-". Truncated slugs can collide, so events
 * may share a prefix and therefore a sequence.
 */
export function referenceNumberPrefix(event: { slug: string; startDate: Date }): string {
  const year = event.startDate.getUTCFullYear().toString().slice(-2);
  const code = event.slug.replace(/[._]/g, "-").toUpperCase().slice(0, 12);
  return `${year}-${code}-`;
}

export function formatReferenceNumber(prefix: string, sequence: number): string {
  return `${prefix}${String(sequence).padStart(3, "0")}`;
}

/**
 * Largest numeric suffix stored under `prefix`, 0 when none. A plain read:
 * it locks nothing. MAX runs over the number (a text MAX breaks at
 * '...-999' vs '...-1000'), and the digits-only filter keeps rows whose
 * prefix merely starts with ours ('26-TSHG-' vs '26-TSHG-CONGRES-') out of
 * the cast. The cast is to DECIMAL: CockroachDB parses a string with a
 * leading zero as octal when casting to INT ('012' → 10, '008' → error).
 */
async function maxReferenceSuffix(db: DbExecutor, prefix: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT MAX(CAST(seq AS DECIMAL)) AS max_seq FROM (
      SELECT SUBSTRING("reference_number", CAST(${prefix.length + 1} AS INT)) AS seq
      FROM "registrations"
      WHERE "reference_number" LIKE ${`${escapeLike(prefix)}%`} ESCAPE '\\'
    ) suffixes
    WHERE seq ~ '^[0-9]+$'
  `);
  const rows = (res as unknown as { rows?: Array<{ max_seq: number | string | null }> }).rows ?? [];
  const value = Number(rows[0]?.max_seq ?? 0);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * Next value of the prefix's counter. The UPDATE (or the INSERT's conflict
 * path) holds the counter row lock until the caller's transaction ends, so
 * concurrent allocations for one prefix queue on that row and each gets the
 * next value. The first allocation for a prefix seeds the row from the
 * largest suffix already stored.
 */
async function nextReferenceSequence(db: DbExecutor, prefix: string): Promise<number> {
  const counters = registrationReferenceCounters;
  const [bumped] = await db
    .update(counters)
    .set({ lastValue: sql`${counters.lastValue} + 1` })
    .where(eq(counters.prefix, prefix))
    .returning({ lastValue: counters.lastValue });
  if (bumped) return bumped.lastValue;
  const seed = await maxReferenceSuffix(db, prefix);
  const [created] = await db
    .insert(counters)
    .values({ prefix, lastValue: seed + 1 })
    .onConflictDoUpdate({ target: counters.prefix, set: { lastValue: sql`${counters.lastValue} + 1` } })
    .returning({ lastValue: counters.lastValue });
  return created!.lastValue;
}

async function referenceNumberTaken(db: DbExecutor, referenceNumber: string): Promise<boolean> {
  const [row] = await db
    .select({ id: registrations.id })
    .from(registrations)
    .where(eq(registrations.referenceNumber, referenceNumber))
    .limit(1);
  return row !== undefined;
}

/**
 * Allocate the next reference number for a registration of `eventId`, inside
 * the caller's transaction. It takes no event lock and scans nothing FOR
 * UPDATE: the only lock is the prefix's counter row, held until commit, so an
 * allocation that rolls back leaves no gap and a registration writer that
 * locks registration rows cannot deadlock with it.
 *
 * If the allocated number is already stored (numbered outside this counter,
 * e.g. by the legacy app during rollout or by a manual insert), the counter
 * moves past the largest stored suffix instead of failing on the unique
 * index again and again.
 */
export async function allocateReferenceNumber(eventId: string, db: DbExecutor): Promise<string> {
  const [event] = await db
    .select({ slug: events.slug, startDate: events.startDate })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!event) return `REG-${Date.now().toString(36).toUpperCase()}`;

  const prefix = referenceNumberPrefix(event);
  const sequence = await nextReferenceSequence(db, prefix);
  if (!(await referenceNumberTaken(db, formatReferenceNumber(prefix, sequence)))) {
    return formatReferenceNumber(prefix, sequence);
  }
  const counters = registrationReferenceCounters;
  const stored = await maxReferenceSuffix(db, prefix);
  const [moved] = await db
    .update(counters)
    .set({ lastValue: sql`GREATEST(${counters.lastValue}, CAST(${stored} AS INT)) + 1` })
    .where(eq(counters.prefix, prefix))
    .returning({ lastValue: counters.lastValue });
  return formatReferenceNumber(prefix, moved!.lastValue);
}

// ============================================================================
// Audit + edit token
// ============================================================================

// ============================================================================
// Audit-log + email-log subroute reads (paginated)
// ============================================================================

export interface RegistrationAuditLogRow {
  id: string;
  action: string;
  changes: unknown;
  performedBy: string | null;
  performedAt: Date;
  ipAddress: string | null;
}

export async function listRegistrationAuditLogRows(
  registrationId: string,
  page: { skip: number; limit: number },
  db: DbExecutor = getDb(),
): Promise<{ rows: RegistrationAuditLogRow[]; total: number }> {
  const where = and(
    eq(auditLogs.entityType, "Registration"),
    eq(auditLogs.entityId, registrationId),
  );
  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        changes: auditLogs.changes,
        performedBy: auditLogs.performedBy,
        performedAt: auditLogs.performedAt,
        ipAddress: auditLogs.ipAddress,
      })
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.performedAt))
      .limit(page.limit)
      .offset(page.skip),
    db.select({ value: count() }).from(auditLogs).where(where),
  ]);
  return { rows, total: Number(totalRows[0]?.value ?? 0) };
}

/** Batch user-name resolution for audit-log performer display. */
export async function findUserNamesByIds(
  ids: string[],
  db: DbExecutor = getDb(),
): Promise<Array<{ id: string; name: string }>> {
  if (ids.length === 0) return [];
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, ids));
}

export interface RegistrationEmailLogRow {
  id: string;
  subject: string;
  status: string;
  trigger: string | null;
  templateName: string | null;
  errorMessage: string | null;
  queuedAt: Date;
  sentAt: Date | null;
  deliveredAt: Date | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  bouncedAt: Date | null;
  failedAt: Date | null;
}

export async function listRegistrationEmailLogRows(
  registrationId: string,
  page: { skip: number; limit: number },
  db: DbExecutor = getDb(),
): Promise<{ rows: RegistrationEmailLogRow[]; total: number }> {
  const where = eq(emailLogs.registrationId, registrationId);
  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: emailLogs.id,
        subject: emailLogs.subject,
        status: emailLogs.status,
        trigger: emailLogs.trigger,
        templateName: emailTemplates.name,
        errorMessage: emailLogs.errorMessage,
        queuedAt: emailLogs.queuedAt,
        sentAt: emailLogs.sentAt,
        deliveredAt: emailLogs.deliveredAt,
        openedAt: emailLogs.openedAt,
        clickedAt: emailLogs.clickedAt,
        bouncedAt: emailLogs.bouncedAt,
        failedAt: emailLogs.failedAt,
      })
      .from(emailLogs)
      .leftJoin(emailTemplates, eq(emailLogs.templateId, emailTemplates.id))
      .where(where)
      .orderBy(desc(emailLogs.queuedAt))
      .limit(page.limit)
      .offset(page.skip),
    db.select({ value: count() }).from(emailLogs).where(where),
  ]);
  return { rows, total: Number(totalRows[0]?.value ?? 0) };
}

export interface RegistrationEditLinkSource {
  id: string;
  editToken: string | null;
  linkBaseUrl: string | null;
  eventSlug: string;
}

/** Inputs of the registrant self-edit link (admin edit-link endpoint). */
export async function getRegistrationEditLinkSource(
  id: string,
  db: DbExecutor = getDb(),
): Promise<RegistrationEditLinkSource | null> {
  const [row] = await db
    .select({
      id: registrations.id,
      editToken: registrations.editToken,
      linkBaseUrl: registrations.linkBaseUrl,
      eventSlug: events.slug,
    })
    .from(registrations)
    .innerJoin(events, eq(registrations.eventId, events.id))
    .where(eq(registrations.id, id))
    .limit(1);
  return row ?? null;
}

export async function getRegistrationEditToken(
  id: string,
  db: DbExecutor = getDb(),
): Promise<{ editToken: string | null } | null> {
  const [row] = await db
    .select({ editToken: registrations.editToken })
    .from(registrations)
    .where(eq(registrations.id, id))
    .limit(1);
  return row ?? null;
}

// ============================================================================
// Table columns — REGISTRATION form schema for the admin grid config
// ============================================================================

export async function getRegistrationFormSchemaForEvent(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<{ schema: unknown } | null> {
  const [row] = await db
    .select({ schema: forms.schema })
    .from(forms)
    .where(and(eq(forms.eventId, eventId), eq(forms.type, "REGISTRATION")))
    .limit(1);
  return row ?? null;
}
