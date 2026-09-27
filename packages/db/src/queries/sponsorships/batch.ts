import { and, eq, inArray, sql } from "drizzle-orm";
import type { PriceBreakdown, StoredFormSchemaJson } from "@app/contracts";
import { getDb, type DbExecutor } from "../../client";
import { sponsorships, sponsorshipBatches } from "../../schema/sponsorships";
import { events, eventAccess } from "../../schema/events-access";
import { eventPricing } from "../../schema/pricing";
import { clients } from "../../schema/users-clients";
import { registrations } from "../../schema/registrations";
import { forms } from "../../schema/forms";
import { clientModuleGateColumns } from "../clients";
import { checkFormRow, checkRegistrationRow, readFormSchema } from "../stored-json";
import type { SponsorshipRow, SponsorshipClientGate } from "./shared";

// Context reads and creation primitives used by the sponsor intake and admin links.

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
      client: { ...clientModuleGateColumns, name: clients.name },
    })
    .from(events)
    .innerJoin(clients, eq(events.clientId, clients.id))
    .where(eq(events.id, eventId))
    .limit(1);
  return row ?? null;
}

/** Sponsor form by id scoped to event (NO active filter — matches batch validate). */
export async function findSponsorFormById(
  db: DbExecutor,
  formId: string,
  eventId: string,
): Promise<{ id: string; schema: StoredFormSchemaJson } | null> {
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
  return checkFormRow(row) ?? null;
}

/** Active SPONSOR form for an event (route-level lookup, active:true). */
export async function getActiveSponsorForm(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<{ id: string; eventId: string; schema: StoredFormSchemaJson } | null> {
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
  return checkFormRow(row) ?? null;
}

export async function getFormSchema(
  db: DbExecutor,
  formId: string,
): Promise<StoredFormSchemaJson | null> {
  const [row] = await db
    .select({ schema: forms.schema })
    .from(forms)
    .where(eq(forms.id, formId))
    .limit(1);
  return row ? readFormSchema(row.schema, formId) : null;
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
  priceBreakdown: PriceBreakdown;
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
  return rows.map((r) => ({ ...checkRegistrationRow(r), accessTypeIds: r.accessTypeIds ?? [] }));
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
