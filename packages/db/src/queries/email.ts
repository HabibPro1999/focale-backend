import {
  and,
  arrayOverlaps,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type InferInsertModel,
  type InferSelectModel,
  type SQL,
} from "drizzle-orm";
import { createLogger } from "@app/shared";
import { getDb, type DbExecutor } from "../client";
import { pgUniqueViolation } from "../txn";
import { emailLogs, emailTemplates } from "../schema/email";
import { events, eventAccess } from "../schema/events-access";
import { eventPricing } from "../schema/pricing";
import { clients } from "../schema/users-clients";
import { registrations } from "../schema/registrations";
import { sponsorshipBatches, sponsorships } from "../schema/sponsorships";
import { forms } from "../schema/forms";

export type EmailTemplateRow = InferSelectModel<typeof emailTemplates>;
export type EmailTemplateInsert = InferInsertModel<typeof emailTemplates>;
export type EmailLogRow = InferSelectModel<typeof emailLogs>;
export type EmailLogInsert = InferInsertModel<typeof emailLogs>;

type AutomaticTrigger = NonNullable<EmailTemplateRow["trigger"]>;
type AbstractTrigger = NonNullable<EmailTemplateRow["abstractTrigger"]>;
type EmailStatus = EmailLogRow["status"];

// ---------------------------------------------------------------------------
// pg unique-violation detection. CockroachDB reports the offending index in
// error.constraint; 23505 is the SQLSTATE for unique_violation. The email
// dedupe / one-active-template guards match on these EXACT index names.
// ---------------------------------------------------------------------------
export const EMAIL_TEMPLATE_REGISTRATION_UNIQ = "email_template_registration_uniq";
export const EMAIL_TEMPLATE_ABSTRACT_UNIQ = "email_template_abstract_uniq";
export const EMAIL_LOGS_REGISTRATION_TRIGGER_ACTIVE_KEY =
  "email_logs_registration_trigger_active_key";
export const EMAIL_LOGS_TEMPLATE_RECIPIENT_TRIGGER_ACTIVE_KEY =
  "email_logs_template_recipient_trigger_active_key";

function uniqueViolationConstraint(err: unknown): string | null {
  return pgUniqueViolation(err)?.constraint ?? null;
}

// ============================================================================
// EMAIL TEMPLATES — reads
// ============================================================================

export async function getEmailTemplateById(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<EmailTemplateRow | null> {
  const [row] = await exec
    .select()
    .from(emailTemplates)
    .where(eq(emailTemplates.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * The one active template that owns a trigger for an event, if any. Matches the
 * legacy `assertNoActiveTemplateForTrigger` lookup: same event, same (automatic
 * OR abstract) trigger, isActive, optionally excluding one template's own id.
 * Returns null when neither trigger is set (nothing to guard).
 */
export async function findActiveTemplateForTrigger(
  input: {
    eventId: string;
    trigger: AutomaticTrigger | null;
    abstractTrigger: AbstractTrigger | null;
    excludeId?: string;
  },
  exec: DbExecutor = getDb(),
): Promise<EmailTemplateRow | null> {
  if (!input.trigger && !input.abstractTrigger) return null;

  const filters: SQL[] = [
    eq(emailTemplates.eventId, input.eventId),
    eq(emailTemplates.isActive, true),
    input.trigger
      ? eq(emailTemplates.trigger, input.trigger)
      : eq(emailTemplates.abstractTrigger, input.abstractTrigger!),
  ];
  if (input.excludeId) {
    filters.push(ne(emailTemplates.id, input.excludeId));
  }

  const [row] = await exec
    .select()
    .from(emailTemplates)
    .where(and(...filters))
    .limit(1);
  return row ?? null;
}

/**
 * Active template for an abstract email, matching the legacy cascade:
 * event-specific (clientId + abstractTrigger + this eventId) first, then the
 * client-wide template (eventId IS NULL). null when neither exists.
 */
export async function findAbstractEmailTemplate(
  params: { clientId: string; eventId: string; abstractTrigger: AbstractTrigger },
  exec: DbExecutor = getDb(),
): Promise<EmailTemplateRow | null> {
  const [eventSpecific] = await exec
    .select()
    .from(emailTemplates)
    .where(
      and(
        eq(emailTemplates.clientId, params.clientId),
        eq(emailTemplates.abstractTrigger, params.abstractTrigger),
        eq(emailTemplates.eventId, params.eventId),
        eq(emailTemplates.isActive, true),
      ),
    )
    .limit(1);
  if (eventSpecific) return eventSpecific;

  const [clientWide] = await exec
    .select()
    .from(emailTemplates)
    .where(
      and(
        eq(emailTemplates.clientId, params.clientId),
        eq(emailTemplates.abstractTrigger, params.abstractTrigger),
        isNull(emailTemplates.eventId),
        eq(emailTemplates.isActive, true),
      ),
    )
    .limit(1);
  return clientWide ?? null;
}

/** Active AUTOMATIC template for an event+trigger (worker/automatic-send path). */
export async function getTemplateByTrigger(
  eventId: string,
  trigger: AutomaticTrigger,
  exec: DbExecutor = getDb(),
): Promise<EmailTemplateRow | null> {
  const [row] = await exec
    .select()
    .from(emailTemplates)
    .where(
      and(
        eq(emailTemplates.eventId, eventId),
        eq(emailTemplates.trigger, trigger),
        eq(emailTemplates.category, "AUTOMATIC"),
        eq(emailTemplates.isActive, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface ListEmailTemplatesArgs {
  category?: EmailTemplateRow["category"];
  trigger?: AutomaticTrigger;
  abstractTrigger?: AbstractTrigger;
  search?: string;
  skip: number;
  limit: number;
}

export async function listEmailTemplates(
  eventId: string,
  args: ListEmailTemplatesArgs,
  exec: DbExecutor = getDb(),
): Promise<{ data: EmailTemplateRow[]; total: number }> {
  const filters: SQL[] = [eq(emailTemplates.eventId, eventId)];
  if (args.category) filters.push(eq(emailTemplates.category, args.category));
  if (args.trigger) filters.push(eq(emailTemplates.trigger, args.trigger));
  if (args.abstractTrigger)
    filters.push(eq(emailTemplates.abstractTrigger, args.abstractTrigger));
  if (args.search) {
    const term = `%${args.search}%`;
    filters.push(
      or(
        ilike(emailTemplates.name, term),
        ilike(emailTemplates.subject, term),
      )!,
    );
  }
  const where = and(...filters);

  const [data, totalRows] = await Promise.all([
    exec
      .select()
      .from(emailTemplates)
      .where(where)
      .orderBy(desc(emailTemplates.createdAt))
      .offset(args.skip)
      .limit(args.limit),
    exec.select({ n: count() }).from(emailTemplates).where(where),
  ]);
  return { data, total: totalRows[0]?.n ?? 0 };
}

// ============================================================================
// EMAIL TEMPLATES — writes
// ============================================================================

/**
 * Insert a template. A concurrent losing race on the one-active-template partial
 * unique index surfaces as pg 23505 on either template index name; callers map
 * that to the generic 409. Any other unique violation is rethrown.
 */
export async function insertEmailTemplate(
  values: EmailTemplateInsert,
): Promise<
  { ok: true; template: EmailTemplateRow } | { ok: false; conflictIndex: string }
> {
  try {
    const [template] = await getDb()
      .insert(emailTemplates)
      .values(values)
      .returning();
    return { ok: true, template };
  } catch (err) {
    const constraint = uniqueViolationConstraint(err);
    if (
      constraint === EMAIL_TEMPLATE_REGISTRATION_UNIQ ||
      constraint === EMAIL_TEMPLATE_ABSTRACT_UNIQ
    ) {
      return { ok: false, conflictIndex: constraint };
    }
    throw err;
  }
}

export async function updateEmailTemplate(
  id: string,
  patch: Partial<EmailTemplateInsert>,
): Promise<EmailTemplateRow> {
  const set: Record<string, unknown> = { ...patch };
  if (Object.keys(set).length === 0) set.updatedAt = new Date();
  const [row] = await getDb()
    .update(emailTemplates)
    .set(set)
    .where(eq(emailTemplates.id, id))
    .returning();
  return row;
}

export async function deleteEmailTemplateById(id: string): Promise<void> {
  await getDb().delete(emailTemplates).where(eq(emailTemplates.id, id));
}

// ============================================================================
// EMAIL LOGS — reads
// ============================================================================

/** Projection returned by the event email-logs list route. */
export interface EventEmailLog {
  id: string;
  subject: string;
  status: string;
  trigger: string | null;
  templateName: string | null;
  recipientEmail: string;
  recipientName: string | null;
  errorMessage: string | null;
  queuedAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  bouncedAt: string | null;
  failedAt: string | null;
}

export interface ListEventEmailLogsArgs {
  status?: EmailStatus;
  trigger?: AutomaticTrigger;
  skip: number;
  limit: number;
}

/**
 * EmailLog has no direct eventId. Scope via registration.eventId OR
 * template.eventId (legacy `OR: [{registration:{eventId}}, {template:{eventId}}]`).
 */
export async function listEventEmailLogs(
  eventId: string,
  args: ListEventEmailLogsArgs,
  exec: DbExecutor = getDb(),
): Promise<{ data: EventEmailLog[]; total: number }> {
  const scope = or(
    inArray(
      emailLogs.registrationId,
      exec
        .select({ id: registrations.id })
        .from(registrations)
        .where(eq(registrations.eventId, eventId)),
    ),
    inArray(
      emailLogs.templateId,
      exec
        .select({ id: emailTemplates.id })
        .from(emailTemplates)
        .where(eq(emailTemplates.eventId, eventId)),
    ),
  )!;

  const filters: SQL[] = [scope];
  if (args.status) filters.push(eq(emailLogs.status, args.status));
  if (args.trigger) filters.push(eq(emailLogs.trigger, args.trigger));
  const where = and(...filters);

  const [rows, totalRows] = await Promise.all([
    exec
      .select({
        log: emailLogs,
        templateName: emailTemplates.name,
      })
      .from(emailLogs)
      .leftJoin(emailTemplates, eq(emailTemplates.id, emailLogs.templateId))
      .where(where)
      .orderBy(desc(emailLogs.queuedAt))
      .offset(args.skip)
      .limit(args.limit),
    exec.select({ n: count() }).from(emailLogs).where(where),
  ]);

  const data: EventEmailLog[] = rows.map(({ log, templateName }) => ({
    id: log.id,
    subject: log.subject,
    status: log.status,
    trigger: log.trigger,
    templateName: templateName ?? null,
    recipientEmail: log.recipientEmail,
    recipientName: log.recipientName,
    errorMessage: log.errorMessage,
    queuedAt: log.queuedAt.toISOString(),
    sentAt: log.sentAt?.toISOString() ?? null,
    deliveredAt: log.deliveredAt?.toISOString() ?? null,
    openedAt: log.openedAt?.toISOString() ?? null,
    clickedAt: log.clickedAt?.toISOString() ?? null,
    bouncedAt: log.bouncedAt?.toISOString() ?? null,
    failedAt: log.failedAt?.toISOString() ?? null,
  }));

  return { data, total: totalRows[0]?.n ?? 0 };
}

// ============================================================================
// EMAIL LOGS — writes
// ============================================================================

/**
 * Insert a single EmailLog. When the row would violate one of the partial
 * unique dedupe indexes (registration+trigger or template+recipient+trigger,
 * scoped to active statuses), the insert loses the race and returns the
 * offending index name instead of throwing — the automatic-send path treats
 * that as an idempotent skip. Any other unique violation is rethrown.
 */
export async function createEmailLog(
  values: EmailLogInsert,
): Promise<
  { ok: true; log: EmailLogRow } | { ok: false; conflictIndex: string }
> {
  try {
    const [log] = await getDb().insert(emailLogs).values(values).returning();
    return { ok: true, log };
  } catch (err) {
    const constraint = uniqueViolationConstraint(err);
    if (
      constraint === EMAIL_LOGS_REGISTRATION_TRIGGER_ACTIVE_KEY ||
      constraint === EMAIL_LOGS_TEMPLATE_RECIPIENT_TRIGGER_ACTIVE_KEY
    ) {
      return { ok: false, conflictIndex: constraint };
    }
    throw err;
  }
}

/** Bulk-insert QUEUED logs (manual bulk send). No dedup, no per-row validation. */
export async function createEmailLogsBulk(
  values: EmailLogInsert[],
): Promise<number> {
  if (values.length === 0) return 0;
  const rows = await getDb().insert(emailLogs).values(values).returning({
    id: emailLogs.id,
  });
  return rows.length;
}

export async function updateEmailLogById(
  id: string,
  patch: Partial<EmailLogInsert>,
): Promise<void> {
  await getDb().update(emailLogs).set(patch).where(eq(emailLogs.id, id));
}

// ============================================================================
// CROSS-DOMAIN READS (context building + bulk-send recipient resolution)
// ============================================================================

export interface RegistrationEmailContext extends InferSelectModel<
  typeof registrations
> {
  event: InferSelectModel<typeof events> & {
    client: Pick<InferSelectModel<typeof clients>, "name" | "email" | "phone">;
  };
}

/** Registration + event + event.client, for building a full send context. */
export async function getRegistrationForEmailContext(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<RegistrationEmailContext | null> {
  const rows = await exec
    .select({
      registration: registrations,
      event: events,
      client: {
        name: clients.name,
        email: clients.email,
        phone: clients.phone,
      },
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .innerJoin(clients, eq(clients.id, events.clientId))
    .where(eq(registrations.id, id))
    .limit(1);
  if (!rows[0]) return null;
  return {
    ...rows[0].registration,
    event: { ...rows[0].event, client: rows[0].client },
  };
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
): Promise<unknown | null> {
  const [row] = await exec
    .select({ schema: forms.schema })
    .from(forms)
    .where(and(eq(forms.eventId, eventId), eq(forms.type, "REGISTRATION")))
    .limit(1);
  return row?.schema ?? null;
}

// ============================================================================
// EMAIL QUEUE — lease-based worker claim + processing (SKIP LOCKED)
//
// Concurrency safety here is lease-based, NOT transaction-based: the claim uses
// FOR UPDATE SKIP LOCKED, records lockedBy/lockedUntil, and EVERY subsequent
// write re-checks that ownership. Deliberately NOT withTxnRetry/serializable —
// the legacy semantics are lease expiry + ownership, not conflict retry.
// Raw single-statement UPDATEs bump updated_at explicitly (no $onUpdate on raw
// SQL). All values are bound params or hardcoded literals.
// ============================================================================

const logger = createLogger({ name: "db:email-queue" });

const MAX_EMAIL_RETRIES = 3;
/** Default worker lease (10 min). Overridable per call. */
export const EMAIL_LEASE_MS = 10 * 60 * 1000;
const EMAIL_QUEUE_UNHEALTHY_AGE_MS = 30 * 60 * 1000;
const EMAIL_QUEUE_UNHEALTHY_SIZE = 1000;

/** Statuses that count as "an email already in flight" for dedupe purposes. */
const ACTIVE_EMAIL_STATUSES = [
  "QUEUED",
  "SENDING",
  "SENT",
  "DELIVERED",
] as const satisfies readonly EmailStatus[];

function emailRetryDelayMs(failedAttemptCount: number): number {
  if (failedAttemptCount <= 1) return 60 * 1000;
  if (failedAttemptCount === 2) return 5 * 60 * 1000;
  return 15 * 60 * 1000;
}

function nextEmailAttemptAt(failedAttemptCount: number, from = new Date()): Date {
  return new Date(from.getTime() + emailRetryDelayMs(failedAttemptCount));
}

function rowsOf<T = Record<string, unknown>>(res: unknown): T[] {
  const r = res as { rows?: unknown };
  return Array.isArray(r?.rows) ? (r.rows as T[]) : [];
}

function rowCountOf(res: unknown): number {
  const r = res as { rowCount?: number | null; rows?: unknown[] };
  if (typeof r?.rowCount === "number") return r.rowCount;
  return Array.isArray(r?.rows) ? r.rows.length : 0;
}

// ----------------------------------------------------------------------------
// Dedupe pre-checks (SELECT-then-INSERT; the partial unique indexes in
// createEmailLog are the race backstop).
// ----------------------------------------------------------------------------

/** True if an active email already exists for this registration + trigger. */
export async function hasActiveEmailLogForRegistrationTrigger(
  registrationId: string,
  trigger: AutomaticTrigger,
  exec: DbExecutor = getDb(),
): Promise<boolean> {
  const [row] = await exec
    .select({ id: emailLogs.id })
    .from(emailLogs)
    .where(
      and(
        eq(emailLogs.registrationId, registrationId),
        eq(emailLogs.trigger, trigger),
        inArray(emailLogs.status, [...ACTIVE_EMAIL_STATUSES]),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * True if an active sponsorship email already exists for this trigger+template+
 * recipient (+registration when provided). Mirrors legacy queueSponsorshipEmail.
 */
export async function hasActiveSponsorshipEmailLog(
  args: {
    trigger: AutomaticTrigger;
    templateId: string;
    recipientEmail: string;
    registrationId?: string;
  },
  exec: DbExecutor = getDb(),
): Promise<boolean> {
  const conds: SQL[] = [
    eq(emailLogs.trigger, args.trigger),
    eq(emailLogs.templateId, args.templateId),
    eq(emailLogs.recipientEmail, args.recipientEmail),
    inArray(emailLogs.status, [...ACTIVE_EMAIL_STATUSES]),
  ];
  if (args.registrationId) {
    conds.push(eq(emailLogs.registrationId, args.registrationId));
  }
  const [row] = await exec
    .select({ id: emailLogs.id })
    .from(emailLogs)
    .where(and(...conds))
    .limit(1);
  return !!row;
}

// ----------------------------------------------------------------------------
// Claim (FOR UPDATE SKIP LOCKED) + relation re-fetch
// ----------------------------------------------------------------------------

/**
 * Atomically claim up to `batchSize` due QUEUED rows: sets SENDING, records the
 * lease (lockedBy/lockedUntil), bumps attempt_count, clears error. FIFO by
 * queued_at; SKIP LOCKED so instances never grab the same rows. Returns claimed
 * ids. NOT wrapped in a transaction on purpose (lease-based, not txn-based).
 */
export async function claimQueuedEmailLogs(
  workerId: string,
  batchSize: number,
  now: Date,
  lockedUntil: Date,
): Promise<string[]> {
  const res = await getDb().execute(sql`
    UPDATE "email_logs"
    SET
      "status" = 'SENDING',
      "updated_at" = ${now},
      "locked_at" = ${now},
      "locked_until" = ${lockedUntil},
      "locked_by" = ${workerId},
      "last_attempt_at" = ${now},
      "attempt_count" = "attempt_count" + 1,
      "error_message" = NULL
    WHERE "id" IN (
      SELECT "id" FROM "email_logs"
       WHERE "status" = 'QUEUED'
         AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= ${now})
         AND "attempt_count" <= "max_retries"
       ORDER BY "queued_at" ASC
       LIMIT ${batchSize}
       FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"
  `);
  return rowsOf<{ id: string }>(res).map((r) => r.id);
}

/** A claimed EmailLog joined with the relations the send pipeline needs. */
export interface ClaimedEmailLog {
  id: string;
  trigger: AutomaticTrigger | null;
  templateId: string | null;
  registrationId: string | null;
  recipientEmail: string;
  recipientName: string | null;
  contextSnapshot: unknown;
  attemptCount: number;
  maxRetries: number;
  template: EmailTemplateRow | null;
  registration: RegistrationEmailContext | null;
}

/** Registration + event + client for a set of ids (batched context build). */
export async function getRegistrationsForEmailContextByIds(
  ids: string[],
  exec: DbExecutor = getDb(),
): Promise<RegistrationEmailContext[]> {
  if (ids.length === 0) return [];
  const rows = await exec
    .select({
      registration: registrations,
      event: events,
      client: {
        name: clients.name,
        email: clients.email,
        phone: clients.phone,
      },
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .innerJoin(clients, eq(clients.id, events.clientId))
    .where(inArray(registrations.id, ids));
  return rows.map((r) => ({
    ...r.registration,
    event: { ...r.event, client: r.client },
  }));
}

/**
 * Re-fetch claimed rows filtered again by status=SENDING + lockedBy (defends
 * against a lease stolen between the claim and this read), with template +
 * registration relations. FIFO by queued_at.
 */
export async function getClaimedEmailLogsForProcessing(
  workerId: string,
  ids: string[],
  exec: DbExecutor = getDb(),
): Promise<ClaimedEmailLog[]> {
  if (ids.length === 0) return [];
  const logs = await exec
    .select()
    .from(emailLogs)
    .where(
      and(
        inArray(emailLogs.id, ids),
        eq(emailLogs.status, "SENDING"),
        eq(emailLogs.lockedBy, workerId),
      ),
    )
    .orderBy(asc(emailLogs.queuedAt));
  if (logs.length === 0) return [];

  const templateIds = [
    ...new Set(
      logs.map((l) => l.templateId).filter((x): x is string => !!x),
    ),
  ];
  const registrationIds = [
    ...new Set(
      logs.map((l) => l.registrationId).filter((x): x is string => !!x),
    ),
  ];

  const templateRows = templateIds.length
    ? await exec
        .select()
        .from(emailTemplates)
        .where(inArray(emailTemplates.id, templateIds))
    : [];
  const templateMap = new Map(templateRows.map((t) => [t.id, t]));

  const regs = await getRegistrationsForEmailContextByIds(registrationIds, exec);
  const regMap = new Map(regs.map((r) => [r.id, r]));

  return logs.map((l) => ({
    id: l.id,
    trigger: l.trigger,
    templateId: l.templateId,
    registrationId: l.registrationId,
    recipientEmail: l.recipientEmail,
    recipientName: l.recipientName,
    contextSnapshot: l.contextSnapshot,
    attemptCount: l.attemptCount,
    maxRetries: l.maxRetries,
    template: l.templateId ? templateMap.get(l.templateId) ?? null : null,
    registration: l.registrationId ? regMap.get(l.registrationId) ?? null : null,
  }));
}

// ----------------------------------------------------------------------------
// Lease-guarded writes — each returns false (not throw) when 0 rows matched the
// ownership guard, which callers map to a non-counted "lease-lost" outcome.
// ----------------------------------------------------------------------------

/** Write the resolved subject only while this worker still holds an unexpired lease. */
export async function writeResolvedSubjectIfLeaseHeld(
  id: string,
  workerId: string,
  subject: string,
  now = new Date(),
): Promise<boolean> {
  const res = await getDb().execute(sql`
    UPDATE "email_logs"
    SET "subject" = ${subject}, "updated_at" = ${now}
    WHERE "id" = ${id} AND "status" = 'SENDING'
      AND "locked_by" = ${workerId} AND "locked_until" > ${now}
  `);
  return rowCountOf(res) > 0;
}

/** Extend the lease immediately before the provider call. */
export async function refreshEmailLease(
  id: string,
  workerId: string,
  now: Date,
  leaseMs: number,
): Promise<boolean> {
  const until = new Date(now.getTime() + leaseMs);
  const res = await getDb().execute(sql`
    UPDATE "email_logs"
    SET "locked_at" = ${now}, "locked_until" = ${until}, "updated_at" = ${now}
    WHERE "id" = ${id} AND "status" = 'SENDING'
      AND "locked_by" = ${workerId} AND "locked_until" > ${now}
  `);
  return rowCountOf(res) > 0;
}

export async function markEmailSent(
  id: string,
  workerId: string,
  messageId: string | undefined,
  now = new Date(),
): Promise<boolean> {
  const res = await getDb().execute(sql`
    UPDATE "email_logs"
    SET "status" = 'SENT', "sendgrid_message_id" = ${messageId ?? null},
        "sent_at" = ${now}, "error_message" = NULL, "next_attempt_at" = NULL,
        "locked_at" = NULL, "locked_until" = NULL, "locked_by" = NULL,
        "updated_at" = ${now}
    WHERE "id" = ${id} AND "status" = 'SENDING' AND "locked_by" = ${workerId}
  `);
  return rowCountOf(res) > 0;
}

/**
 * shouldRetry uses the PRE-failure attemptCount (already incremented at claim
 * time), i.e. "has this claim-attempt not yet exceeded max". Retry → QUEUED
 * with backoff nextAttemptAt; else → FAILED. Lease cleared either way.
 */
export async function markEmailFailed(
  id: string,
  workerId: string,
  errorMessage: string,
  attemptCount: number,
  maxRetries: number,
  now = new Date(),
): Promise<boolean> {
  const retryLimit = maxRetries ?? MAX_EMAIL_RETRIES;
  const shouldRetry = attemptCount <= retryLimit;
  const retryCountAfterFailure = Math.max(1, attemptCount);
  const nextAttemptAt = shouldRetry
    ? nextEmailAttemptAt(retryCountAfterFailure, now)
    : null;
  const res = await getDb().execute(sql`
    UPDATE "email_logs"
    SET "status" = ${shouldRetry ? "QUEUED" : "FAILED"},
        "error_message" = ${errorMessage},
        "retry_count" = "retry_count" + 1,
        "failed_at" = ${shouldRetry ? null : now},
        "next_attempt_at" = ${nextAttemptAt},
        "locked_at" = NULL, "locked_until" = NULL, "locked_by" = NULL,
        "updated_at" = ${now}
    WHERE "id" = ${id} AND "status" = 'SENDING' AND "locked_by" = ${workerId}
  `);
  return rowCountOf(res) > 0;
}

export async function markEmailSkipped(
  id: string,
  workerId: string,
  reason: string,
  now = new Date(),
): Promise<boolean> {
  const res = await getDb().execute(sql`
    UPDATE "email_logs"
    SET "status" = 'SKIPPED', "error_message" = ${reason},
        "next_attempt_at" = NULL,
        "locked_at" = NULL, "locked_until" = NULL, "locked_by" = NULL,
        "updated_at" = ${now}
    WHERE "id" = ${id} AND "status" = 'SENDING' AND "locked_by" = ${workerId}
  `);
  return rowCountOf(res) > 0;
}

// ----------------------------------------------------------------------------
// Stale lease recovery — runs at the top of every processEmailQueue call.
// ----------------------------------------------------------------------------

/**
 * Requeue (retry remains) or dead-letter (limit exhausted) SENDING rows whose
 * lease expired. Staleness: locked_until < now OR (locked_until IS NULL AND
 * COALESCE(locked_at,last_attempt_at,updated_at) < now-leaseMs). error_message
 * is COALESCE'd (only filled when currently NULL), unlike markEmailFailed.
 */
export async function recoverStaleEmailLeases(
  now = new Date(),
  leaseMs = EMAIL_LEASE_MS,
): Promise<{ requeued: number; deadLettered: number }> {
  const staleCutoff = new Date(now.getTime() - leaseMs);
  const retry1At = nextEmailAttemptAt(1, now);
  const retry2At = nextEmailAttemptAt(2, now);
  const retryLaterAt = nextEmailAttemptAt(3, now);

  const requeued = rowCountOf(
    await getDb().execute(sql`
      UPDATE "email_logs"
      SET
        "status" = 'QUEUED',
        "updated_at" = ${now},
        "locked_at" = NULL,
        "locked_until" = NULL,
        "locked_by" = NULL,
        "retry_count" = "retry_count" + 1,
        "next_attempt_at" = CASE
          WHEN "retry_count" + 1 <= 1 THEN ${retry1At}::timestamp
          WHEN "retry_count" + 1 = 2 THEN ${retry2At}::timestamp
          ELSE ${retryLaterAt}::timestamp
        END,
        "error_message" = COALESCE("error_message", 'Email send lease expired; requeued for retry')
      WHERE "status" = 'SENDING'
        AND (
          "locked_until" < ${now}
          OR (
            "locked_until" IS NULL
            AND COALESCE("locked_at", "last_attempt_at", "updated_at") < ${staleCutoff}
          )
        )
        AND "retry_count" < "max_retries"
    `),
  );

  const deadLettered = rowCountOf(
    await getDb().execute(sql`
      UPDATE "email_logs"
      SET
        "status" = 'FAILED',
        "updated_at" = ${now},
        "failed_at" = ${now},
        "locked_at" = NULL,
        "locked_until" = NULL,
        "locked_by" = NULL,
        "next_attempt_at" = NULL,
        "retry_count" = "retry_count" + 1,
        "error_message" = COALESCE("error_message", 'Email send lease expired and retry limit was exhausted')
      WHERE "status" = 'SENDING'
        AND (
          "locked_until" < ${now}
          OR (
            "locked_until" IS NULL
            AND COALESCE("locked_at", "last_attempt_at", "updated_at") < ${staleCutoff}
          )
        )
        AND "retry_count" >= "max_retries"
    `),
  );

  if (requeued > 0 || deadLettered > 0) {
    logger.warn({ requeued, deadLettered }, "Recovered stale email queue leases");
  }
  return { requeued, deadLettered };
}

// ----------------------------------------------------------------------------
// Webhook status write primitives (state machine lives in @app/integrations)
// ----------------------------------------------------------------------------

export async function readEmailLogStatus(
  id: string,
  exec: DbExecutor = getDb(),
): Promise<EmailStatus | null> {
  const [row] = await exec
    .select({ status: emailLogs.status })
    .from(emailLogs)
    .where(eq(emailLogs.id, id))
    .limit(1);
  return row?.status ?? null;
}

/**
 * Optimistic-concurrency guarded update: only writes when the row's status is
 * still `expectedStatus`. Returns false if 0 rows changed (status moved between
 * read and write) so a webhook race silently drops rather than clobbering.
 */
export async function updateEmailLogStatusGuarded(
  id: string,
  expectedStatus: EmailStatus,
  patch: Partial<EmailLogInsert>,
): Promise<boolean> {
  const res = await getDb()
    .update(emailLogs)
    .set(patch)
    .where(and(eq(emailLogs.id, id), eq(emailLogs.status, expectedStatus)))
    .returning({ id: emailLogs.id });
  return res.length > 0;
}

// ----------------------------------------------------------------------------
// Health + stats
// ----------------------------------------------------------------------------

export interface EmailQueueHealth {
  queueSize: number;
  dueQueuedCount: number;
  sendingCount: number;
  staleSendingCount: number;
  failedCount: number;
  deadLetterCount: number;
  oldestQueuedAgeMs: number;
  oldestInFlightAgeMs: number;
  recentFailures24h: number;
  isHealthy: boolean;
}

export async function getEmailQueueHealth(): Promise<EmailQueueHealth> {
  const now = new Date();
  const db = getDb();
  const countWhere = async (where: SQL): Promise<number> => {
    const [row] = await db
      .select({ n: count() })
      .from(emailLogs)
      .where(where);
    return row?.n ?? 0;
  };

  const [
    queueSize,
    dueQueuedCount,
    sendingCount,
    staleSendingCount,
    failedCount,
    recentFailures,
    oldestQueued,
    oldestInFlight,
  ] = await Promise.all([
    countWhere(eq(emailLogs.status, "QUEUED")),
    countWhere(
      and(
        eq(emailLogs.status, "QUEUED"),
        or(isNull(emailLogs.nextAttemptAt), lte(emailLogs.nextAttemptAt, now)),
      )!,
    ),
    countWhere(eq(emailLogs.status, "SENDING")),
    countWhere(
      and(
        eq(emailLogs.status, "SENDING"),
        or(isNull(emailLogs.lockedUntil), lt(emailLogs.lockedUntil, now)),
      )!,
    ),
    countWhere(eq(emailLogs.status, "FAILED")),
    countWhere(
      and(
        eq(emailLogs.status, "FAILED"),
        gte(emailLogs.updatedAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
      )!,
    ),
    // Ages computed in SQL (now() - MIN(col)) — never JS-parse a naive
    // timestamp read from the DB, which skews by the host offset on non-UTC
    // hosts. Mirrors getOutboxHealth. MIN over an empty set → NULL → 0.
    db
      .select({
        age: sql<number>`coalesce(extract(epoch from (now() - min(${emailLogs.queuedAt}))) * 1000, 0)::float8`,
      })
      .from(emailLogs)
      .where(eq(emailLogs.status, "QUEUED")),
    db
      .select({
        age: sql<number>`coalesce(extract(epoch from (now() - min(coalesce(${emailLogs.lockedAt}, ${emailLogs.updatedAt})))) * 1000, 0)::float8`,
      })
      .from(emailLogs)
      .where(eq(emailLogs.status, "SENDING")),
  ]);

  const oldestQueuedAgeMs = Math.round(Number(oldestQueued[0]?.age ?? 0));
  const oldestInFlightAgeMs = Math.round(Number(oldestInFlight[0]?.age ?? 0));

  const isHealthy =
    staleSendingCount === 0 &&
    queueSize < EMAIL_QUEUE_UNHEALTHY_SIZE &&
    oldestQueuedAgeMs < EMAIL_QUEUE_UNHEALTHY_AGE_MS;

  return {
    queueSize,
    dueQueuedCount,
    sendingCount,
    staleSendingCount,
    failedCount,
    deadLetterCount: failedCount,
    oldestQueuedAgeMs,
    oldestInFlightAgeMs,
    recentFailures24h: recentFailures,
    isHealthy,
  };
}

export async function getQueueStats(): Promise<Record<string, number>> {
  const rows = await getDb()
    .select({ status: emailLogs.status, n: count() })
    .from(emailLogs)
    .groupBy(emailLogs.status);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.n;
  return out;
}
