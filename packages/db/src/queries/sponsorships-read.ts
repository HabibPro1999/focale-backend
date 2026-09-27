import { and, asc, count, desc, eq, ilike, inArray, or, sum, type SQL } from "drizzle-orm";
import type { OffsetPagination } from "@app/shared";
import type { ListSponsorshipsQuery, SponsorshipStats } from "@app/contracts";
import { getDb, type DbExecutor } from "../client";
import { sponsorships, sponsorshipBatches, sponsorshipUsages } from "../schema/sponsorships";
import { events, eventAccess } from "../schema/events-access";
import { registrations } from "../schema/registrations";
import {
  type SponsorshipRow,
  type SponsorshipUsageRow,
  type SponsorshipBatchRow,
  type ExistingUsageRow,
  appendToGroup,
  loadExistingUsages,
} from "./sponsorships-shared";

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
  query: Omit<ListSponsorshipsQuery, "page" | "limit"> & OffsetPagination,
  db: DbExecutor = getDb(),
): Promise<{ data: SponsorshipListItem[]; total: number; stats: SponsorshipStats }> {
  const { offset, limit, status, search, sortBy, sortOrder } = query;
  const where = buildSponsorshipWhere(eventId, { status, search });
  const dir = sortOrder === "asc" ? asc : desc;
  const orderCol =
    sortBy === "beneficiaryName"
      ? sponsorships.beneficiaryName
      : sortBy === "totalAmount"
        ? sponsorships.totalAmount
        : sponsorships.createdAt;

  const batchJoin = eq(sponsorships.batchId, sponsorshipBatches.id);

  const [rows, totalRows, statsRaw] = await Promise.all([
    db
      .select({
        sponsorship: sponsorships,
        batch: {
          id: sponsorshipBatches.id,
          labName: sponsorshipBatches.labName,
          contactName: sponsorshipBatches.contactName,
          email: sponsorshipBatches.email,
        },
      })
      .from(sponsorships)
      .innerJoin(sponsorshipBatches, batchJoin)
      .where(where)
      .orderBy(dir(orderCol))
      .limit(limit)
      .offset(offset),
    db
      .select({ value: count() })
      .from(sponsorships)
      .innerJoin(sponsorshipBatches, batchJoin)
      .where(where),
    db
      .select({
        status: sponsorships.status,
        cnt: count(),
        amount: sum(sponsorships.totalAmount),
      })
      .from(sponsorships)
      .innerJoin(sponsorshipBatches, batchJoin)
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
    appendToGroup(usagesBySponsorship, u.sponsorshipId, {
      registrationId: u.registrationId,
      amountApplied: u.amountApplied,
    });
  }

  const data: SponsorshipListItem[] = rows.map((r) => ({
    ...r.sponsorship,
    batch: r.batch,
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

  return { data, total, stats };
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
      registration: {
        id: registrations.id,
        email: registrations.email,
        firstName: registrations.firstName,
        lastName: registrations.lastName,
      },
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
      registration: u.registration,
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
      batch: {
        id: sponsorshipBatches.id,
        labName: sponsorshipBatches.labName,
        contactName: sponsorshipBatches.contactName,
        email: sponsorshipBatches.email,
        phone: sponsorshipBatches.phone,
      },
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
    batch: row.batch,
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
      usage: {
        id: sponsorshipUsages.id,
        amountApplied: sponsorshipUsages.amountApplied,
        appliedAt: sponsorshipUsages.appliedAt,
      },
      sponsorship: sponsorships,
      batch: {
        id: sponsorshipBatches.id,
        labName: sponsorshipBatches.labName,
        contactName: sponsorshipBatches.contactName,
        email: sponsorshipBatches.email,
      },
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
    batch: r.batch,
    usage: r.usage,
  }));
}
