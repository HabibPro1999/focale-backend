import { and, count, eq, inArray } from "drizzle-orm";
import type { EmbeddedPricingRule, EventPricingWithRules } from "@app/contracts";
import { getDb, type DbExecutor } from "../client";
import { eventPricing } from "../schema/pricing";
import { events, eventAccess } from "../schema/events-access";
import { clients } from "../schema/users-clients";
import { sponsorships } from "../schema/sponsorships";
import { registrations } from "../schema/registrations";
import { forms } from "../schema/forms";

// Type names are `Pricing*`-prefixed to stay unique across the shared queries barrel.
type PricingRow = typeof eventPricing.$inferSelect;
export type PricingRowInsert = typeof eventPricing.$inferInsert;
export type PricingRowUpdate = Partial<PricingRowInsert>;
export type PricingAccessRow = typeof eventAccess.$inferSelect;

interface ClientGate {
  active: boolean;
  enabledModules: string[] | null;
}

/** Event gate row used inside the pricing update transaction. */
export interface PricingEventGate {
  status: string;
  client: ClientGate;
  /** Currency of the current EventPricing row, or null if none exists yet. */
  currentCurrency: string | null;
}

function parseEventPricing(row: PricingRow): EventPricingWithRules {
  return {
    ...row,
    rules: (row.rules as unknown as EmbeddedPricingRule[]) ?? [],
  };
}

/** findUnique EventPricing by eventId, with rules JSON parsed. Null when absent. */
export async function getEventPricing(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<EventPricingWithRules | null> {
  const [row] = await db
    .select()
    .from(eventPricing)
    .where(eq(eventPricing.eventId, eventId));
  return row ? parseEventPricing(row) : null;
}

/**
 * Event + client module-gate state + current pricing currency, in one query.
 * Null when the event does not exist. Left-joins EventPricing so a fresh event
 * (no pricing row yet) still resolves with currentCurrency = null.
 */
export async function getEventPricingGate(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<PricingEventGate | null> {
  const [row] = await db
    .select({
      status: events.status,
      active: clients.active,
      enabledModules: clients.enabledModules,
      currentCurrency: eventPricing.currency,
    })
    .from(events)
    .innerJoin(clients, eq(events.clientId, clients.id))
    .leftJoin(eventPricing, eq(eventPricing.eventId, events.id))
    .where(eq(events.id, eventId));
  if (!row) return null;
  return {
    status: row.status,
    client: { active: row.active, enabledModules: row.enabledModules },
    currentCurrency: row.currentCurrency ?? null,
  };
}

/** Count registrations for an event (currency-change guard). */
export async function countRegistrations(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(registrations)
    .where(eq(registrations.eventId, eventId));
  return Number(row.value);
}

/** Upsert an EventPricing row (create-or-update on the unique eventId). */
export async function upsertEventPricing(
  db: DbExecutor,
  createData: PricingRowInsert,
  updateData: PricingRowUpdate,
): Promise<EventPricingWithRules> {
  const [row] = await db
    .insert(eventPricing)
    .values(createData)
    .onConflictDoUpdate({
      target: eventPricing.eventId,
      set: { ...updateData, updatedAt: new Date() },
    })
    .returning();
  return parseEventPricing(row);
}

/** EventAccess rows for the given ids scoped to an event (cross-event ids drop out). */
export async function findEventAccessByIds(
  eventId: string,
  accessIds: string[],
  db: DbExecutor = getDb(),
): Promise<PricingAccessRow[]> {
  if (accessIds.length === 0) return [];
  return db
    .select()
    .from(eventAccess)
    .where(
      and(inArray(eventAccess.id, accessIds), eq(eventAccess.eventId, eventId)),
    );
}

/** Sponsorship data for validation — only PENDING codes for the event. */
export interface PricingPendingSponsorship {
  code: string;
  totalAmount: number;
  coversBasePrice: boolean;
  coveredAccessIds: string[];
}

export async function findPendingSponsorships(
  eventId: string,
  upperCodes: string[],
  db: DbExecutor = getDb(),
): Promise<PricingPendingSponsorship[]> {
  if (upperCodes.length === 0) return [];
  const rows = await db
    .select({
      code: sponsorships.code,
      totalAmount: sponsorships.totalAmount,
      coversBasePrice: sponsorships.coversBasePrice,
      coveredAccessIds: sponsorships.coveredAccessIds,
    })
    .from(sponsorships)
    .where(
      and(
        eq(sponsorships.eventId, eventId),
        inArray(sponsorships.code, upperCodes),
        eq(sponsorships.status, "PENDING"),
      ),
    );
  return rows.map((r) => ({
    code: r.code,
    totalAmount: r.totalAmount,
    coversBasePrice: r.coversBasePrice,
    coveredAccessIds: r.coveredAccessIds ?? [],
  }));
}

/** Minimal event for ownership + writable checks (legacy getEventById usage). */
export interface PricingEventOwnership {
  id: string;
  clientId: string;
  status: string;
}

export async function getEventForOwnership(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<PricingEventOwnership | null> {
  const [row] = await db
    .select({ id: events.id, clientId: events.clientId, status: events.status })
    .from(events)
    .where(eq(events.id, eventId));
  return row ?? null;
}

/** Registration form + event/client gate for the public calculate-price route. */
export interface PricingFormQuote {
  eventId: string;
  schema: unknown;
  type: string;
  active: boolean;
  event: {
    status: string;
    endDate: Date;
    client: ClientGate;
  };
}

export async function getFormForPriceQuote(
  formId: string,
  db: DbExecutor = getDb(),
): Promise<PricingFormQuote | null> {
  const [row] = await db
    .select({
      eventId: forms.eventId,
      schema: forms.schema,
      type: forms.type,
      active: forms.active,
      status: events.status,
      endDate: events.endDate,
      clientActive: clients.active,
      enabledModules: clients.enabledModules,
    })
    .from(forms)
    .innerJoin(events, eq(forms.eventId, events.id))
    .innerJoin(clients, eq(events.clientId, clients.id))
    .where(eq(forms.id, formId));
  if (!row) return null;
  return {
    eventId: row.eventId,
    schema: row.schema,
    type: row.type,
    active: row.active,
    event: {
      status: row.status,
      endDate: row.endDate,
      client: { active: row.clientActive, enabledModules: row.enabledModules },
    },
  };
}
