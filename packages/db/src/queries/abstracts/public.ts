/**
 * Public (author-facing) abstracts: the reads behind the public form and
 * token links, and the submit / edit / final-file writes.
 */
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { FINAL_STATUSES } from "@app/contracts";
import { getDb, type DbExecutor } from "../../client";
import { withTxn, withSerializableTxn, pgUniqueViolation } from "../../txn";
import { insertAuditLog } from "../../outbox";
import {
  abstractConfig,
  abstractRevisions,
  abstractThemeLinks,
  abstractThemes,
  abstracts,
} from "../../schema/abstracts";
import { events } from "../../schema/events-access";
import { registrations } from "../../schema/registrations";
import { auditLogs } from "../../schema/outbox-audit";
import {
  enqueueAbstractEmailOutboxEvent,
  type AbstractConfigRow,
  type AbstractRow,
  type ThemeRef,
} from "./shared";

// 23505 unique violation on the partial index enforcing one abstract per
// first-author email per event. CockroachDB reports the constraint name in
// `error.constraint`.
function isDuplicateAuthorEmailViolation(error: unknown): boolean {
  const v = pgUniqueViolation(error);
  return (
    v !== null &&
    v.constraint.includes("abstracts_event_id_author_email_normalized_key")
  );
}

// ============================================================================
// Public reads
// ============================================================================

export interface PublicConfigData {
  eventId: string;
  eventName: string;
  clientId: string;
  config: AbstractConfigRow | null;
  themes: {
    id: string;
    label: string;
    description: string | null;
    translations: unknown;
  }[];
}

export async function findPublicConfigData(
  slug: string,
): Promise<PublicConfigData | null> {
  const [row] = await getDb()
    .select({ id: events.id, name: events.name, clientId: events.clientId })
    .from(events)
    .where(eq(events.slug, slug))
    .limit(1);
  if (!row) return null;

  const [config] = await getDb()
    .select()
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, row.id))
    .limit(1);

  const themes = config
    ? await getDb()
        .select({
          id: abstractThemes.id,
          label: abstractThemes.label,
          description: abstractThemes.description,
          translations: abstractThemes.translations,
        })
        .from(abstractThemes)
        .where(
          and(
            eq(abstractThemes.configId, config.id),
            eq(abstractThemes.active, true),
          ),
        )
        .orderBy(asc(abstractThemes.sortOrder))
    : [];

  return {
    eventId: row.id,
    eventName: row.name,
    clientId: row.clientId,
    config: config ?? null,
    themes,
  };
}

export interface EventConfigForSubmit {
  event: { id: string; name: string; slug: string; clientId: string };
  config: AbstractConfigRow | null;
}

export async function findEventConfigForSubmit(
  slug: string,
): Promise<EventConfigForSubmit | null> {
  const [row] = await getDb()
    .select({
      id: events.id,
      name: events.name,
      slug: events.slug,
      clientId: events.clientId,
    })
    .from(events)
    .where(eq(events.slug, slug))
    .limit(1);
  if (!row) return null;

  const [config] = await getDb()
    .select()
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, row.id))
    .limit(1);

  return { event: row, config: config ?? null };
}

/** IDs among `ids` that are active themes of the given config. */
export async function findActiveThemeIds(
  ids: string[],
  configId: string,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await getDb()
    .select({ id: abstractThemes.id })
    .from(abstractThemes)
    .where(
      and(
        inArray(abstractThemes.id, ids),
        eq(abstractThemes.configId, configId),
        eq(abstractThemes.active, true),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * The abstract's CURRENT linked themeIds, regardless of theme.active (M14:
 * edit-time re-validation must accept an abstract's own now-deactivated
 * theme, not just the active set findActiveThemeIds filters to).
 */
export async function findAbstractThemeIds(abstractId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ themeId: abstractThemeLinks.themeId })
    .from(abstractThemeLinks)
    .where(eq(abstractThemeLinks.abstractId, abstractId));
  return rows.map((r) => r.themeId);
}

export async function findDuplicateAuthorEmail(
  eventId: string,
  authorEmailNormalized: string,
  excludeAbstractId?: string,
): Promise<boolean> {
  const conds = [
    eq(abstracts.eventId, eventId),
    eq(abstracts.authorEmailNormalized, authorEmailNormalized),
  ];
  if (excludeAbstractId) conds.push(ne(abstracts.id, excludeAbstractId));
  const [row] = await getDb()
    .select({ id: abstracts.id })
    .from(abstracts)
    .where(and(...conds))
    .limit(1);
  return row !== undefined;
}

export interface AbstractForToken extends AbstractRow {
  themes: ThemeRef[];
  config: {
    editingEnabled: boolean;
    editingDeadline: Date | null;
    finalFileUploadEnabled: boolean;
    finalFileDeadline: Date | null;
  } | null;
}

export async function findAbstractForToken(
  id: string,
): Promise<AbstractForToken | null> {
  const [abstract] = await getDb()
    .select()
    .from(abstracts)
    .where(eq(abstracts.id, id))
    .limit(1);
  if (!abstract) return null;

  const themes = await getDb()
    .select({ id: abstractThemes.id, label: abstractThemes.label })
    .from(abstractThemeLinks)
    .innerJoin(abstractThemes, eq(abstractThemeLinks.themeId, abstractThemes.id))
    .where(eq(abstractThemeLinks.abstractId, id));

  const [config] = await getDb()
    .select({
      editingEnabled: abstractConfig.editingEnabled,
      editingDeadline: abstractConfig.editingDeadline,
      finalFileUploadEnabled: abstractConfig.finalFileUploadEnabled,
      finalFileDeadline: abstractConfig.finalFileDeadline,
    })
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, abstract.eventId))
    .limit(1);

  return { ...abstract, themes, config: config ?? null };
}

export interface AbstractForEdit extends AbstractRow {
  config: AbstractConfigRow | null;
}

export async function findAbstractForEdit(
  id: string,
): Promise<AbstractForEdit | null> {
  const [abstract] = await getDb()
    .select()
    .from(abstracts)
    .where(eq(abstracts.id, id))
    .limit(1);
  if (!abstract) return null;
  const [config] = await getDb()
    .select()
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, abstract.eventId))
    .limit(1);
  return { ...abstract, config: config ?? null };
}

export interface AbstractForFinalFile extends AbstractRow {
  config: {
    finalFileUploadEnabled: boolean;
    finalFileDeadline: Date | null;
  } | null;
}

/** `forUpdate` row-locks the abstract (inside the caller's transaction). */
export async function findAbstractForFinalFile(
  id: string,
  exec: DbExecutor = getDb(),
  opts: { forUpdate?: boolean } = {},
): Promise<AbstractForFinalFile | null> {
  const query = exec
    .select()
    .from(abstracts)
    .where(eq(abstracts.id, id))
    .limit(1);
  const [abstract] = opts.forUpdate ? await query.for("update") : await query;
  if (!abstract) return null;
  const [config] = await exec
    .select({
      finalFileUploadEnabled: abstractConfig.finalFileUploadEnabled,
      finalFileDeadline: abstractConfig.finalFileDeadline,
    })
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, abstract.eventId))
    .limit(1);
  return { ...abstract, config: config ?? null };
}

// ============================================================================
// Public writes (transactional — READ COMMITTED, no retry: matches legacy)
// ============================================================================

export interface SubmitAbstractTxnParams {
  id: string;
  eventId: string;
  editToken: string;
  authorFirstName: string;
  authorLastName: string;
  authorAffiliation: string;
  authorEmail: string;
  authorEmailNormalized: string;
  authorPhone: string;
  requestedType: AbstractRow["requestedType"];
  content: unknown;
  coAuthors: unknown;
  additionalFieldsData: unknown;
  linkBaseUrl: string;
  registrationId: string | null;
  themeIds: string[];
  revisionSnapshot: unknown;
  ip?: string;
  submissionAckDedupeKey: string;
}

export async function submitAbstractTxn(
  params: SubmitAbstractTxnParams,
): Promise<{ ok: true; createdAt: Date } | { ok: false; reason: "duplicate_email" }> {
  try {
    return await withTxn(async (tx) => {
      const [created] = await tx
        .insert(abstracts)
        .values({
          id: params.id,
          eventId: params.eventId,
          authorFirstName: params.authorFirstName,
          authorLastName: params.authorLastName,
          authorAffiliation: params.authorAffiliation,
          authorEmail: params.authorEmail,
          authorEmailNormalized: params.authorEmailNormalized,
          authorPhone: params.authorPhone,
          requestedType: params.requestedType,
          content: params.content,
          coAuthors: params.coAuthors,
          additionalFieldsData: params.additionalFieldsData,
          status: "SUBMITTED",
          editToken: params.editToken,
          linkBaseUrl: params.linkBaseUrl,
          registrationId: params.registrationId,
        })
        .returning({ createdAt: abstracts.createdAt });

      await tx.insert(abstractRevisions).values({
        abstractId: params.id,
        revisionNo: 1,
        snapshot: params.revisionSnapshot,
        editedBy: "PUBLIC",
        editedIpAddress: params.ip,
        content: params.content,
        coAuthors: params.coAuthors,
        additionalFieldsData: params.additionalFieldsData,
      });

      if (params.themeIds.length > 0) {
        await tx.insert(abstractThemeLinks).values(
          params.themeIds.map((themeId) => ({
            abstractId: params.id,
            themeId,
          })),
        );
      }

      await insertAuditLog(
        {
          entityType: "Abstract",
          entityId: params.id,
          action: "submit",
          performedBy: "PUBLIC",
          ipAddress: params.ip ?? null,
        },
        tx,
      );

      await enqueueAbstractEmailOutboxEvent(
        tx,
        { trigger: "ABSTRACT_SUBMISSION_ACK", abstractId: params.id },
        params.submissionAckDedupeKey,
      );

      return { ok: true as const, createdAt: created.createdAt };
    });
  } catch (error) {
    if (isDuplicateAuthorEmailViolation(error)) {
      return { ok: false, reason: "duplicate_email" };
    }
    throw error;
  }
}

export interface EditAbstractTxnParams {
  id: string;
  authorFirstName: string;
  authorLastName: string;
  authorAffiliation: string;
  authorEmail: string;
  authorEmailNormalized: string;
  authorPhone: string;
  requestedType: AbstractRow["requestedType"];
  content: unknown;
  coAuthors: unknown;
  additionalFieldsData: unknown;
  registrationId: string | null;
  themeIds: string[];
  revisionSnapshot: unknown;
  lastEditedAt: Date;
  ip?: string;
}

export type EditAbstractResult =
  | { ok: true }
  | { ok: false; reason: "duplicate_email" | "not_editable" };

export async function editAbstractTxn(
  params: EditAbstractTxnParams,
): Promise<EditAbstractResult> {
  try {
    // Serializable + retry: revisionNo is read-max-then-insert, which races
    // under plain READ COMMITTED on abstract_revisions_abstract_id_revision_no_key
    // for concurrent edits of the same abstract (M3).
    return await withSerializableTxn(async (tx): Promise<EditAbstractResult> => {
      const [last] = await tx
        .select({ revisionNo: abstractRevisions.revisionNo })
        .from(abstractRevisions)
        .where(eq(abstractRevisions.abstractId, params.id))
        .orderBy(desc(abstractRevisions.revisionNo))
        .limit(1);
      const nextRevisionNo = (last?.revisionNo ?? 0) + 1;

      // Final-status guard (ADR 0001 rule 5): the caller's status check ran
      // before this transaction, so a decision committed since then must stop
      // the edit here. Nothing is written when no row matches.
      const [edited] = await tx
        .update(abstracts)
        .set({
          authorFirstName: params.authorFirstName,
          authorLastName: params.authorLastName,
          authorAffiliation: params.authorAffiliation,
          authorEmail: params.authorEmail,
          authorEmailNormalized: params.authorEmailNormalized,
          authorPhone: params.authorPhone,
          requestedType: params.requestedType,
          content: params.content,
          coAuthors: params.coAuthors,
          additionalFieldsData: params.additionalFieldsData,
          registrationId: params.registrationId,
          lastEditedAt: params.lastEditedAt,
          contentVersion: sql`${abstracts.contentVersion} + 1`,
        })
        .where(
          and(
            eq(abstracts.id, params.id),
            notInArray(abstracts.status, FINAL_STATUSES),
          ),
        )
        .returning({ id: abstracts.id });
      if (!edited) {
        return { ok: false, reason: "not_editable" };
      }

      await tx.insert(abstractRevisions).values({
        abstractId: params.id,
        revisionNo: nextRevisionNo,
        snapshot: params.revisionSnapshot,
        editedBy: "PUBLIC",
        editedIpAddress: params.ip,
        content: params.content,
        coAuthors: params.coAuthors,
        additionalFieldsData: params.additionalFieldsData,
      });

      await tx
        .delete(abstractThemeLinks)
        .where(eq(abstractThemeLinks.abstractId, params.id));
      if (params.themeIds.length > 0) {
        await tx.insert(abstractThemeLinks).values(
          params.themeIds.map((themeId) => ({
            abstractId: params.id,
            themeId,
          })),
        );
      }

      await insertAuditLog(
        {
          entityType: "Abstract",
          entityId: params.id,
          action: "edit",
          performedBy: "PUBLIC",
          ipAddress: params.ip ?? null,
        },
        tx,
      );

      await enqueueAbstractEmailOutboxEvent(
        tx,
        { trigger: "ABSTRACT_EDIT_ACK", abstractId: params.id },
        `email:abstract:ABSTRACT_EDIT_ACK:${params.id}:${nextRevisionNo}`,
      );

      return { ok: true };
    });
  } catch (error) {
    if (isDuplicateAuthorEmailViolation(error)) {
      return { ok: false, reason: "duplicate_email" };
    }
    throw error;
  }
}

export interface FinalFileUpdate {
  finalFileKey: string;
  finalFileKind: AbstractRow["finalFileKind"];
  finalFileSize: number;
  finalFileUploadedAt: Date;
}

/**
 * Replace an abstract's final file under a row lock. `prepare` re-validates the
 * locked row (throw to abort; nothing is written) and returns the fields and
 * audit row to persist. Resolves with the key the row held before, so the
 * caller can delete that object once this has committed.
 */
export async function updateAbstractFinalFileTxn(
  abstractId: string,
  prepare: (current: AbstractForFinalFile | null) => {
    fields: FinalFileUpdate;
    audit: typeof auditLogs.$inferInsert;
  },
): Promise<{ previousKey: string | null }> {
  return withTxn(async (tx) => {
    const current = await findAbstractForFinalFile(abstractId, tx, {
      forUpdate: true,
    });
    const { fields, audit } = prepare(current);
    await tx
      .update(abstracts)
      .set(fields)
      .where(eq(abstracts.id, abstractId));
    await insertAuditLog(audit, tx);
    return { previousKey: current?.finalFileKey ?? null };
  });
}

// ============================================================================
// registrationId validation (M4)
// ============================================================================

/** The eventId a registration belongs to, or null if it doesn't exist. */
export async function findRegistrationEventId(
  registrationId: string,
): Promise<string | null> {
  const [row] = await getDb()
    .select({ eventId: registrations.eventId })
    .from(registrations)
    .where(eq(registrations.id, registrationId))
    .limit(1);
  return row?.eventId ?? null;
}
