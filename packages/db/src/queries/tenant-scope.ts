import { eq } from "drizzle-orm";
import { getDb, type DbExecutor } from "../client";
import { clients } from "../schema/users-clients";
import { events } from "../schema/events-access";
import { registrations } from "../schema/registrations";
import { sponsorships } from "../schema/sponsorships";
import { emailTemplates } from "../schema/email";

// ============================================================================
// Tenant scope reads for the API's route guards (plan 5.4). Each loads a
// resource, its event and the event's client (active flag and modules) in one
// query, so a guard can answer 404 / 403 / archived / module-disabled without
// another round trip.
// ============================================================================

type EventStatus = typeof events.$inferSelect.status;

/** The event fields a route guard needs. */
export interface ScopedEventRow {
  id: string;
  clientId: string;
  status: EventStatus;
  slug: string;
}

/** The client fields a module gate needs. */
export interface ScopedClientRow {
  id: string;
  active: boolean;
  enabledModules: string[] | null;
}

export interface EventTenantScope {
  event: ScopedEventRow;
  client: ScopedClientRow;
}

export interface RegistrationTenantScope extends EventTenantScope {
  registration: { id: string };
}

export interface SponsorshipTenantScope extends EventTenantScope {
  sponsorship: { id: string };
}

/**
 * An email template may belong to a client only (no event). `event` and
 * `client` are null then; `client` is the event's client otherwise.
 */
export interface EmailTemplateTenantScope {
  template: { id: string; clientId: string; eventId: string | null };
  event: ScopedEventRow | null;
  client: ScopedClientRow | null;
}

const eventColumns = {
  eventId: events.id,
  eventClientId: events.clientId,
  eventStatus: events.status,
  eventSlug: events.slug,
};

const clientColumns = {
  clientId: clients.id,
  clientActive: clients.active,
  clientEnabledModules: clients.enabledModules,
};

type EventColumns = {
  eventId: string;
  eventClientId: string;
  eventStatus: EventStatus;
  eventSlug: string;
};
type ClientColumns = {
  clientId: string;
  clientActive: boolean;
  clientEnabledModules: string[] | null;
};

function toScope(row: EventColumns & ClientColumns): EventTenantScope {
  return {
    event: {
      id: row.eventId,
      clientId: row.eventClientId,
      status: row.eventStatus,
      slug: row.eventSlug,
    },
    client: {
      id: row.clientId,
      active: row.clientActive,
      enabledModules: row.clientEnabledModules,
    },
  };
}

/** Event → client, by event id. */
export async function getEventTenantScope(
  eventId: string,
  db: DbExecutor = getDb(),
): Promise<EventTenantScope | null> {
  const [row] = await db
    .select({ ...eventColumns, ...clientColumns })
    .from(events)
    .innerJoin(clients, eq(clients.id, events.clientId))
    .where(eq(events.id, eventId))
    .limit(1);
  return row ? toScope(row) : null;
}

/** Registration → event → client, by registration id. */
export async function getRegistrationTenantScope(
  registrationId: string,
  db: DbExecutor = getDb(),
): Promise<RegistrationTenantScope | null> {
  const [row] = await db
    .select({ registrationId: registrations.id, ...eventColumns, ...clientColumns })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .innerJoin(clients, eq(clients.id, events.clientId))
    .where(eq(registrations.id, registrationId))
    .limit(1);
  return row ? { registration: { id: row.registrationId }, ...toScope(row) } : null;
}

/** Sponsorship → event → client, by sponsorship id. */
export async function getSponsorshipTenantScope(
  sponsorshipId: string,
  db: DbExecutor = getDb(),
): Promise<SponsorshipTenantScope | null> {
  const [row] = await db
    .select({ sponsorshipId: sponsorships.id, ...eventColumns, ...clientColumns })
    .from(sponsorships)
    .innerJoin(events, eq(events.id, sponsorships.eventId))
    .innerJoin(clients, eq(clients.id, events.clientId))
    .where(eq(sponsorships.id, sponsorshipId))
    .limit(1);
  return row ? { sponsorship: { id: row.sponsorshipId }, ...toScope(row) } : null;
}

/** Email template → its event (if any) → that event's client, by template id. */
export async function getEmailTemplateTenantScope(
  templateId: string,
  db: DbExecutor = getDb(),
): Promise<EmailTemplateTenantScope | null> {
  const [row] = await db
    .select({
      templateId: emailTemplates.id,
      templateClientId: emailTemplates.clientId,
      templateEventId: emailTemplates.eventId,
      eventId: events.id,
      eventClientId: events.clientId,
      eventStatus: events.status,
      eventSlug: events.slug,
      clientId: clients.id,
      clientActive: clients.active,
      clientEnabledModules: clients.enabledModules,
    })
    .from(emailTemplates)
    .leftJoin(events, eq(events.id, emailTemplates.eventId))
    .leftJoin(clients, eq(clients.id, events.clientId))
    .where(eq(emailTemplates.id, templateId))
    .limit(1);
  if (!row) return null;
  const template = {
    id: row.templateId,
    clientId: row.templateClientId,
    eventId: row.templateEventId,
  };
  if (
    row.eventId === null ||
    row.eventClientId === null ||
    row.eventStatus === null ||
    row.eventSlug === null ||
    row.clientId === null ||
    row.clientActive === null
  ) {
    return { template, event: null, client: null };
  }
  const scope = toScope({
    eventId: row.eventId,
    eventClientId: row.eventClientId,
    eventStatus: row.eventStatus,
    eventSlug: row.eventSlug,
    clientId: row.clientId,
    clientActive: row.clientActive,
    clientEnabledModules: row.clientEnabledModules,
  });
  return { template, ...scope };
}
