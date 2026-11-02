import {
  and,
  arrayOverlaps,
  desc,
  eq,
  inArray,
  sql,
  type InferSelectModel,
  type SQL,
} from "drizzle-orm";
import {
  getPrimaryLanguage,
  type LanguageCode,
  type StoredFormSchemaJson,
} from "@app/contracts";
import { getDb, type DbExecutor } from "../client";
import { events, eventAccess } from "../schema/events-access";
import { eventPricing } from "../schema/pricing";
import { clients } from "../schema/users-clients";
import { registrations } from "../schema/registrations";
import { sponsorshipBatches, sponsorships } from "../schema/sponsorships";
import { forms } from "../schema/forms";
import { findRegistrationFormSchema } from "./forms";

// ============================================================================
// CROSS-DOMAIN READS (context building + bulk-send recipient resolution)
// ============================================================================

export interface RegistrationEmailContext extends InferSelectModel<
  typeof registrations
> {
  /** Primary language of the registration's form (fr when it sets none). */
  language: LanguageCode;
  event: InferSelectModel<typeof events> & {
    client: Pick<InferSelectModel<typeof clients>, "name" | "email" | "phone">;
  };
}

/**
 * A form's `settings.languages` (ordered, first entry = primary language), read
 * in SQL so per-registration reads don't carry the whole schema jsonb. Feed the
 * result to getPrimaryLanguage.
 */
export function formLanguagesSql() {
  return sql<unknown>`${forms.schema} -> 'settings' -> 'languages'`.mapWith(
    forms.schema,
  );
}

/** A row of selectRegistrationEmailContexts. */
interface RegistrationEmailContextRow {
  registration: InferSelectModel<typeof registrations>;
  event: InferSelectModel<typeof events>;
  client: RegistrationEmailContext["event"]["client"];
  formLanguages: unknown;
}

/**
 * Registration + event + event.client + the form's languages: the read every
 * registration email context comes from. Callers add their WHERE (and LIMIT)
 * and map the rows with toRegistrationEmailContext.
 */
export function selectRegistrationEmailContexts(exec: DbExecutor) {
  return exec
    .select({
      registration: registrations,
      event: events,
      client: {
        name: clients.name,
        email: clients.email,
        phone: clients.phone,
      },
      formLanguages: formLanguagesSql(),
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .innerJoin(clients, eq(clients.id, events.clientId))
    .leftJoin(forms, eq(forms.id, registrations.formId));
}

export function toRegistrationEmailContext(
  row: RegistrationEmailContextRow,
): RegistrationEmailContext {
  return {
    ...row.registration,
    language: getPrimaryLanguage(row.formLanguages),
    event: { ...row.event, client: row.client },
  };
}

/** Registration + event + event.client, for building a full send context. */
export async function getRegistrationForEmailContext(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<RegistrationEmailContext | null> {
  const rows = await selectRegistrationEmailContexts(exec)
    .where(eq(registrations.id, id))
    .limit(1);
  return rows[0] ? toRegistrationEmailContext(rows[0]) : null;
}

/** Registration + event + client for a set of ids (batched context build). */
export async function getRegistrationsForEmailContextByIds(
  ids: string[],
  exec: DbExecutor = getDb(),
): Promise<RegistrationEmailContext[]> {
  if (ids.length === 0) return [];
  const rows = await selectRegistrationEmailContexts(exec).where(
    inArray(registrations.id, ids),
  );
  return rows.map(toRegistrationEmailContext);
}

export interface BulkRegistrationRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

const bulkRegistrationCols = {
  id: registrations.id,
  email: registrations.email,
  firstName: registrations.firstName,
  lastName: registrations.lastName,
} as const;

/** Registrations by explicit ids, scoped to the event (cross-event ids drop). */
export async function getRegistrationsByIds(
  eventId: string,
  ids: string[],
  exec: DbExecutor = getDb(),
): Promise<BulkRegistrationRow[]> {
  if (ids.length === 0) return [];
  return exec
    .select(bulkRegistrationCols)
    .from(registrations)
    .where(
      and(inArray(registrations.id, ids), eq(registrations.eventId, eventId)),
    );
}

/** Registrations matched by optional filters (empty filters = all for event). */
export async function getRegistrationsByFilters(
  eventId: string,
  filters: {
    paymentStatus?: InferSelectModel<typeof registrations>["paymentStatus"][];
    accessTypeIds?: string[];
    role?: InferSelectModel<typeof registrations>["role"][];
  },
  exec: DbExecutor = getDb(),
): Promise<BulkRegistrationRow[]> {
  const conds: SQL[] = [eq(registrations.eventId, eventId)];
  if (filters.paymentStatus && filters.paymentStatus.length > 0) {
    conds.push(inArray(registrations.paymentStatus, filters.paymentStatus));
  }
  if (filters.accessTypeIds && filters.accessTypeIds.length > 0) {
    conds.push(arrayOverlaps(registrations.accessTypeIds, filters.accessTypeIds));
  }
  if (filters.role && filters.role.length > 0) {
    conds.push(inArray(registrations.role, filters.role));
  }
  return exec
    .select(bulkRegistrationCols)
    .from(registrations)
    .where(and(...conds));
}

export interface SponsorBatchForBulk {
  labName: string;
  contactName: string;
  email: string;
  phone: string | null;
  sponsorships: {
    beneficiaryName: string;
    beneficiaryEmail: string;
    totalAmount: number;
  }[];
}

/**
 * Sponsorship batches for an event (newest first) with their sponsorships,
 * for the sponsor-audience bulk send. Insertion order preserved so callers can
 * merge duplicate-lab-email batches into the newest one.
 */
export async function listSponsorshipBatchesForBulk(
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<SponsorBatchForBulk[]> {
  const batches = await exec
    .select({
      id: sponsorshipBatches.id,
      labName: sponsorshipBatches.labName,
      contactName: sponsorshipBatches.contactName,
      email: sponsorshipBatches.email,
      phone: sponsorshipBatches.phone,
    })
    .from(sponsorshipBatches)
    .where(eq(sponsorshipBatches.eventId, eventId))
    .orderBy(desc(sponsorshipBatches.createdAt));

  if (batches.length === 0) return [];

  const batchIds = batches.map((b) => b.id);
  const sponsees = await exec
    .select({
      batchId: sponsorships.batchId,
      beneficiaryName: sponsorships.beneficiaryName,
      beneficiaryEmail: sponsorships.beneficiaryEmail,
      totalAmount: sponsorships.totalAmount,
    })
    .from(sponsorships)
    .where(inArray(sponsorships.batchId, batchIds));

  const byBatch = new Map<string, SponsorBatchForBulk["sponsorships"]>();
  for (const s of sponsees) {
    const list = byBatch.get(s.batchId) ?? [];
    list.push({
      beneficiaryName: s.beneficiaryName,
      beneficiaryEmail: s.beneficiaryEmail,
      totalAmount: s.totalAmount,
    });
    byBatch.set(s.batchId, list);
  }

  return batches.map((b) => ({
    labName: b.labName,
    contactName: b.contactName,
    email: b.email,
    phone: b.phone,
    sponsorships: byBatch.get(b.id) ?? [],
  }));
}

export interface EventPricingEmailInfo {
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  basePrice: number;
}

export async function getEventPricingForEmail(
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<EventPricingEmailInfo | null> {
  const [row] = await exec
    .select({
      bankName: eventPricing.bankName,
      bankAccountName: eventPricing.bankAccountName,
      bankAccountNumber: eventPricing.bankAccountNumber,
      basePrice: eventPricing.basePrice,
    })
    .from(eventPricing)
    .where(eq(eventPricing.eventId, eventId))
    .limit(1);
  return row ?? null;
}

export interface EventAccessEmailInfo {
  id: string;
  name: string;
  type: InferSelectModel<typeof eventAccess>["type"];
  price: number;
}

/** EventAccess rows by id (NOT scoped to an event — matches legacy). */
export async function getEventAccessByIdsForEmail(
  ids: string[],
  exec: DbExecutor = getDb(),
): Promise<EventAccessEmailInfo[]> {
  if (ids.length === 0) return [];
  return exec
    .select({
      id: eventAccess.id,
      name: eventAccess.name,
      type: eventAccess.type,
      price: eventAccess.price,
    })
    .from(eventAccess)
    .where(inArray(eventAccess.id, ids));
}

export interface SponsorshipEmailInfo {
  code: string;
  totalAmount: number;
  coversBasePrice: boolean;
  coveredAccessIds: string[] | null;
  beneficiaryName: string;
  batch: { labName: string; contactName: string; email: string };
}

export async function getSponsorshipByCodeForEmail(
  code: string,
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<SponsorshipEmailInfo | null> {
  const [row] = await exec
    .select({
      code: sponsorships.code,
      totalAmount: sponsorships.totalAmount,
      coversBasePrice: sponsorships.coversBasePrice,
      coveredAccessIds: sponsorships.coveredAccessIds,
      beneficiaryName: sponsorships.beneficiaryName,
      labName: sponsorshipBatches.labName,
      contactName: sponsorshipBatches.contactName,
      batchEmail: sponsorshipBatches.email,
    })
    .from(sponsorships)
    .innerJoin(
      sponsorshipBatches,
      eq(sponsorshipBatches.id, sponsorships.batchId),
    )
    .where(
      and(eq(sponsorships.code, code), eq(sponsorships.eventId, eventId)),
    )
    .limit(1);
  if (!row) return null;
  return {
    code: row.code,
    totalAmount: row.totalAmount,
    coversBasePrice: row.coversBasePrice,
    coveredAccessIds: row.coveredAccessIds,
    beneficiaryName: row.beneficiaryName,
    batch: {
      labName: row.labName,
      contactName: row.contactName,
      email: row.batchEmail,
    },
  };
}

/** The REGISTRATION form's schema jsonb for an event, for variable discovery. */
export async function getRegistrationFormSchema(
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<StoredFormSchemaJson | null> {
  const form = await findRegistrationFormSchema(eventId, exec);
  return form ? form.schema : null;
}

/** Primary language of the event's REGISTRATION form (fr when it sets none). */
export async function getRegistrationFormLanguage(
  eventId: string,
  exec: DbExecutor = getDb(),
): Promise<LanguageCode> {
  const [row] = await exec
    .select({ languages: formLanguagesSql() })
    .from(forms)
    .where(and(eq(forms.eventId, eventId), eq(forms.type, "REGISTRATION")))
    .limit(1);
  return getPrimaryLanguage(row?.languages);
}
