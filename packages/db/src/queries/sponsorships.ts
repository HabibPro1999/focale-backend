import {
  and,
  asc,
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
import {
  getSkip,
  paginate,
  type PaginatedResult,
} from "@app/shared";
import type { ListSponsorshipsQuery, SponsorshipStats } from "@app/contracts";
import { enqueueOutboxEvent } from "../outbox";
import { getDb, type DbExecutor } from "../client";
import {
  sponsorships,
  sponsorshipBatches,
  sponsorshipUsages,
} from "../schema/sponsorships";
import { events, eventAccess } from "../schema/events-access";
import { eventPricing } from "../schema/pricing";
import { clients } from "../schema/users-clients";
import { registrations } from "../schema/registrations";
import { forms } from "../schema/forms";

// Row types inferred from the drizzle schema.
export type SponsorshipRow = typeof sponsorships.$inferSelect;
export type SponsorshipUsageRow = typeof sponsorshipUsages.$inferSelect;
export type SponsorshipBatchRow = typeof sponsorshipBatches.$inferSelect;

// Client module-gate slice used by the service's assertModuleEnabledForClient.
export interface SponsorshipClientGate {
  active: boolean;
  enabledModules: string[] | null;
}

// ============================================================================
// Shared where-clause builder — exported (reports module filters the same way)
// ============================================================================

export function buildSponsorshipWhere(
  eventId: string,
  filters?: { status?: string; search?: string },
): SQL | undefined {
  const clauses: (SQL | undefined)[] = [eq(sponsorships.eventId, eventId)];
  if (filters?.status) {
    clauses.push(
      eq(sponsorships.status, filters.status as SponsorshipRow["status"]),
    );
  }
  if (filters?.search) {
    const term = `%${filters.search}%`;
    clauses.push(
      or(
        ilike(sponsorships.code, term),
        ilike(sponsorships.beneficiaryName, term),
        ilike(sponsorshipBatches.labName, term),
        ilike(sponsorshipBatches.contactName, term),
      ),
    );
  }
  return and(...clauses);
}

// ============================================================================
// List (Admin) — paginated + status/amount stats over the SAME filtered where
// ============================================================================

export interface SponsorshipListItem extends SponsorshipRow {
  batch: { id: string; labName: string; contactName: string; email: string };
  usages: Array<{ registrationId: string | null; amountApplied: number }>;
}

export async function listSponsorships(
  eventId: string,
  query: ListSponsorshipsQuery,
  db: DbExecutor = getDb(),
): Promise<PaginatedResult<SponsorshipListItem> & { stats: SponsorshipStats }> {
  const { page, limit, status, search, sortBy, sortOrder } = query;
  const where = buildSponsorshipWhere(eventId, { status, search });
  const dir = sortOrder === "asc" ? asc : desc;
  const orderCol =
    sortBy === "beneficiaryName"
      ? sponsorships.beneficiaryName
      : sortBy === "totalAmount"
        ? sponsorships.totalAmount
        : sponsorships.createdAt;
  const skip = getSkip({ page, limit });

  const [rows, totalRows, statsRaw] = await Promise.all([
    db
      .select({
        sponsorship: sponsorships,
        batchId: sponsorshipBatches.id,
        labName: sponsorshipBatches.labName,
        contactName: sponsorshipBatches.contactName,
        email: sponsorshipBatches.email,
      })
      .from(sponsorships)
      .innerJoin(
        sponsorshipBatches,
        eq(sponsorships.batchId, sponsorshipBatches.id),
      )
      .where(where)
      .orderBy(dir(orderCol))
      .limit(limit)
      .offset(skip),
    db
      .select({ value: count() })
      .from(sponsorships)
      .innerJoin(
        sponsorshipBatches,
        eq(sponsorships.batchId, sponsorshipBatches.id),
      )
      .where(where),
    db
      .select({
        status: sponsorships.status,
        cnt: count(),
        amount: sum(sponsorships.totalAmount),
      })
      .from(sponsorships)
      .innerJoin(
        sponsorshipBatches,
        eq(sponsorships.batchId, sponsorshipBatches.id),
      )
      .where(where)
      .groupBy(sponsorships.status),
  ]);

  const total = Number(totalRows[0]?.value ?? 0);

  const sponsorshipIds = rows.map((r) => r.sponsorship.id);
  const usageRows = sponsorshipIds.length
    ? await db
        .select({
          sponsorshipId: sponsorshipUsages.sponsorshipId,
          registrationId: sponsorshipUsages.registrationId,
          amountApplied: sponsorshipUsages.amountApplied,
        })
        .from(sponsorshipUsages)
        .where(inArray(sponsorshipUsages.sponsorshipId, sponsorshipIds))
    : [];
  const usagesBySponsorship = new Map<
    string,
    Array<{ registrationId: string | null; amountApplied: number }>
  >();
  for (const u of usageRows) {
    const list = usagesBySponsorship.get(u.sponsorshipId) ?? [];
    list.push({
      registrationId: u.registrationId,
      amountApplied: u.amountApplied,
    });
    usagesBySponsorship.set(u.sponsorshipId, list);
  }

  const data: SponsorshipListItem[] = rows.map((r) => ({
    ...r.sponsorship,
    batch: {
      id: r.batchId,
      labName: r.labName,
      contactName: r.contactName,
      email: r.email,
    },
    usages: usagesBySponsorship.get(r.sponsorship.id) ?? [],
  }));

  const stats: SponsorshipStats = {
    total: 0,
    totalAmount: 0,
    pending: { count: 0, amount: 0 },
    used: { count: 0, amount: 0 },
    cancelled: { count: 0, amount: 0 },
  };
  for (const row of statsRaw) {
    const c = Number(row.cnt);
    const amount = Number(row.amount ?? 0);
    stats.total += c;
    stats.totalAmount += amount;
    if (row.status === "PENDING") stats.pending = { count: c, amount };
    else if (row.status === "USED") stats.used = { count: c, amount };
    else if (row.status === "CANCELLED") stats.cancelled = { count: c, amount };
  }

  return { ...paginate(data, total, { page, limit }), stats };
}

// ============================================================================
// Detail reads
// ============================================================================

export interface SponsorshipWithUsages extends SponsorshipRow {
  event: { clientId: string };
  batch: SponsorshipBatchRow;
  usages: Array<
    SponsorshipUsageRow & {
      registration: {
        id: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
      } | null;
    }
  >;
  coveredAccessItems: Array<{ id: string; name: string; price: number }>;
}

export async function getSponsorshipById(
  id: string,
  db: DbExecutor = getDb(),
): Promise<SponsorshipWithUsages | null> {
  const [row] = await db
    .select({
      sponsorship: sponsorships,
      batch: sponsorshipBatches,
      clientId: events.clientId,
    })
    .from(sponsorships)
    .innerJoin(
      sponsorshipBatches,
      eq(sponsorships.batchId, sponsorshipBatches.id),
    )
    .innerJoin(events, eq(sponsorships.eventId, events.id))
    .where(eq(sponsorships.id, id))
    .limit(1);
  if (!row) return null;

  const usageRows = await db
    .select({
      usage: sponsorshipUsages,
      regId: registrations.id,
      regEmail: registrations.email,
      regFirstName: registrations.firstName,
      regLastName: registrations.lastName,
    })
    .from(sponsorshipUsages)
    .leftJoin(
      registrations,
      eq(sponsorshipUsages.registrationId, registrations.id),
    )
    .where(eq(sponsorshipUsages.sponsorshipId, id));

  const coveredIds = row.sponsorship.coveredAccessIds ?? [];
  const coveredAccessItems = coveredIds.length
    ? await db
        .select({
          id: eventAccess.id,
          name: eventAccess.name,
          price: eventAccess.price,
        })
        .from(eventAccess)
        .where(inArray(eventAccess.id, coveredIds))
    : [];

  return {
    ...row.sponsorship,
    event: { clientId: row.clientId },
    batch: row.batch,
    usages: usageRows.map((u) => ({
      ...u.usage,
      registration: u.regId
        ? {
            id: u.regId,
            email: u.regEmail as string,
            firstName: u.regFirstName,
            lastName: u.regLastName,
          }
        : null,
    })),
    coveredAccessItems,
  };
}

export interface SponsorshipWithBatch extends SponsorshipRow {
  batch: {
    id: string;
    labName: string;
    contactName: string;
    email: string;
    phone: string | null;
  };
}

export async function getSponsorshipByCode(
  eventId: string,
  code: string,
  db: DbExecutor = getDb(),
): Promise<SponsorshipWithBatch | null> {
  const [row] = await db
    .select({
      sponsorship: sponsorships,
      id: sponsorshipBatches.id,
      labName: sponsorshipBatches.labName,
      contactName: sponsorshipBatches.contactName,
      email: sponsorshipBatches.email,
      phone: sponsorshipBatches.phone,
    })
    .from(sponsorships)
    .innerJoin(
      sponsorshipBatches,
      eq(sponsorships.batchId, sponsorshipBatches.id),
    )
    .where(and(eq(sponsorships.eventId, eventId), eq(sponsorships.code, code)))
    .limit(1);
  if (!row) return null;
  return {
    ...row.sponsorship,
    batch: {
      id: row.id,
      labName: row.labName,
      contactName: row.contactName,
      email: row.email,
      phone: row.phone,
    },
  };
}

export async function getSponsorshipClientId(
  id: string,
  db: DbExecutor = getDb(),
): Promise<string | null> {
  const [row] = await db
    .select({ clientId: events.clientId })
    .from(sponsorships)
    .innerJoin(events, eq(sponsorships.eventId, events.id))
    .where(eq(sponsorships.id, id))
    .limit(1);
  return row?.clientId ?? null;
}

/** PENDING sponsorships for an event (+ batch.labName), newest first. */
export interface PendingSponsorshipRow {
  id: string;
  code: string;
  beneficiaryName: string;
  beneficiaryEmail: string;
  totalAmount: number;
  coversBasePrice: boolean;
  coveredAccessIds: string[];
  batch: { labName: string };
}

export async function getPendingSponsorships(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<PendingSponsorshipRow[]> {
  const rows = await db
    .select({
      id: sponsorships.id,
      code: sponsorships.code,
      beneficiaryName: sponsorships.beneficiaryName,
      beneficiaryEmail: sponsorships.beneficiaryEmail,
      totalAmount: sponsorships.totalAmount,
      coversBasePrice: sponsorships.coversBasePrice,
      coveredAccessIds: sponsorships.coveredAccessIds,
      labName: sponsorshipBatches.labName,
    })
    .from(sponsorships)
    .innerJoin(
      sponsorshipBatches,
      eq(sponsorships.batchId, sponsorshipBatches.id),
    )
    .where(
      and(eq(sponsorships.eventId, eventId), eq(sponsorships.status, "PENDING")),
    )
    .orderBy(desc(sponsorships.createdAt));
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    beneficiaryName: r.beneficiaryName,
    beneficiaryEmail: r.beneficiaryEmail,
    totalAmount: r.totalAmount,
    coversBasePrice: r.coversBasePrice,
    coveredAccessIds: r.coveredAccessIds ?? [],
    batch: { labName: r.labName },
  }));
}

/** Registration + existing usage coverage (for available/link computation). */
export interface RegistrationCoverageRow {
  id: string;
  eventId: string;
  totalAmount: number;
  baseAmount: number;
  accessTypeIds: string[];
  priceBreakdown: unknown;
  existingUsages: ExistingUsageRow[];
}

export interface ExistingUsageRow {
  sponsorshipId: string;
  sponsorship: {
    code: string;
    coversBasePrice: boolean;
    coveredAccessIds: string[];
  };
}

async function loadExistingUsages(
  db: DbExecutor,
  registrationId: string,
): Promise<ExistingUsageRow[]> {
  const rows = await db
    .select({
      sponsorshipId: sponsorshipUsages.sponsorshipId,
      code: sponsorships.code,
      coversBasePrice: sponsorships.coversBasePrice,
      coveredAccessIds: sponsorships.coveredAccessIds,
    })
    .from(sponsorshipUsages)
    .innerJoin(
      sponsorships,
      eq(sponsorshipUsages.sponsorshipId, sponsorships.id),
    )
    .where(eq(sponsorshipUsages.registrationId, registrationId));
  return rows.map((u) => ({
    sponsorshipId: u.sponsorshipId,
    sponsorship: {
      code: u.code,
      coversBasePrice: u.coversBasePrice,
      coveredAccessIds: u.coveredAccessIds ?? [],
    },
  }));
}

export async function getRegistrationCoverage(
  registrationId: string,
  db: DbExecutor = getDb(),
): Promise<RegistrationCoverageRow | null> {
  const [reg] = await db
    .select({
      id: registrations.id,
      eventId: registrations.eventId,
      totalAmount: registrations.totalAmount,
      baseAmount: registrations.baseAmount,
      accessTypeIds: registrations.accessTypeIds,
      priceBreakdown: registrations.priceBreakdown,
    })
    .from(registrations)
    .where(eq(registrations.id, registrationId))
    .limit(1);
  if (!reg) return null;
  return {
    id: reg.id,
    eventId: reg.eventId,
    totalAmount: reg.totalAmount,
    baseAmount: reg.baseAmount,
    accessTypeIds: reg.accessTypeIds ?? [],
    priceBreakdown: reg.priceBreakdown,
    existingUsages: await loadExistingUsages(db, registrationId),
  };
}

/** Linked sponsorships for a registration — flattened usage+sponsorship+batch. */
export interface LinkedSponsorshipItem {
  id: string;
  code: string;
  status: string;
  beneficiaryName: string;
  beneficiaryEmail: string;
  coversBasePrice: boolean;
  coveredAccessIds: string[];
  totalAmount: number;
  batch: { id: string; labName: string; contactName: string; email: string };
  usage: { id: string; amountApplied: number; appliedAt: Date };
}

export async function getLinkedSponsorships(
  registrationId: string,
  db: DbExecutor = getDb(),
): Promise<LinkedSponsorshipItem[]> {
  const rows = await db
    .select({
      usageId: sponsorshipUsages.id,
      amountApplied: sponsorshipUsages.amountApplied,
      appliedAt: sponsorshipUsages.appliedAt,
      sponsorship: sponsorships,
      batchId: sponsorshipBatches.id,
      labName: sponsorshipBatches.labName,
      contactName: sponsorshipBatches.contactName,
      email: sponsorshipBatches.email,
    })
    .from(sponsorshipUsages)
    .innerJoin(
      sponsorships,
      eq(sponsorshipUsages.sponsorshipId, sponsorships.id),
    )
    .innerJoin(
      sponsorshipBatches,
      eq(sponsorships.batchId, sponsorshipBatches.id),
    )
    .where(eq(sponsorshipUsages.registrationId, registrationId));
  return rows.map((r) => ({
    id: r.sponsorship.id,
    code: r.sponsorship.code,
    status: r.sponsorship.status,
    beneficiaryName: r.sponsorship.beneficiaryName,
    beneficiaryEmail: r.sponsorship.beneficiaryEmail,
    coversBasePrice: r.sponsorship.coversBasePrice,
    coveredAccessIds: r.sponsorship.coveredAccessIds ?? [],
    totalAmount: r.sponsorship.totalAmount,
    batch: {
      id: r.batchId,
      labName: r.labName,
      contactName: r.contactName,
      email: r.email,
    },
    usage: {
      id: r.usageId,
      amountApplied: r.amountApplied,
      appliedAt: r.appliedAt,
    },
  }));
}

// ============================================================================
// Mutation primitives (all ride the caller's tx via DbExecutor)
// ============================================================================

/** Sponsorship + event gate + usages (update/cancel/delete guard chains). */
export interface SponsorshipForMutation extends SponsorshipRow {
  event: { clientId: string; status: string; client: SponsorshipClientGate };
  usages: Array<{ id: string; registrationId: string | null }>;
}

export async function findSponsorshipForMutation(
  db: DbExecutor,
  id: string,
): Promise<SponsorshipForMutation | null> {
  const [row] = await db
    .select({
      sponsorship: sponsorships,
      clientId: events.clientId,
      status: events.status,
      clientActive: clients.active,
      enabledModules: clients.enabledModules,
    })
    .from(sponsorships)
    .innerJoin(events, eq(sponsorships.eventId, events.id))
    .innerJoin(clients, eq(events.clientId, clients.id))
    .where(eq(sponsorships.id, id))
    .limit(1);
  if (!row) return null;
  const usages = await db
    .select({
      id: sponsorshipUsages.id,
      registrationId: sponsorshipUsages.registrationId,
    })
    .from(sponsorshipUsages)
    .where(eq(sponsorshipUsages.sponsorshipId, id));
  return {
    ...row.sponsorship,
    event: {
      clientId: row.clientId,
      status: row.status,
      client: { active: row.clientActive, enabledModules: row.enabledModules },
    },
    usages,
  };
}

export interface AccessItemForOverlap {
  id: string;
  name: string;
  type: string;
  groupLabel: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  price: number;
}

/** Active EventAccess rows for the given ids scoped to an event. */
export async function findActiveEventAccess(
  db: DbExecutor,
  eventId: string,
  ids: string[],
): Promise<AccessItemForOverlap[]> {
  if (ids.length === 0) return [];
  return db
    .select({
      id: eventAccess.id,
      name: eventAccess.name,
      type: sql<string>`${eventAccess.type}`,
      groupLabel: eventAccess.groupLabel,
      startsAt: eventAccess.startsAt,
      endsAt: eventAccess.endsAt,
      price: eventAccess.price,
    })
    .from(eventAccess)
    .where(
      and(
        inArray(eventAccess.id, ids),
        eq(eventAccess.eventId, eventId),
        eq(eventAccess.active, true),
      ),
    );
}

export async function getEventBasePrice(
  db: DbExecutor,
  eventId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ basePrice: eventPricing.basePrice })
    .from(eventPricing)
    .where(eq(eventPricing.eventId, eventId))
    .limit(1);
  return row?.basePrice ?? null;
}

export interface EventPricingForBatch {
  basePrice: number;
  currency: string;
}

export async function getEventPricingForBatch(
  db: DbExecutor,
  eventId: string,
): Promise<EventPricingForBatch | null> {
  const [row] = await db
    .select({
      basePrice: eventPricing.basePrice,
      currency: eventPricing.currency,
    })
    .from(eventPricing)
    .where(eq(eventPricing.eventId, eventId))
    .limit(1);
  return row ?? null;
}

export async function updateSponsorshipRow(
  db: DbExecutor,
  id: string,
  patch: Partial<{
    beneficiaryName: string;
    beneficiaryEmail: string;
    beneficiaryPhone: string | null;
    beneficiaryAddress: string | null;
    coversBasePrice: boolean;
    coveredAccessIds: string[];
    totalAmount: number;
    status: SponsorshipRow["status"];
  }>,
): Promise<void> {
  await db.update(sponsorships).set(patch).where(eq(sponsorships.id, id));
}

export async function deleteSponsorshipRow(
  db: DbExecutor,
  id: string,
): Promise<void> {
  await db.delete(sponsorships).where(eq(sponsorships.id, id));
}

// --- Batch creation primitives ---------------------------------------------

export interface EventForBatch {
  id: string;
  name: string;
  slug: string;
  status: string;
  startDate: Date;
  location: string | null;
  clientId: string;
  client: SponsorshipClientGate & { name: string };
}

export async function findEventForBatch(
  db: DbExecutor,
  eventId: string,
): Promise<EventForBatch | null> {
  const [row] = await db
    .select({
      id: events.id,
      name: events.name,
      slug: events.slug,
      status: events.status,
      startDate: events.startDate,
      location: events.location,
      clientId: events.clientId,
      clientActive: clients.active,
      enabledModules: clients.enabledModules,
      clientName: clients.name,
    })
    .from(events)
    .innerJoin(clients, eq(events.clientId, clients.id))
    .where(eq(events.id, eventId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    startDate: row.startDate,
    location: row.location,
    clientId: row.clientId,
    client: {
      active: row.clientActive,
      enabledModules: row.enabledModules,
      name: row.clientName,
    },
  };
}

/** Sponsor form by id scoped to event (NO active filter — matches batch validate). */
export async function findSponsorFormById(
  db: DbExecutor,
  formId: string,
  eventId: string,
): Promise<{ id: string; schema: unknown } | null> {
  const [row] = await db
    .select({ id: forms.id, schema: forms.schema })
    .from(forms)
    .where(
      and(
        eq(forms.id, formId),
        eq(forms.eventId, eventId),
        eq(forms.type, "SPONSOR"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Active SPONSOR form for an event (route-level lookup, active:true). */
export async function getActiveSponsorForm(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<{ id: string; eventId: string; schema: unknown } | null> {
  const [row] = await db
    .select({ id: forms.id, eventId: forms.eventId, schema: forms.schema })
    .from(forms)
    .where(
      and(
        eq(forms.eventId, eventId),
        eq(forms.type, "SPONSOR"),
        eq(forms.active, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getFormSchema(
  db: DbExecutor,
  formId: string,
): Promise<unknown | null> {
  const [row] = await db
    .select({ schema: forms.schema })
    .from(forms)
    .where(eq(forms.id, formId))
    .limit(1);
  return row?.schema ?? null;
}

export interface RegistrationForBatch {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  totalAmount: number;
  sponsorshipAmount: number;
  baseAmount: number;
  accessTypeIds: string[];
  priceBreakdown: unknown;
  paymentStatus: string;
  linkBaseUrl: string | null;
  editToken: string | null;
}

export async function findRegistrationsForBatch(
  db: DbExecutor,
  eventId: string,
  ids: string[],
): Promise<RegistrationForBatch[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: registrations.id,
      email: registrations.email,
      firstName: registrations.firstName,
      lastName: registrations.lastName,
      phone: registrations.phone,
      totalAmount: registrations.totalAmount,
      sponsorshipAmount: registrations.sponsorshipAmount,
      baseAmount: registrations.baseAmount,
      accessTypeIds: registrations.accessTypeIds,
      priceBreakdown: registrations.priceBreakdown,
      paymentStatus: registrations.paymentStatus,
      linkBaseUrl: registrations.linkBaseUrl,
      editToken: registrations.editToken,
    })
    .from(registrations)
    .where(
      and(inArray(registrations.id, ids), eq(registrations.eventId, eventId)),
    );
  return rows.map((r) => ({ ...r, accessTypeIds: r.accessTypeIds ?? [] }));
}

export async function insertSponsorshipBatch(
  db: DbExecutor,
  data: {
    eventId: string;
    formId: string;
    labName: string;
    contactName: string;
    email: string;
    phone: string | null;
    formData: unknown;
  },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(sponsorshipBatches)
    .values(data as typeof sponsorshipBatches.$inferInsert)
    .returning({ id: sponsorshipBatches.id });
  return row;
}

export async function insertSponsorship(
  db: DbExecutor,
  data: {
    batchId: string;
    eventId: string;
    code: string;
    status: SponsorshipRow["status"];
    beneficiaryName: string;
    beneficiaryEmail: string;
    beneficiaryPhone: string | null;
    beneficiaryAddress: string | null;
    coversBasePrice: boolean;
    coveredAccessIds: string[];
    totalAmount: number;
    targetRegistrationId?: string | null;
  },
): Promise<SponsorshipRow> {
  const [row] = await db.insert(sponsorships).values(data).returning();
  return row;
}

/** Does a sponsorship with this code exist? (generateUniqueCode collision check.) */
export async function sponsorshipCodeExists(
  db: DbExecutor,
  code: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: sponsorships.id })
    .from(sponsorships)
    .where(eq(sponsorships.code, code))
    .limit(1);
  return !!row;
}

// --- Link / unlink primitives ----------------------------------------------

export interface SponsorshipForLink extends SponsorshipRow {
  event: {
    clientId: string;
    name: string;
    slug: string;
    startDate: Date;
    location: string | null;
    status: string;
    client: SponsorshipClientGate & { name: string };
  };
  batch: { labName: string; contactName: string; email: string };
}

export async function findSponsorshipForLink(
  db: DbExecutor,
  sponsorshipId: string,
): Promise<SponsorshipForLink | null> {
  const [row] = await db
    .select({
      sponsorship: sponsorships,
      clientId: events.clientId,
      eventName: events.name,
      slug: events.slug,
      startDate: events.startDate,
      location: events.location,
      status: events.status,
      clientActive: clients.active,
      enabledModules: clients.enabledModules,
      clientName: clients.name,
      labName: sponsorshipBatches.labName,
      contactName: sponsorshipBatches.contactName,
      batchEmail: sponsorshipBatches.email,
    })
    .from(sponsorships)
    .innerJoin(events, eq(sponsorships.eventId, events.id))
    .innerJoin(clients, eq(events.clientId, clients.id))
    .innerJoin(
      sponsorshipBatches,
      eq(sponsorships.batchId, sponsorshipBatches.id),
    )
    .where(eq(sponsorships.id, sponsorshipId))
    .limit(1);
  if (!row) return null;
  return {
    ...row.sponsorship,
    event: {
      clientId: row.clientId,
      name: row.eventName,
      slug: row.slug,
      startDate: row.startDate,
      location: row.location,
      status: row.status,
      client: {
        active: row.clientActive,
        enabledModules: row.enabledModules,
        name: row.clientName,
      },
    },
    batch: {
      labName: row.labName,
      contactName: row.contactName,
      email: row.batchEmail,
    },
  };
}

export interface RegistrationForLink {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  eventId: string;
  totalAmount: number;
  paidAmount: number;
  baseAmount: number;
  linkBaseUrl: string | null;
  editToken: string | null;
  accessTypeIds: string[];
  priceBreakdown: unknown;
  paymentStatus: string;
  sponsorshipAmount: number;
  existingUsages: ExistingUsageRow[];
}

export async function findRegistrationForLink(
  db: DbExecutor,
  registrationId: string,
): Promise<RegistrationForLink | null> {
  const [reg] = await db
    .select({
      id: registrations.id,
      email: registrations.email,
      firstName: registrations.firstName,
      lastName: registrations.lastName,
      phone: registrations.phone,
      eventId: registrations.eventId,
      totalAmount: registrations.totalAmount,
      paidAmount: registrations.paidAmount,
      baseAmount: registrations.baseAmount,
      linkBaseUrl: registrations.linkBaseUrl,
      editToken: registrations.editToken,
      accessTypeIds: registrations.accessTypeIds,
      priceBreakdown: registrations.priceBreakdown,
      paymentStatus: registrations.paymentStatus,
      sponsorshipAmount: registrations.sponsorshipAmount,
    })
    .from(registrations)
    .where(eq(registrations.id, registrationId))
    .limit(1);
  if (!reg) return null;
  return {
    ...reg,
    accessTypeIds: reg.accessTypeIds ?? [],
    existingUsages: await loadExistingUsages(db, registrationId),
  };
}

export async function findUsage(
  db: DbExecutor,
  sponsorshipId: string,
  registrationId: string,
): Promise<SponsorshipUsageRow | null> {
  const [row] = await db
    .select()
    .from(sponsorshipUsages)
    .where(
      and(
        eq(sponsorshipUsages.sponsorshipId, sponsorshipId),
        eq(sponsorshipUsages.registrationId, registrationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertUsage(
  db: DbExecutor,
  data: {
    sponsorshipId: string;
    registrationId: string;
    amountApplied: number;
    appliedBy: string;
  },
): Promise<SponsorshipUsageRow> {
  const [row] = await db.insert(sponsorshipUsages).values(data).returning();
  return row;
}

export async function deleteUsage(
  db: DbExecutor,
  usageId: string,
): Promise<void> {
  await db.delete(sponsorshipUsages).where(eq(sponsorshipUsages.id, usageId));
}

/** CAS: set status USED only while not CANCELLED. Returns rows affected. */
export async function casSetSponsorshipUsed(
  db: DbExecutor,
  sponsorshipId: string,
): Promise<number> {
  const rows = await db
    .update(sponsorships)
    .set({ status: "USED" })
    .where(
      and(
        eq(sponsorships.id, sponsorshipId),
        ne(sponsorships.status, "CANCELLED"),
      ),
    )
    .returning({ id: sponsorships.id });
  return rows.length;
}

export async function findUsageAmountsByRegistration(
  db: DbExecutor,
  registrationId: string,
): Promise<Array<{ amountApplied: number }>> {
  return db
    .select({ amountApplied: sponsorshipUsages.amountApplied })
    .from(sponsorshipUsages)
    .where(eq(sponsorshipUsages.registrationId, registrationId));
}

export async function countUsagesForSponsorship(
  db: DbExecutor,
  sponsorshipId: string,
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(sponsorshipUsages)
    .where(eq(sponsorshipUsages.sponsorshipId, sponsorshipId));
  return Number(row?.value ?? 0);
}

export async function updateRegistrationSettlement(
  db: DbExecutor,
  registrationId: string,
  patch: Partial<{
    sponsorshipAmount: number;
    paymentMethod: string | null;
    paymentStatus: string;
    paidAt: Date | null;
    priceBreakdown: unknown;
  }>,
): Promise<void> {
  await db
    .update(registrations)
    .set(patch as Partial<typeof registrations.$inferInsert>)
    .where(eq(registrations.id, registrationId));
}

export interface RegistrationSettlementState {
  sponsorshipAmount: number;
  paidAmount: number;
  paymentMethod: string | null;
  paymentStatus: string;
  eventId: string;
  totalAmount: number;
  priceBreakdown: unknown;
}

export async function findRegistrationSettlementState(
  db: DbExecutor,
  registrationId: string,
): Promise<RegistrationSettlementState | null> {
  const [row] = await db
    .select({
      sponsorshipAmount: registrations.sponsorshipAmount,
      paidAmount: registrations.paidAmount,
      paymentMethod: registrations.paymentMethod,
      paymentStatus: registrations.paymentStatus,
      eventId: registrations.eventId,
      totalAmount: registrations.totalAmount,
      priceBreakdown: registrations.priceBreakdown,
    })
    .from(registrations)
    .where(eq(registrations.id, registrationId))
    .limit(1);
  return row ?? null;
}

export interface SponsorshipUnlinkState {
  status: string;
  coveredAccessIds: string[];
  event: { status: string; client: SponsorshipClientGate };
}

export async function findSponsorshipUnlinkState(
  db: DbExecutor,
  sponsorshipId: string,
): Promise<SponsorshipUnlinkState | null> {
  const [row] = await db
    .select({
      status: sponsorships.status,
      coveredAccessIds: sponsorships.coveredAccessIds,
      eventStatus: events.status,
      clientActive: clients.active,
      enabledModules: clients.enabledModules,
    })
    .from(sponsorships)
    .innerJoin(events, eq(sponsorships.eventId, events.id))
    .innerJoin(clients, eq(events.clientId, clients.id))
    .where(eq(sponsorships.id, sponsorshipId))
    .limit(1);
  if (!row) return null;
  return {
    status: row.status,
    coveredAccessIds: row.coveredAccessIds ?? [],
    event: {
      status: row.eventStatus,
      client: { active: row.clientActive, enabledModules: row.enabledModules },
    },
  };
}

export interface RecalcSponsorship {
  coversBasePrice: boolean;
  coveredAccessIds: string[];
  totalAmount: number;
  usages: Array<{
    id: string;
    registration: {
      id: string;
      eventId: string;
      totalAmount: number;
      paidAmount: number;
      baseAmount: number;
      paymentStatus: string;
      paidAt: Date | null;
      accessTypeIds: string[];
      priceBreakdown: unknown;
    } | null;
  }>;
}

export async function findSponsorshipForRecalc(
  db: DbExecutor,
  sponsorshipId: string,
): Promise<RecalcSponsorship | null> {
  const [sp] = await db
    .select({
      coversBasePrice: sponsorships.coversBasePrice,
      coveredAccessIds: sponsorships.coveredAccessIds,
      totalAmount: sponsorships.totalAmount,
    })
    .from(sponsorships)
    .where(eq(sponsorships.id, sponsorshipId))
    .limit(1);
  if (!sp) return null;
  const usageRows = await db
    .select({
      usageId: sponsorshipUsages.id,
      regId: registrations.id,
      eventId: registrations.eventId,
      totalAmount: registrations.totalAmount,
      paidAmount: registrations.paidAmount,
      baseAmount: registrations.baseAmount,
      paymentStatus: registrations.paymentStatus,
      paidAt: registrations.paidAt,
      accessTypeIds: registrations.accessTypeIds,
      priceBreakdown: registrations.priceBreakdown,
    })
    .from(sponsorshipUsages)
    .leftJoin(
      registrations,
      eq(sponsorshipUsages.registrationId, registrations.id),
    )
    .where(eq(sponsorshipUsages.sponsorshipId, sponsorshipId));
  return {
    coversBasePrice: sp.coversBasePrice,
    coveredAccessIds: sp.coveredAccessIds ?? [],
    totalAmount: sp.totalAmount,
    usages: usageRows.map((u) => ({
      id: u.usageId,
      registration: u.regId
        ? {
            id: u.regId,
            eventId: u.eventId as string,
            totalAmount: u.totalAmount as number,
            paidAmount: u.paidAmount as number,
            baseAmount: u.baseAmount as number,
            paymentStatus: u.paymentStatus as string,
            paidAt: u.paidAt,
            accessTypeIds: (u.accessTypeIds as string[] | null) ?? [],
            priceBreakdown: u.priceBreakdown,
          }
        : null,
    })),
  };
}

export async function updateUsageAmount(
  db: DbExecutor,
  usageId: string,
  amountApplied: number,
): Promise<void> {
  await db
    .update(sponsorshipUsages)
    .set({ amountApplied })
    .where(eq(sponsorshipUsages.id, usageId));
}

// ---------------------------------------------------------------------------
// Outbox enqueue (sponsorship email). Same SAVEPOINT-safe dedupe semantics as
// access.ts's enqueueTriggeredEmailOutbox — rides the caller's transaction.
// The worker's `email.sponsorship` handler consumes this payload shape
// (trigger + eventId + QueueSponsorshipEmailInput).
// ---------------------------------------------------------------------------

export type SponsorshipEmailOutboxPayload = {
  trigger: string;
  eventId: string;
  input: {
    recipientEmail: string;
    recipientName?: string;
    context: Record<string, unknown>;
    registrationId?: string;
  };
};

/** Enqueue an `email.sponsorship` outbox event; idempotent per dedupeKey. Returns false if skipped. */
export async function enqueueSponsorshipEmailOutbox(
  exec: DbExecutor,
  payload: SponsorshipEmailOutboxPayload,
  dedupeKey: string,
): Promise<boolean> {
  return enqueueOutboxEvent(exec, {
    type: "email.sponsorship",
    aggregateType: "Registration",
    aggregateId: payload.input.registrationId,
    eventId: payload.eventId,
    dedupeKey,
    payload,
    maxAttempts: 5,
  });
}

// ============================================================================
// Route-guard registration lookup — OWNED BY registrations module.
// ponytail: NOTE FOR VERIFIER — belongs in queries/registrations.ts (empty stub
// at port time). Faithful port of the fields the sponsorship routes'
// getRegistrationById guard needs. Relocate when registrations domain lands.
// ============================================================================

export interface RegistrationRouteGuard {
  id: string;
  event: { id: string; clientId: string };
}

export async function getRegistrationForSponsorship(
  registrationId: string,
  db: DbExecutor = getDb(),
): Promise<RegistrationRouteGuard | null> {
  const [row] = await db
    .select({
      id: registrations.id,
      eventId: registrations.eventId,
      clientId: events.clientId,
    })
    .from(registrations)
    .innerJoin(events, eq(registrations.eventId, events.id))
    .where(eq(registrations.id, registrationId))
    .limit(1);
  if (!row) return null;
  return { id: row.id, event: { id: row.eventId, clientId: row.clientId } };
}

// ============================================================================
// Registrant search — OWNED BY registrations module.
// ponytail: NOTE FOR VERIFIER — legacy registration-queries.searchRegistrantsForSponsorship.
// Relocate to queries/registrations.ts when that domain lands.
// ============================================================================

export interface RegistrantSearchResult {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  paymentStatus: string;
  totalAmount: number;
  baseAmount: number;
  accessAmount: number;
  sponsorshipAmount: number;
  accessTypeIds: string[];
  coveredAccessIds: string[];
  isBasePriceCovered: boolean;
  phone: string | null;
  formData: unknown;
}

export async function searchRegistrantsForSponsorship(
  eventId: string,
  query: { query: string; unpaidOnly: boolean; limit: number },
  db: DbExecutor = getDb(),
): Promise<RegistrantSearchResult[]> {
  const term = `%${query.query}%`;
  const clauses: (SQL | undefined)[] = [
    eq(registrations.eventId, eventId),
    or(
      ilike(registrations.email, term),
      ilike(registrations.firstName, term),
      ilike(registrations.lastName, term),
    ),
  ];
  if (query.unpaidOnly) {
    clauses.push(
      inArray(registrations.paymentStatus, ["PENDING", "VERIFYING", "PARTIAL"]),
    );
  }

  const regRows = await db
    .select({
      id: registrations.id,
      email: registrations.email,
      firstName: registrations.firstName,
      lastName: registrations.lastName,
      paymentStatus: registrations.paymentStatus,
      totalAmount: registrations.totalAmount,
      baseAmount: registrations.baseAmount,
      accessAmount: registrations.accessAmount,
      sponsorshipAmount: registrations.sponsorshipAmount,
      accessTypeIds: registrations.accessTypeIds,
      phone: registrations.phone,
      formData: registrations.formData,
    })
    .from(registrations)
    .where(and(...clauses))
    .orderBy(asc(registrations.lastName), asc(registrations.firstName))
    .limit(query.limit);

  const regIds = regRows.map((r) => r.id);
  const usageRows = regIds.length
    ? await db
        .select({
          registrationId: sponsorshipUsages.registrationId,
          status: sponsorships.status,
          coversBasePrice: sponsorships.coversBasePrice,
          coveredAccessIds: sponsorships.coveredAccessIds,
        })
        .from(sponsorshipUsages)
        .innerJoin(
          sponsorships,
          eq(sponsorshipUsages.sponsorshipId, sponsorships.id),
        )
        .where(inArray(sponsorshipUsages.registrationId, regIds))
    : [];

  const usedByReg = new Map<
    string,
    Array<{ coversBasePrice: boolean; coveredAccessIds: string[] }>
  >();
  for (const u of usageRows) {
    if (u.status !== "USED" || !u.registrationId) continue;
    const list = usedByReg.get(u.registrationId) ?? [];
    list.push({
      coversBasePrice: u.coversBasePrice,
      coveredAccessIds: u.coveredAccessIds ?? [],
    });
    usedByReg.set(u.registrationId, list);
  }

  return regRows.map((r) => {
    const used = usedByReg.get(r.id) ?? [];
    return {
      id: r.id,
      email: r.email,
      firstName: r.firstName,
      lastName: r.lastName,
      paymentStatus: r.paymentStatus,
      totalAmount: r.totalAmount,
      baseAmount: r.baseAmount,
      accessAmount: r.accessAmount,
      sponsorshipAmount: r.sponsorshipAmount,
      accessTypeIds: r.accessTypeIds ?? [],
      coveredAccessIds: [...new Set(used.flatMap((s) => s.coveredAccessIds))],
      isBasePriceCovered: used.some((s) => s.coversBasePrice),
      phone: r.phone,
      formData: r.formData,
    };
  });
}
