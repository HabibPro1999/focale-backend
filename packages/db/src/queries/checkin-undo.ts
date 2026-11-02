import { and, eq } from "drizzle-orm";
import { withLockingTxn } from "../txn";
import { registrations, accessCheckIns, events } from "../schema";
import { enqueueRealtimeOutboxEvent, insertAuditLog } from "../outbox";

export interface UndoCheckInInput {
  eventId: string;
  registrationId: string;
  accessId?: string;
  actorId: string;
  expectedCheckedInAt?: Date;
}
export type UndoCheckInResult = { outcome: "UNDONE" | "ALREADY_UNDONE" | "NOT_FOUND" | "CONFLICT" };

/** The selected check-in alone is reversed; a changed scan is never overwritten. */
export function undoCheckIn(input: UndoCheckInInput): Promise<UndoCheckInResult> {
  return withLockingTxn(async (tx) => {
    const [reg] = await tx.select().from(registrations).where(and(
      eq(registrations.id, input.registrationId), eq(registrations.eventId, input.eventId),
    )).for("update");
    if (!reg) return { outcome: "NOT_FOUND" };
    const access = input.accessId ? (await tx.select().from(accessCheckIns).where(and(
      eq(accessCheckIns.registrationId, reg.id), eq(accessCheckIns.accessId, input.accessId),
    )).for("update"))[0] : undefined;
    const current = input.accessId ? access?.checkedInAt : reg.checkedInAt;
    if (!current) return { outcome: "ALREADY_UNDONE" };
    if (input.expectedCheckedInAt && current.getTime() !== input.expectedCheckedInAt.getTime()) {
      return { outcome: "CONFLICT" };
    }
    if (access) await tx.delete(accessCheckIns).where(eq(accessCheckIns.id, access.id));
    else await tx.update(registrations).set({ checkedInAt: null, checkedInBy: null })
      .where(eq(registrations.id, reg.id));
    await insertAuditLog({ entityType: access ? "AccessCheckIn" : "Registration",
      entityId: access?.id ?? reg.id, action: "UNDO_CHECK_IN", performedBy: input.actorId,
      changes: { checkedInAt: { old: current.toISOString(), new: null },
        ...(input.accessId ? { accessId: { old: input.accessId, new: input.accessId } } : {}) },
    }, tx);
    const [event] = await tx.select({ clientId: events.clientId }).from(events).where(eq(events.id, input.eventId));
    if (event) await enqueueRealtimeOutboxEvent(tx, { type: "registration.updated", clientId: event.clientId,
      eventId: input.eventId, payload: { id: reg.id }, ts: Date.now() });
    return { outcome: "UNDONE" };
  });
}
