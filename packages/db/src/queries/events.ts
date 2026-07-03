import { and, desc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
import { getDb, type DbExecutor } from "../client";
import {
  abstractBookJobs,
  abstracts,
  certificateTemplates,
  clients,
  emailTemplates,
  eventPricing,
  events,
  registrations,
} from "../schema";

// Row types inferred from the drizzle schema (snake_case DB ↔ camelCase fields).
export type EventRow = typeof events.$inferSelect;
// event_pricing lives in the pricing schema domain — keep the row type local so
// the db barrel doesn't collide with the pricing query module's own export.
type EventPricingRow = typeof eventPricing.$inferSelect;
export type EventWithPricing = EventRow & { pricing: EventPricingRow | null };

export interface ListEventsFilter {
  page: number;
  limit: number;
  clientId?: string;
  status?: "CLOSED" | "OPEN" | "ARCHIVED";
  search?: string;
}

// ---------------------------------------------------------------------------
// Simple reads (no caller transaction required)
// ---------------------------------------------------------------------------

/** Event + pricing by id, or null. Mirrors Prisma findUnique include:{pricing}. */
export async function getEventWithPricing(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<EventWithPricing | null> {
  const rows = await exec
    .select({ event: events, pricing: eventPricing })
    .from(events)
    .leftJoin(eventPricing, eq(eventPricing.eventId, events.id))
    .where(eq(events.id, id))
    .limit(1);
  if (!rows[0]) return null;
  return { ...rows[0].event, pricing: rows[0].pricing };
}

/** Event + pricing by slug, or null. */
export async function getEventWithPricingBySlug(
  slug: string,
  exec: DbExecutor = getDb(),
): Promise<EventWithPricing | null> {
  const rows = await exec
    .select({ event: events, pricing: eventPricing })
    .from(events)
    .leftJoin(eventPricing, eq(eventPricing.eventId, events.id))
    .where(eq(events.slug, slug))
    .limit(1);
  if (!rows[0]) return null;
  return { ...rows[0].event, pricing: rows[0].pricing };
}

/** True when an event row with this id exists. */
export async function eventExists(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<boolean> {
  const rows = await exec
    .select({ id: events.id })
    .from(events)
    .where(eq(events.id, id))
    .limit(1);
  return rows.length > 0;
}

export type ClientPublicFields = {
  id: string;
  name: string;
  logo: string | null;
  primaryColor: string | null;
  active: boolean;
  enabledModules: string[] | null;
};

export type EventWithPricingAndClient = EventWithPricing & {
  client: ClientPublicFields;
};

/** Single-query fetch for the public payment-config route (event + pricing + client). */
export async function getEventWithPricingAndClient(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<EventWithPricingAndClient | null> {
  const rows = await exec
    .select({
      event: events,
      pricing: eventPricing,
      client: {
        id: clients.id,
        name: clients.name,
        logo: clients.logo,
        primaryColor: clients.primaryColor,
        active: clients.active,
        enabledModules: clients.enabledModules,
      },
    })
    .from(events)
    .leftJoin(eventPricing, eq(eventPricing.eventId, events.id))
    .innerJoin(clients, eq(clients.id, events.clientId))
    .where(eq(events.id, id))
    .limit(1);
  if (!rows[0]) return null;
  return { ...rows[0].event, pricing: rows[0].pricing, client: rows[0].client };
}

/** Paginated list with clientId/status/search filters. Returns rows + total. */
export async function listEvents(
  filter: ListEventsFilter,
  exec: DbExecutor = getDb(),
): Promise<{ data: EventRow[]; total: number }> {
  const where = buildListWhere(filter);
  const skip = (filter.page - 1) * filter.limit;

  const [data, totalRows] = await Promise.all([
    exec
      .select()
      .from(events)
      .where(where)
      .orderBy(desc(events.createdAt))
      .limit(filter.limit)
      .offset(skip),
    exec.select({ value: sql<number>`count(*)::int` }).from(events).where(where),
  ]);

  return { data, total: totalRows[0]?.value ?? 0 };
}

/** Exported for db-tier SQL assertions. Builds the same predicate listEvents uses. */
export function buildListWhere(filter: ListEventsFilter) {
  const conds = [];
  if (filter.clientId) conds.push(eq(events.clientId, filter.clientId));
  if (filter.status) conds.push(eq(events.status, filter.status));
  if (filter.search) {
    const term = `%${filter.search}%`;
    conds.push(
      or(
        ilike(events.name, term),
        ilike(events.slug, term),
        ilike(events.description, term),
        ilike(events.location, term),
      ),
    );
  }
  return conds.length ? and(...conds) : undefined;
}

// ---------------------------------------------------------------------------
// Executor-taking helpers (ride the caller's transaction)
// ---------------------------------------------------------------------------

/** Slug lookup returning just the owning event id (or null). */
export async function getEventIdBySlugTx(
  exec: DbExecutor,
  slug: string,
): Promise<string | null> {
  const rows = await exec
    .select({ id: events.id })
    .from(events)
    .where(eq(events.slug, slug))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Count registrations for an event. */
export async function countRegistrationsTx(
  exec: DbExecutor,
  eventId: string,
): Promise<number> {
  const rows = await exec
    .select({ value: sql<number>`count(*)::int` })
    .from(registrations)
    .where(eq(registrations.eventId, eventId));
  return rows[0]?.value ?? 0;
}

export type NewEventValues = typeof events.$inferInsert;

export async function insertEventTx(
  exec: DbExecutor,
  values: NewEventValues,
): Promise<EventRow> {
  const [row] = await exec.insert(events).values(values).returning();
  return row;
}

export async function insertEventPricingTx(
  exec: DbExecutor,
  values: { eventId: string; basePrice: number; currency: string },
): Promise<EventPricingRow> {
  const [row] = await exec.insert(eventPricing).values(values).returning();
  return row;
}

/** Update the events row (never pricing columns) and return the updated row. */
export async function updateEventTx(
  exec: DbExecutor,
  id: string,
  data: Partial<NewEventValues>,
): Promise<EventRow> {
  const [row] = await exec
    .update(events)
    .set(data)
    .where(eq(events.id, id))
    .returning();
  return row;
}

/** Upsert pricing keyed by eventId — mirrors Prisma eventPricing.upsert. */
export async function upsertEventPricingTx(
  exec: DbExecutor,
  eventId: string,
  update: { basePrice?: number; currency?: string },
): Promise<void> {
  await exec
    .insert(eventPricing)
    .values({
      eventId,
      basePrice: update.basePrice ?? 0,
      currency: update.currency ?? "TND",
    })
    .onConflictDoUpdate({ target: eventPricing.eventId, set: update });
}

/** Event row + its registration count (delete guard). */
export async function getEventWithRegistrationCountTx(
  exec: DbExecutor,
  id: string,
): Promise<{ event: EventRow; registrations: number } | null> {
  const rows = await exec
    .select()
    .from(events)
    .where(eq(events.id, id))
    .limit(1);
  const event = rows[0];
  if (!event) return null;
  const registrationsCount = await countRegistrationsTx(exec, id);
  return { event, registrations: registrationsCount };
}

export async function getCertificateTemplateUrlsTx(
  exec: DbExecutor,
  eventId: string,
): Promise<Array<{ templateUrl: string }>> {
  return exec
    .select({ templateUrl: certificateTemplates.templateUrl })
    .from(certificateTemplates)
    .where(eq(certificateTemplates.eventId, eventId));
}

export async function getAbstractFinalFileKeysTx(
  exec: DbExecutor,
  eventId: string,
): Promise<Array<{ finalFileKey: string | null }>> {
  return exec
    .select({ finalFileKey: abstracts.finalFileKey })
    .from(abstracts)
    .where(and(eq(abstracts.eventId, eventId), isNotNull(abstracts.finalFileKey)));
}

export async function getAbstractBookStorageKeysTx(
  exec: DbExecutor,
  eventId: string,
): Promise<Array<{ storageKey: string | null }>> {
  return exec
    .select({ storageKey: abstractBookJobs.storageKey })
    .from(abstractBookJobs)
    .where(
      and(
        eq(abstractBookJobs.eventId, eventId),
        isNotNull(abstractBookJobs.storageKey),
      ),
    );
}

export async function deleteEmailTemplatesByEventTx(
  exec: DbExecutor,
  eventId: string,
): Promise<void> {
  await exec.delete(emailTemplates).where(eq(emailTemplates.eventId, eventId));
}

export async function deleteEventTx(exec: DbExecutor, id: string): Promise<void> {
  await exec.delete(events).where(eq(events.id, id));
}

/** Persist a new banner URL (banner upload happy path). */
export async function updateEventBannerUrl(
  id: string,
  bannerUrl: string,
  exec: DbExecutor = getDb(),
): Promise<void> {
  await exec.update(events).set({ bannerUrl }).where(eq(events.id, id));
}

// ---------------------------------------------------------------------------
// Capacity CAS — single-statement atomic guards (raw SQL, RETURNING).
// Callers pass the transaction executor. Returns whether a row was updated.
// ---------------------------------------------------------------------------

/**
 * Atomic capacity-safe increment. Returns true iff the guarded UPDATE affected a
 * row (event OPEN and under capacity). No row → caller diagnoses via counter info.
 */
export async function casIncrementRegisteredTx(
  exec: DbExecutor,
  id: string,
): Promise<boolean> {
  const res = await exec.execute(sql`
    UPDATE "events"
    SET registered_count = registered_count + 1
    WHERE id = ${id}
    AND status = 'OPEN'
    AND (max_capacity IS NULL OR registered_count < max_capacity)
    RETURNING id
  `);
  return rowCount(res) > 0;
}

/** Atomic decrement guarded on registered_count > 0. */
export async function casDecrementRegisteredTx(
  exec: DbExecutor,
  id: string,
): Promise<boolean> {
  const res = await exec.execute(sql`
    UPDATE "events"
    SET registered_count = registered_count - 1
    WHERE id = ${id}
    AND registered_count > 0
    RETURNING id
  `);
  return rowCount(res) > 0;
}

export type EventCounterInfo = {
  status: string;
  maxCapacity: number | null;
  registeredCount: number;
};

/** Diagnostic read used when a CAS guard affects no rows. */
export async function getEventCounterInfoTx(
  exec: DbExecutor,
  id: string,
): Promise<EventCounterInfo | null> {
  const rows = await exec
    .select({
      status: events.status,
      maxCapacity: events.maxCapacity,
      registeredCount: events.registeredCount,
    })
    .from(events)
    .where(eq(events.id, id))
    .limit(1);
  return rows[0] ?? null;
}

// pg (node-postgres) returns { rowCount, rows }. Guard defensively for other drivers.
function rowCount(res: unknown): number {
  const r = res as { rowCount?: number | null; rows?: unknown[] };
  if (typeof r?.rowCount === "number") return r.rowCount;
  return Array.isArray(r?.rows) ? r.rows.length : 0;
}

// ---------------------------------------------------------------------------
// Cross-module stopgap — createEvent's client-existence gate.
// The clients wave will export `clientExists` from @app/db; until then this
// keeps the events port self-contained. Named distinctly to avoid a barrel clash.
// ---------------------------------------------------------------------------
export async function clientExistsById(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<boolean> {
  const rows = await exec
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.id, id))
    .limit(1);
  return rows.length > 0;
}
