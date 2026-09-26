/**
 * Abstract email reads: the SKIPPED-row ops query behind
 * requeue-skipped-abstract-emails, and the context the worker's email.abstract
 * handler renders from.
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "../../client";
import { abstractConfig, abstracts } from "../../schema/abstracts";
import { events } from "../../schema/events-access";
import { emailLogs } from "../../schema/email";
import { abstractEmailTrigger } from "../../schema/enums";
import type { AbstractRow } from "./shared";

// ============================================================================
// Skipped abstract emails (ops)
// ============================================================================

export type AbstractEmailTrigger =
  (typeof abstractEmailTrigger.enumValues)[number];

export interface SkippedAbstractEmailRow {
  id: string;
  abstractId: string;
  abstractTrigger: AbstractEmailTrigger;
  recipientEmail: string;
  recipientName: string | null;
  errorMessage: string | null;
  queuedAt: Date;
}

/**
 * Ops query for `requeue-skipped-abstract-emails`: SKIPPED abstract-email rows
 * (abstractId + abstractTrigger non-null), newest first, optionally filtered by
 * event / abstract / trigger. Legacy parity: emailLog.findMany equivalent.
 */
export async function findSkippedAbstractEmails(filter: {
  eventId?: string;
  abstractId?: string;
  trigger?: AbstractEmailTrigger;
  limit: number;
}): Promise<SkippedAbstractEmailRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: emailLogs.id,
      abstractId: emailLogs.abstractId,
      abstractTrigger: emailLogs.abstractTrigger,
      recipientEmail: emailLogs.recipientEmail,
      recipientName: emailLogs.recipientName,
      errorMessage: emailLogs.errorMessage,
      queuedAt: emailLogs.queuedAt,
    })
    .from(emailLogs)
    .where(
      and(
        eq(emailLogs.status, "SKIPPED"),
        isNotNull(emailLogs.abstractId),
        isNotNull(emailLogs.abstractTrigger),
        filter.abstractId
          ? eq(emailLogs.abstractId, filter.abstractId)
          : undefined,
        filter.trigger
          ? eq(emailLogs.abstractTrigger, filter.trigger)
          : undefined,
        filter.eventId
          ? inArray(
              emailLogs.abstractId,
              db
                .select({ id: abstracts.id })
                .from(abstracts)
                .where(eq(abstracts.eventId, filter.eventId)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(emailLogs.queuedAt))
    .limit(filter.limit);

  return rows.flatMap((row): SkippedAbstractEmailRow[] =>
    row.abstractId && row.abstractTrigger
      ? [
          {
            id: row.id,
            abstractId: row.abstractId,
            abstractTrigger: row.abstractTrigger,
            recipientEmail: row.recipientEmail,
            recipientName: row.recipientName,
            errorMessage: row.errorMessage,
            queuedAt: row.queuedAt,
          },
        ]
      : [],
  );
}

// ----------------------------------------------------------------------------
// Abstract email context (worker email.abstract handler → queueAbstractEmail).
// Ports the legacy prisma fetch: abstract + its event (name/slug/clientId) +
// the abstract config deadline fields. Config may be absent (dates default to
// null / finalFileUploadEnabled false), matching legacy `config?.x ?? …`.
// ----------------------------------------------------------------------------

export interface AbstractForEmailContext {
  id: string;
  authorFirstName: string;
  authorLastName: string;
  authorEmail: string;
  content: AbstractRow["content"];
  status: string;
  requestedType: string;
  finalType: string | null;
  code: string | null;
  editToken: string;
  linkBaseUrl: string | null;
  eventId: string;
  event: { name: string; slug: string; clientId: string };
  config: {
    submissionStartAt: Date | null;
    submissionDeadline: Date | null;
    editingDeadline: Date | null;
    scoringStartAt: Date | null;
    scoringDeadline: Date | null;
    finalFileDeadline: Date | null;
    finalFileUploadEnabled: boolean;
  };
}

export async function getAbstractForEmailContext(
  abstractId: string,
): Promise<AbstractForEmailContext | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: abstracts.id,
      authorFirstName: abstracts.authorFirstName,
      authorLastName: abstracts.authorLastName,
      authorEmail: abstracts.authorEmail,
      content: abstracts.content,
      status: abstracts.status,
      requestedType: abstracts.requestedType,
      finalType: abstracts.finalType,
      code: abstracts.code,
      editToken: abstracts.editToken,
      linkBaseUrl: abstracts.linkBaseUrl,
      eventId: abstracts.eventId,
      eventName: events.name,
      eventSlug: events.slug,
      eventClientId: events.clientId,
    })
    .from(abstracts)
    .innerJoin(events, eq(abstracts.eventId, events.id))
    .where(eq(abstracts.id, abstractId))
    .limit(1);
  if (!row) return null;

  const [cfg] = await db
    .select({
      submissionStartAt: abstractConfig.submissionStartAt,
      submissionDeadline: abstractConfig.submissionDeadline,
      editingDeadline: abstractConfig.editingDeadline,
      scoringStartAt: abstractConfig.scoringStartAt,
      scoringDeadline: abstractConfig.scoringDeadline,
      finalFileDeadline: abstractConfig.finalFileDeadline,
      finalFileUploadEnabled: abstractConfig.finalFileUploadEnabled,
    })
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, row.eventId))
    .limit(1);

  return {
    id: row.id,
    authorFirstName: row.authorFirstName,
    authorLastName: row.authorLastName,
    authorEmail: row.authorEmail,
    content: row.content,
    status: row.status,
    requestedType: row.requestedType,
    finalType: row.finalType,
    code: row.code,
    editToken: row.editToken,
    linkBaseUrl: row.linkBaseUrl,
    eventId: row.eventId,
    event: { name: row.eventName, slug: row.eventSlug, clientId: row.eventClientId },
    config: {
      submissionStartAt: cfg?.submissionStartAt ?? null,
      submissionDeadline: cfg?.submissionDeadline ?? null,
      editingDeadline: cfg?.editingDeadline ?? null,
      scoringStartAt: cfg?.scoringStartAt ?? null,
      scoringDeadline: cfg?.scoringDeadline ?? null,
      finalFileDeadline: cfg?.finalFileDeadline ?? null,
      finalFileUploadEnabled: cfg?.finalFileUploadEnabled ?? false,
    },
  };
}
