import { and, eq, ne } from "drizzle-orm";
import type { AutomaticEmailTrigger, PriceBreakdown } from "@app/contracts";
import type { DbExecutor } from "../../client";
import { enqueueOutboxEvent } from "../../outbox";
import {
  sponsorships,
  sponsorshipBatches,
  sponsorshipUsages,
} from "../../schema/sponsorships";
import { events } from "../../schema/events-access";
import { clients } from "../../schema/users-clients";
import { registrations } from "../../schema/registrations";
import { clientModuleGateColumns } from "../clients";
import { checkRegistrationRow } from "../stored-json";
import {
  loadExistingUsages,
  type ExistingUsageRow,
  type SponsorshipRow,
  type SponsorshipUsageRow,
  type SponsorshipClientGate,
} from "./shared";

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
      event: {
        clientId: events.clientId,
        status: events.status,
      },
      client: clientModuleGateColumns,
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
    event: { ...row.event, client: row.client },
    usages,
  };
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
      event: {
        clientId: events.clientId,
        name: events.name,
        slug: events.slug,
        startDate: events.startDate,
        location: events.location,
        status: events.status,
      },
      client: { ...clientModuleGateColumns, name: clients.name },
      batch: {
        labName: sponsorshipBatches.labName,
        contactName: sponsorshipBatches.contactName,
        email: sponsorshipBatches.email,
      },
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
    event: { ...row.event, client: row.client },
    batch: row.batch,
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
  priceBreakdown: PriceBreakdown;
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
    ...checkRegistrationRow(reg),
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
  trigger: AutomaticEmailTrigger;
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
