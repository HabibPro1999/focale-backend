import { and, eq, inArray, sql } from "drizzle-orm";
import { rowsOf } from "../helpers";
import { getDb } from "../client";
import { emailLogs } from "../schema/email";
import type { NetworkingDeliveryRow } from "./networking-delivery";

/** These rows belong exclusively to the networking worker, never to the generic email queue. */
export async function beginNetworkingEmailLog(
  row: NetworkingDeliveryRow,
  input: {
    registrationId: string;
    recipientEmail: string;
    recipientName: string;
    subject: string;
  },
) {
  return getDb().transaction(async (db) => {
    // Lock the delivery while checking ownership and writing its email log.
    const owned = rowsOf(await db.execute(sql`SELECT id FROM networking_deliveries
      WHERE id=${row.id} AND status='PROCESSING' AND locked_until=${row.lockedUntil?.toISOString()}::timestamp
        AND locked_until>now() FOR UPDATE`));
    if (!owned.length) return { alreadySent: false, leaseLost: true };
    const inserted = await db
      .insert(emailLogs)
      .values({
        id: row.id,
        ...input,
        status: "SENDING",
        maxRetries: 4,
        attemptCount: 1,
        lastAttemptAt: new Date(),
        lockedBy: `networking:${row.id}`,
        lockedAt: new Date(),
        lockedUntil: row.lockedUntil,
        dedupeKey: `networking:${row.id}`,
        contextSnapshot: {
          dispatchOwner: "networking",
          eventId: row.eventId,
          profileId: row.profileId,
          networkingType: row.type,
          deliveryId: row.id,
        },
      })
      .onConflictDoNothing({ target: emailLogs.id }).returning({ id: emailLogs.id });
    const [existing] = await db
      .select()
      .from(emailLogs)
      .where(eq(emailLogs.id, row.id));
    if (!existing) throw new Error("Email tracking log could not be created");
    if (
      ["SENT", "DELIVERED", "OPENED", "CLICKED", "BOUNCED", "DROPPED"].includes(
        existing.status,
      )
    )
      return { alreadySent: true };
    if (!inserted.length && existing.status === "SENDING" && existing.lockedUntil && existing.lockedUntil > new Date())
      return { alreadySent: false, leaseLost: true };
    await db
      .update(emailLogs)
      .set({
        subject: input.subject,
        recipientEmail: input.recipientEmail,
        recipientName: input.recipientName,
        status: "SENDING",
        attemptCount: row.attempts,
        lastAttemptAt: new Date(),
        lockedAt: new Date(),
        lockedUntil: row.lockedUntil,
        lockedBy: `networking:${row.id}`,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(emailLogs.id, row.id),
          inArray(emailLogs.status, ["SENDING", "FAILED", "SKIPPED"]),
        ),
      );
    return { alreadySent: false };
  });
}
export async function finishNetworkingEmailLog(
  row: NetworkingDeliveryRow,
  outcome: "sent" | "failed" | "skipped",
  messageId?: string,
) {
  return getDb().transaction(async (db) => {
    // Lock the delivery while checking ownership and writing its email log.
    const owned = rowsOf(await db.execute(sql`SELECT id FROM networking_deliveries
      WHERE id=${row.id} AND status='PROCESSING' AND locked_until=${row.lockedUntil?.toISOString()}::timestamp
        AND locked_until>now() FOR UPDATE`));
    if (!owned.length) return { alreadySent: false, leaseLost: true };
    if (outcome === "sent") {
      // Fast webhooks can arrive before the provider response: never downgrade their delivery/open/click state.
      await db
        .update(emailLogs)
        .set({
          providerMessageId: messageId,
          sentAt: new Date(),
          errorMessage: null,
          lockedBy: null,
          lockedAt: null,
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(emailLogs.id, row.id));
      await db
        .update(emailLogs)
        .set({ status: "SENT" })
        .where(and(eq(emailLogs.id, row.id), eq(emailLogs.status, "SENDING")));
    } else {
      await db
        .update(emailLogs)
        .set({
          status:
            outcome === "failed"
              ? row.attempts >= 5
                ? "FAILED"
                : "SENDING"
              : "SKIPPED",
          errorMessage:
            outcome === "failed"
              ? "Networking email delivery failed"
              : "Networking delivery no longer eligible",
          retryCount: sql`${emailLogs.retryCount}+${outcome === "failed" ? 1 : 0}`,
          failedAt: outcome === "failed" && row.attempts >= 5 ? new Date() : null,
          lockedBy: null,
          lockedAt: null,
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(emailLogs.id, row.id),
            inArray(emailLogs.status, ["SENDING", "FAILED"]),
          ),
        );
    }
  });
}
