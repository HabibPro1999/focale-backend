import {
  and,
  count,
  desc,
  eq,
  ilike,
  isNull,
  ne,
  or,
  type InferInsertModel,
  type InferSelectModel,
  type SQL,
} from "drizzle-orm";
import type { OffsetPagination } from "@app/shared";
import { getDb, type DbExecutor } from "../client";
import { pgUniqueViolation } from "../txn";
import { emailTemplates } from "../schema/email";

export type EmailTemplateRow = InferSelectModel<typeof emailTemplates>;
export type EmailTemplateInsert = InferInsertModel<typeof emailTemplates>;

type AutomaticTrigger = NonNullable<EmailTemplateRow["trigger"]>;
type AbstractTrigger = NonNullable<EmailTemplateRow["abstractTrigger"]>;

// ---------------------------------------------------------------------------
// pg unique-violation detection. CockroachDB reports the offending index in
// error.constraint; 23505 is the SQLSTATE for unique_violation. The
// one-active-template guards match on these EXACT index names.
// ---------------------------------------------------------------------------
export const EMAIL_TEMPLATE_REGISTRATION_UNIQ = "email_template_registration_uniq";
export const EMAIL_TEMPLATE_ABSTRACT_UNIQ = "email_template_abstract_uniq";

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

export interface ListEmailTemplatesArgs extends OffsetPagination {
  category?: EmailTemplateRow["category"];
  trigger?: AutomaticTrigger;
  abstractTrigger?: AbstractTrigger;
  search?: string;
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
      .offset(args.offset)
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
    const constraint = pgUniqueViolation(err)?.constraint ?? null;
    if (
      constraint === EMAIL_TEMPLATE_REGISTRATION_UNIQ ||
      constraint === EMAIL_TEMPLATE_ABSTRACT_UNIQ
    ) {
      return { ok: false, conflictIndex: constraint };
    }
    throw err;
  }
}

/**
 * Update an email template. When `expectedUpdatedAt` is provided (M11), the
 * update is a CAS on `updatedAt` — 0 rows affected means either the id doesn't
 * exist or a concurrent edit already moved `updatedAt` (the caller has already
 * confirmed existence, so it can treat null as "stale precondition" and raise a
 * structured 409). Omitted precondition preserves the prior last-write-wins
 * behavior for backward compatibility.
 */
export async function updateEmailTemplate(
  id: string,
  patch: Partial<EmailTemplateInsert>,
  expectedUpdatedAt?: Date,
): Promise<EmailTemplateRow | null> {
  const set: Record<string, unknown> = { ...patch };
  if (Object.keys(set).length === 0) set.updatedAt = new Date();
  const conds: SQL[] = [eq(emailTemplates.id, id)];
  if (expectedUpdatedAt) {
    conds.push(eq(emailTemplates.updatedAt, expectedUpdatedAt));
  }
  const [row] = await getDb()
    .update(emailTemplates)
    .set(set)
    .where(and(...conds))
    .returning();
  return row ?? null;
}

export async function deleteEmailTemplateById(id: string): Promise<void> {
  await getDb().delete(emailTemplates).where(eq(emailTemplates.id, id));
}
