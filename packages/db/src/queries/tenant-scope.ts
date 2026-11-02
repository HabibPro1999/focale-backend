import { eq } from "drizzle-orm";
import { getDb, type DbExecutor } from "../client";
import { clients } from "../schema/users-clients";
import { eventAccess, events } from "../schema/events-access";
import { registrations } from "../schema/registrations";
import { sponsorships } from "../schema/sponsorships";
import { emailTemplates } from "../schema/email";
import { certificateTemplates } from "../schema/certificates";
import { forms } from "../schema/forms";

// ============================================================================
// Tenant scope reads for the API's route guards (plan 5.4). Each loads a
// resource, its event and the event's client (active flag and modules) in one
// query, so a guard can answer 404 / 403 / archived / module-disabled without
// another round trip.
// ============================================================================

type EventStatus = typeof events.$inferSelect.status;
type FormType = typeof forms.$inferSelect.type;

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

export interface AccessItemTenantScope extends EventTenantScope {
  accessItem: { id: string };
}

export interface CertificateTemplateTenantScope extends EventTenantScope {
  certificateTemplate: { id: string };
}

/** The form's type picks its module (sponsorships for SPONSOR, registrations otherwise). */
export interface FormTenantScope extends EventTenantScope {
  form: { id: string; type: FormType };
}

/** A client on its own (a route on the client itself, or naming one in its body). */
export interface ClientTenantScope {
  client: ScopedClientRow;
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

/** Event access item → event → client, by access item id. */
export async function getAccessItemTenantScope(
  accessId: string,
  db: DbExecutor = getDb(),
): Promise<AccessItemTenantScope | null> {
  const [row] = await db
    .select({ accessId: eventAccess.id, ...eventColumns, ...clientColumns })
    .from(eventAccess)
    .innerJoin(events, eq(events.id, eventAccess.eventId))
    .innerJoin(clients, eq(clients.id, events.clientId))
    .where(eq(eventAccess.id, accessId))
    .limit(1);
  return row ? { accessItem: { id: row.accessId }, ...toScope(row) } : null;
}

/** Certificate template → event → client, by template id. */
export async function getCertificateTemplateTenantScope(
  templateId: string,
  db: DbExecutor = getDb(),
): Promise<CertificateTemplateTenantScope | null> {
  const [row] = await db
    .select({ templateId: certificateTemplates.id, ...eventColumns, ...clientColumns })
    .from(certificateTemplates)
    .innerJoin(events, eq(events.id, certificateTemplates.eventId))
    .innerJoin(clients, eq(clients.id, events.clientId))
    .where(eq(certificateTemplates.id, templateId))
    .limit(1);
  return row ? { certificateTemplate: { id: row.templateId }, ...toScope(row) } : null;
}

/** Form (id and type) → event → client, by form id. */
export async function getFormTenantScope(
  formId: string,
  db: DbExecutor = getDb(),
): Promise<FormTenantScope | null> {
  const [row] = await db
    .select({ formId: forms.id, formType: forms.type, ...eventColumns, ...clientColumns })
    .from(forms)
    .innerJoin(events, eq(events.id, forms.eventId))
    .innerJoin(clients, eq(clients.id, events.clientId))
    .where(eq(forms.id, formId))
    .limit(1);
  return row ? { form: { id: row.formId, type: row.formType }, ...toScope(row) } : null;
}

/** A client's active flag and modules, by client id. */
export async function getClientTenantScope(
  clientId: string,
  db: DbExecutor = getDb(),
): Promise<ClientTenantScope | null> {
  const [row] = await db
    .select(clientColumns)
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  return row
    ? { client: { id: row.clientId, active: row.clientActive, enabledModules: row.clientEnabledModules } }
    : null;
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
