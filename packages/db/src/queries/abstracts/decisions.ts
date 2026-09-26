/** Admin decisions on an abstract: finalize, reopen and mark presented. */
import {
  and,
  asc,
  count,
  eq,
  isNotNull,
  max,
  notInArray,
  sql,
} from "drizzle-orm";
import {
  FINAL_STATUSES,
  CODE_SUFFIX,
  type AbstractFinalType,
} from "@app/contracts";
import { selectDecisionEmails } from "@app/shared";
import { getDb, type DbExecutor } from "../../client";
import { withTxn, withLockingTxn, pgUniqueViolation } from "../../txn";
import { lockAbstractForUpdate } from "../../locks";
import { enqueueRealtimeOutboxEvent, insertAuditLog } from "../../outbox";
import {
  abstractCodeCounters,
  abstractConfig,
  abstractReviews,
  abstractThemeLinks,
  abstractThemes,
  abstracts,
} from "../../schema/abstracts";
import { events } from "../../schema/events-access";
import { users } from "../../schema/users-clients";
import { enqueueAbstractEmailOutboxEvent, type AbstractRow } from "./shared";

// 23505 unique violation on (eventId, code) — two themes sharing a sortOrder
// can allocate the identical code string (H5); catching it here turns an
// opaque 500 into a typed, retryable-by-the-admin failure reason.
function isDuplicateCodeViolation(error: unknown): boolean {
  const v = pgUniqueViolation(error);
  return v !== null && v.constraint.includes("abstracts_event_id_code_key");
}

// ============================================================================
// Admin decisions — finalize / reopen / presented
// ============================================================================

async function allocateAbstractCode(
  tx: DbExecutor,
  eventId: string,
  finalType: AbstractFinalType,
  theme: { id: string; sortOrder: number },
): Promise<{ code: string; codeNumber: number }> {
  const [seedAbs] = await tx
    .select({ m: max(abstracts.codeNumber) })
    .from(abstracts)
    .innerJoin(abstractThemeLinks, eq(abstractThemeLinks.abstractId, abstracts.id))
    .where(
      and(
        eq(abstracts.eventId, eventId),
        eq(abstracts.finalType, finalType),
        isNotNull(abstracts.codeNumber),
        eq(abstractThemeLinks.themeId, theme.id),
      ),
    );
  const [seedCounter] = await tx
    .select({ lastValue: abstractCodeCounters.lastValue })
    .from(abstractCodeCounters)
    .where(
      and(
        eq(abstractCodeCounters.eventId, eventId),
        eq(abstractCodeCounters.themeId, theme.id),
        eq(abstractCodeCounters.finalType, finalType),
      ),
    )
    .limit(1);
  const seedValue = Math.max(seedAbs?.m ?? 0, seedCounter?.lastValue ?? 0);

  const [counter] = await tx
    .insert(abstractCodeCounters)
    .values({ eventId, themeId: theme.id, finalType, lastValue: seedValue + 1 })
    .onConflictDoUpdate({
      target: [
        abstractCodeCounters.eventId,
        abstractCodeCounters.themeId,
        abstractCodeCounters.finalType,
      ],
      set: { lastValue: sql`${abstractCodeCounters.lastValue} + 1` },
    })
    .returning({ lastValue: abstractCodeCounters.lastValue });

  const codeNumber = counter.lastValue;
  const code = `${CODE_SUFFIX[finalType]}${theme.sortOrder}-${String(codeNumber).padStart(2, "0")}`;
  return { code, codeNumber };
}

export type FinalizeResult =
  | {
      ok: false;
      reason:
        | "not_found"
        | "already_finalized"
        | "missing_final_type"
        | "no_theme"
        | "code_conflict";
    }
  | { ok: true };

export async function finalizeAbstractTxn(params: {
  eventId: string;
  abstractId: string;
  decision: AbstractRow["status"];
  finalType: AbstractFinalType | undefined;
  performedBy: string;
}): Promise<FinalizeResult> {
  const { eventId, abstractId, decision, finalType, performedBy } = params;
  try {
    // Lock first, then re-read (ADR 0001): a review or assignment in flight
    // commits before this reads the reviews and decides, and any that start
    // later see the final status after their own lock.
    return await withLockingTxn(async (tx): Promise<FinalizeResult> => {
      if (!(await lockAbstractForUpdate(tx, abstractId))) {
        return { ok: false, reason: "not_found" };
      }
      const [existing] = await tx
        .select()
        .from(abstracts)
        .where(eq(abstracts.id, abstractId))
        .limit(1);
      if (!existing || existing.eventId !== eventId) {
        return { ok: false, reason: "not_found" };
      }
      if (FINAL_STATUSES.includes(existing.status)) {
        return { ok: false, reason: "already_finalized" };
      }
      if (decision === "ACCEPTED" && !finalType) {
        return { ok: false, reason: "missing_final_type" };
      }

      const [ev] = await tx
        .select({ clientId: events.clientId })
        .from(events)
        .where(eq(events.id, eventId))
        .limit(1);
      const [cfg] = await tx
        .select({
          commentsEnabled: abstractConfig.commentsEnabled,
          commentsSentToAuthor: abstractConfig.commentsSentToAuthor,
          finalFileUploadEnabled: abstractConfig.finalFileUploadEnabled,
        })
        .from(abstractConfig)
        .where(eq(abstractConfig.eventId, eventId))
        .limit(1);
      const reviews = await tx
        .select({ comment: abstractReviews.comment, name: users.name })
        .from(abstractReviews)
        .innerJoin(users, eq(abstractReviews.reviewerId, users.id))
        .where(
          and(
            eq(abstractReviews.abstractId, abstractId),
            eq(abstractReviews.active, true),
          ),
        )
        .orderBy(asc(abstractReviews.createdAt));
      const themes = await tx
        .select({ id: abstractThemes.id, sortOrder: abstractThemes.sortOrder })
        .from(abstractThemeLinks)
        .innerJoin(abstractThemes, eq(abstractThemeLinks.themeId, abstractThemes.id))
        .where(eq(abstractThemeLinks.abstractId, abstractId))
        .orderBy(asc(abstractThemes.sortOrder));

      const nextData: {
        status: AbstractRow["status"];
        finalType: AbstractFinalType | null;
        code?: string | null;
        codeNumber?: number | null;
      } = {
        status: decision,
        finalType: decision === "ACCEPTED" ? (finalType as AbstractFinalType) : null,
      };

      let allocatedCode: { code: string; codeNumber: number } | null = null;
      if (decision === "ACCEPTED") {
        const codeTheme = themes[0];
        if (!codeTheme) {
          return { ok: false, reason: "no_theme" };
        }
        if (existing.codeNumber != null) {
          const code = `${CODE_SUFFIX[finalType as AbstractFinalType]}${codeTheme.sortOrder}-${String(existing.codeNumber).padStart(2, "0")}`;
          allocatedCode = { code, codeNumber: existing.codeNumber };
        } else {
          allocatedCode = await allocateAbstractCode(
            tx,
            eventId,
            finalType as AbstractFinalType,
            codeTheme,
          );
        }
        nextData.code = allocatedCode.code;
        nextData.codeNumber = allocatedCode.codeNumber;
      } else {
        nextData.code = null;
        nextData.codeNumber = null;
      }

      // Final-status guard (ADR 0001 rule 5); the row lock already rules out
      // another finalize in between, so 0 rows means it was final before.
      const [updated] = await tx
        .update(abstracts)
        .set(nextData)
        .where(
          and(
            eq(abstracts.id, abstractId),
            notInArray(abstracts.status, FINAL_STATUSES),
          ),
        )
        .returning({
          id: abstracts.id,
          status: abstracts.status,
          code: abstracts.code,
          averageScore: abstracts.averageScore,
          reviewCount: abstracts.reviewCount,
        });
      if (!updated) {
        return { ok: false, reason: "already_finalized" };
      }

      await insertAuditLog(
        {
          entityType: "Abstract",
          entityId: abstractId,
          action: "finalize",
          changes: {
            status: { old: existing.status, new: decision },
            finalType: { old: existing.finalType, new: finalType ?? null },
            code: { old: existing.code, new: allocatedCode?.code ?? null },
          },
          performedBy,
        },
        tx,
      );

      const decisionEmails = selectDecisionEmails({
        abstractId,
        status: updated.status,
        decidedFrom: existing.updatedAt,
        config: cfg,
        reviews,
      });
      for (const email of decisionEmails) {
        await enqueueAbstractEmailOutboxEvent(tx, email.payload, email.dedupeKey);
      }

      await enqueueRealtimeOutboxEvent(tx, {
        type: "abstract.finalized",
        clientId: ev?.clientId ?? "",
        eventId,
        payload: {
          id: updated.id,
          status: updated.status,
          code: updated.code,
          averageScore: updated.averageScore,
          reviewCount: updated.reviewCount,
        },
        ts: Date.now(),
      });

      return { ok: true };
    });
  } catch (error) {
    // H5: two themes sharing a sortOrder (or a codeNumber race) can allocate
    // an identical code string, violating abstracts_event_id_code_key. Map it
    // to a typed reason instead of letting the raw 23505 escape as a 500.
    if (isDuplicateCodeViolation(error)) {
      return { ok: false, reason: "code_conflict" };
    }
    throw error;
  }
}

export type ReopenResult =
  | { ok: false; reason: "not_found" | "not_finalized" }
  | { ok: true };

export async function reopenAbstractTxn(params: {
  eventId: string;
  abstractId: string;
  performedBy: string;
}): Promise<ReopenResult> {
  const { eventId, abstractId, performedBy } = params;
  return withLockingTxn(async (tx): Promise<ReopenResult> => {
    if (!(await lockAbstractForUpdate(tx, abstractId))) {
      return { ok: false, reason: "not_found" };
    }
    const [existing] = await tx
      .select()
      .from(abstracts)
      .where(eq(abstracts.id, abstractId))
      .limit(1);
    if (!existing || existing.eventId !== eventId) {
      return { ok: false, reason: "not_found" };
    }
    if (!FINAL_STATUSES.includes(existing.status)) {
      return { ok: false, reason: "not_finalized" };
    }

    const [ev] = await tx
      .select({ clientId: events.clientId })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);
    const [{ n: activeReviewCount }] = await tx
      .select({ n: count() })
      .from(abstractReviews)
      .where(
        and(
          eq(abstractReviews.abstractId, abstractId),
          eq(abstractReviews.active, true),
        ),
      );
    const nextStatus =
      activeReviewCount > 0 ? ("UNDER_REVIEW" as const) : ("SUBMITTED" as const);

    const [updated] = await tx
      .update(abstracts)
      .set({
        status: nextStatus,
        finalType: null,
        code: null,
        codeNumber: null,
        // M6: clear stale presented flags from a prior decision cycle so a
        // reopened, re-decided abstract isn't still certificate-eligible.
        presentedAt: null,
        presentedBy: null,
      })
      .where(eq(abstracts.id, abstractId))
      .returning({
        id: abstracts.id,
        status: abstracts.status,
        averageScore: abstracts.averageScore,
        reviewCount: abstracts.reviewCount,
      });

    await insertAuditLog(
      {
        entityType: "Abstract",
        entityId: abstractId,
        action: "reopen",
        changes: {
          status: { old: existing.status, new: nextStatus },
          finalType: { old: existing.finalType, new: null },
          code: { old: existing.code, new: null },
          codeNumber: { old: existing.codeNumber, new: null },
        },
        performedBy,
      },
      tx,
    );

    await enqueueRealtimeOutboxEvent(tx, {
      type: "abstract.reopened",
      clientId: ev?.clientId ?? "",
      eventId,
      payload: {
        id: updated.id,
        status: updated.status,
        averageScore: updated.averageScore,
        reviewCount: updated.reviewCount,
      },
      ts: Date.now(),
    });

    return { ok: true };
  });
}

export type PresentedResult =
  | { ok: false; reason: "not_found" | "not_accepted" }
  | { ok: true };

export async function markAbstractPresentedTxn(params: {
  eventId: string;
  abstractId: string;
  presented: boolean;
  performedBy: string;
}): Promise<PresentedResult> {
  const { eventId, abstractId, presented, performedBy } = params;
  const [existing] = await getDb()
    .select({
      id: abstracts.id,
      eventId: abstracts.eventId,
      status: abstracts.status,
      presentedAt: abstracts.presentedAt,
      clientId: events.clientId,
    })
    .from(abstracts)
    .innerJoin(events, eq(abstracts.eventId, events.id))
    .where(eq(abstracts.id, abstractId))
    .limit(1);
  if (!existing || existing.eventId !== eventId) {
    return { ok: false, reason: "not_found" };
  }
  if (existing.status !== "ACCEPTED") {
    return { ok: false, reason: "not_accepted" };
  }

  return withTxn(async (tx): Promise<PresentedResult> => {
    const updated = await tx
      .update(abstracts)
      .set(
        presented
          ? { presentedAt: new Date(), presentedBy: performedBy }
          : { presentedAt: null, presentedBy: null },
      )
      .where(
        and(
          eq(abstracts.id, abstractId),
          eq(abstracts.eventId, eventId),
          eq(abstracts.status, "ACCEPTED"),
        ),
      )
      .returning({ id: abstracts.id });
    if (updated.length === 0) {
      return { ok: false, reason: "not_accepted" };
    }

    await insertAuditLog(
      {
        entityType: "Abstract",
        entityId: abstractId,
        action: presented ? "mark_presented" : "unmark_presented",
        changes: {
          presentedAt: {
            old: existing.presentedAt,
            new: presented ? "now" : null,
          },
        },
        performedBy,
      },
      tx,
    );

    await enqueueRealtimeOutboxEvent(tx, {
      type: "abstract.presentationChanged",
      clientId: existing.clientId,
      eventId,
      payload: { id: abstractId, presented },
      ts: Date.now(),
    });

    return { ok: true };
  });
}
