import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  notExists,
  or,
  sql,
  type InferInsertModel,
  type InferSelectModel,
  type SQL,
} from "drizzle-orm";
import { newId, type OffsetPagination } from "@app/shared";
import { getDb, type DbExecutor } from "../client";
import { rowsOf } from "../helpers";
import { pgUniqueViolation } from "../txn";
import { emailLogs, emailTemplates } from "../schema/email";
import { events } from "../schema/events-access";
import { registrations } from "../schema/registrations";
import { abstracts } from "../schema/abstracts";
import type { EmailTemplateRow } from "./email-templates";

export type EmailLogRow = InferSelectModel<typeof emailLogs>;
export type EmailLogInsert = InferInsertModel<typeof emailLogs>;

type AutomaticTrigger = NonNullable<EmailTemplateRow["trigger"]>;
type EmailStatus = EmailLogRow["status"];

// ---------------------------------------------------------------------------
// pg unique-violation detection. CockroachDB reports the offending index in
// error.constraint; 23505 is the SQLSTATE for unique_violation. The email
// dedupe guards match on these EXACT index names.
// ---------------------------------------------------------------------------
export const EMAIL_LOGS_REGISTRATION_TRIGGER_ACTIVE_KEY =
  "email_logs_registration_trigger_active_key";
export const EMAIL_LOGS_TEMPLATE_RECIPIENT_TRIGGER_ACTIVE_KEY =
  "email_logs_template_recipient_trigger_active_key";
/**
 * H6: per-outbox-delivery idempotency (packages/db/migrations/0003_email_fixes.sql).
 * Conflicting on this index means "this exact delivery already produced a row" —
 * callers should treat it as an idempotent success, not a dedupe-skip.
 */
export const EMAIL_LOGS_DEDUPE_KEY_ACTIVE_KEY = "email_logs_dedupe_key_active_key";

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

export interface ListEventEmailLogsArgs extends OffsetPagination {
  status?: EmailStatus;
  trigger?: AutomaticTrigger;
  /** Defaults to EMAIL_LOG_LIST_COUNT_CAP. */
  countCap?: number;
}

/** The event email-log list counts at most this many rows (then `totalCapped`). */
export const EMAIL_LOG_LIST_COUNT_CAP = 10_000;

/**
 * EmailLog has no direct eventId: an event's emails are those of its
 * registrations plus those of its templates (legacy `OR: [{registration:
 * {eventId}}, {template:{eventId}}]`). 3.6b: instead of one OR scan, two
 * index-backed branches, disjoint so they add up with UNION ALL:
 * - by registration: the event's registrations → email_logs_registration_id_idx;
 * - by template, minus rows of the event's registrations → (template_id,
 *   queued_at) (0029).
 * Each branch takes its own first `offset + limit` rows (queued_at, id
 * descending), so the page is exact; the rows are loaded for that page only.
 * The count stops at the cap (`totalCapped`): each branch counts at most
 * cap + 1 rows.
 */
export async function listEventEmailLogs(
  eventId: string,
  args: ListEventEmailLogsArgs,
  exec: DbExecutor = getDb(),
): Promise<{ data: EventEmailLog[]; total: number; totalCapped: boolean }> {
  const filters: SQL[] = [];
  if (args.status) filters.push(eq(emailLogs.status, args.status));
  if (args.trigger) filters.push(eq(emailLogs.trigger, args.trigger));

  const eventRegistrationIds = exec
    .select({ id: registrations.id })
    .from(registrations)
    .where(eq(registrations.eventId, eventId));
  const eventTemplateIds = exec
    .select({ id: emailTemplates.id })
    .from(emailTemplates)
    .where(eq(emailTemplates.eventId, eventId));
  const byRegistration = and(
    inArray(emailLogs.registrationId, eventRegistrationIds),
    ...filters,
  )!;
  const byTemplate = and(
    inArray(emailLogs.templateId, eventTemplateIds),
    or(
      isNull(emailLogs.registrationId),
      notExists(
        exec
          .select({ one: sql`1` })
          .from(registrations)
          .where(
            and(
              eq(registrations.id, emailLogs.registrationId),
              eq(registrations.eventId, eventId),
            ),
          ),
      ),
    ),
    ...filters,
  )!;

  const countCap = args.countCap ?? EMAIL_LOG_LIST_COUNT_CAP;
  const window = args.offset + args.limit;
  const firstRows = (where: SQL) =>
    exec
      .select({ id: emailLogs.id, queuedAt: emailLogs.queuedAt })
      .from(emailLogs)
      .where(where)
      .orderBy(desc(emailLogs.queuedAt), desc(emailLogs.id))
      .limit(window);
  const counted = (where: SQL) =>
    exec
      .select({ id: emailLogs.id })
      .from(emailLogs)
      .where(where)
      .limit(countCap + 1);

  const [page, countRes] = await Promise.all([
    firstRows(byRegistration)
      .unionAll(firstRows(byTemplate))
      .orderBy(sql.raw(`"queued_at" DESC, "id" DESC`))
      .limit(args.limit)
      .offset(args.offset),
    exec.execute(sql`
      SELECT count(*) AS "n"
      FROM ${counted(byRegistration).unionAll(counted(byTemplate))} AS "capped"
    `),
  ]);
  const counts = Number(rowsOf<{ n: number | string }>(countRes)[0]?.n ?? 0);

  const ids = page.map((row) => row.id);
  const rows =
    ids.length === 0
      ? []
      : await exec
          .select({ log: emailLogs, templateName: emailTemplates.name })
          .from(emailLogs)
          .leftJoin(emailTemplates, eq(emailTemplates.id, emailLogs.templateId))
          .where(inArray(emailLogs.id, ids));
  const byId = new Map(rows.map((row) => [row.log.id, row]));

  const data: EventEmailLog[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    // Deleted between the two reads (a retention purge): skip it.
    if (!row) continue;
    const { log, templateName } = row;
    data.push({
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
    });
  }

  return {
    data,
    total: Math.min(counts, countCap),
    totalCapped: counts > countCap,
  };
}

// ============================================================================
// EMAIL LOGS — writes
// ============================================================================

/**
 * The values of a new QUEUED email_logs row: its subject is resolved when it
 * is sent. The caller's fields are kept as given (an omitted one takes the
 * column default); the insert, and any realtime event, stay with the caller.
 */
export function queuedEmailLogValues<
  T extends Omit<EmailLogInsert, "subject" | "status">,
>(values: T): T & Pick<EmailLogInsert, "subject" | "status"> {
  return { ...values, subject: "", status: "QUEUED" };
}

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
    const constraint = pgUniqueViolation(err)?.constraint ?? null;
    if (
      constraint === EMAIL_LOGS_REGISTRATION_TRIGGER_ACTIVE_KEY ||
      constraint === EMAIL_LOGS_TEMPLATE_RECIPIENT_TRIGGER_ACTIVE_KEY ||
      constraint === EMAIL_LOGS_DEDUPE_KEY_ACTIVE_KEY
    ) {
      return { ok: false, conflictIndex: constraint };
    }
    throw err;
  }
}

/** Rows per INSERT statement in insertEmailLogsSkippingConflicts. */
export const EMAIL_LOG_INSERT_CHUNK_SIZE = 500;

/**
 * Bulk-insert email logs (manual bulk sends, certificate sends). A row that any
 * unique index refuses is skipped instead of failing the batch: the insert is
 * `ON CONFLICT DO NOTHING` without a target on purpose, because the row may
 * collide with any of the active dedupe indexes (per-trigger, template +
 * recipient, dedupe key). Every row gets its id here, so the caller can tell
 * inserted rows from skipped ones by the returned ids.
 *
 * Run it inside a transaction (`withTxn`) for an all-or-nothing batch apart
 * from the skipped rows: the chunks are separate statements.
 */
export async function insertEmailLogsSkippingConflicts(
  values: EmailLogInsert[],
  exec: DbExecutor,
): Promise<Set<string>> {
  if (values.length === 0) return new Set();
  const rows = values.map((value) => ({ ...value, id: value.id ?? newId() }));
  const inserted = new Set<string>();
  for (let i = 0; i < rows.length; i += EMAIL_LOG_INSERT_CHUNK_SIZE) {
    const returned = await exec
      .insert(emailLogs)
      .values(rows.slice(i, i + EMAIL_LOG_INSERT_CHUNK_SIZE))
      .onConflictDoNothing()
      .returning({ id: emailLogs.id });
    for (const row of returned) inserted.add(row.id);
  }
  return inserted;
}

export async function updateEmailLogById(
  id: string,
  patch: Partial<EmailLogInsert>,
): Promise<void> {
  await getDb().update(emailLogs).set(patch).where(eq(emailLogs.id, id));
}

/** Resolved realtime fan-out target for an EmailLog (N3). */
export interface EmailLogRealtimeTarget {
  clientId: string;
  eventId: string;
  registrationId: string | null;
}

/**
 * Resolve the (clientId, eventId, registrationId) a given EmailLog's realtime
 * `emailLog.statusChanged` event should carry, mirroring the legacy
 * `emitEmailLogChanged` — extended (per N3) to abstract-linked rows: via the
 * registration relation when registrationId is set, via the abstract → event
 * relation when abstractId is set. Returns null when the log (or its relation)
 * no longer exists, or when it is linked to neither (nothing to resolve).
 */
export async function getEmailLogRealtimeTarget(
  emailLogId: string,
  exec: DbExecutor = getDb(),
): Promise<EmailLogRealtimeTarget | null> {
  const [log] = await exec
    .select({
      registrationId: emailLogs.registrationId,
      abstractId: emailLogs.abstractId,
    })
    .from(emailLogs)
    .where(eq(emailLogs.id, emailLogId))
    .limit(1);
  if (!log) return null;

  if (log.registrationId) {
    const [row] = await exec
      .select({ clientId: events.clientId, eventId: events.id })
      .from(registrations)
      .innerJoin(events, eq(events.id, registrations.eventId))
      .where(eq(registrations.id, log.registrationId))
      .limit(1);
    if (!row) return null;
    return {
      clientId: row.clientId,
      eventId: row.eventId,
      registrationId: log.registrationId,
    };
  }

  if (log.abstractId) {
    const [row] = await exec
      .select({ clientId: events.clientId, eventId: events.id })
      .from(abstracts)
      .innerJoin(events, eq(events.id, abstracts.eventId))
      .where(eq(abstracts.id, log.abstractId))
      .limit(1);
    if (!row) return null;
    return { clientId: row.clientId, eventId: row.eventId, registrationId: null };
  }

  return null;
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
