import type { AppEvent } from "@app/contracts";
import { isFullySettled } from "@app/shared";
import type { DbExecutor } from "../client";
import { enqueueRealtimeOutboxEvent } from "../outbox";
import { syncNetworkingRegistration } from "../queries/networking";

/**
 * Enqueue realtime events in the caller's transaction, one after the other so
 * a failed insert stops the rest (the transaction is aborted anyway).
 * Registrations whose money state changed (registration.updated /
 * paymentConfirmed) are first re-projected into networking, whose eligibility
 * depends on payment status. Returns each enqueue's result, in order.
 */
export async function emitSettlementEvents(tx: DbExecutor, events: AppEvent[]): Promise<unknown> {
  const changedIds = new Set(
    events
      .filter((ev) => ev.type === "registration.updated" || ev.type === "registration.paymentConfirmed")
      .map((ev) => String(ev.payload.id)),
  );
  for (const id of changedIds) await syncNetworkingRegistration(id, tx);
  const results: Awaited<ReturnType<typeof enqueueRealtimeOutboxEvent>>[] = [];
  for (const event of events) results.push(await enqueueRealtimeOutboxEvent(tx, event));
  return results;
}

/**
 * Event pair for a status-affecting change: registration.paymentConfirmed when
 * the registration newly reached a fully-settled status, else
 * registration.updated; plus eventAccess.countsChanged when access counts may
 * have moved (listing `accessIds` when the caller knows which).
 */
export function settlementEventPair(args: {
  id: string;
  eventId: string;
  clientId: string;
  oldStatus: string;
  newStatus: string | undefined;
  emitCountsChanged: boolean;
  accessIds?: string[];
}): AppEvent[] {
  const { id, eventId, clientId, oldStatus, newStatus, emitCountsChanged, accessIds = [] } = args;
  const statusChanged = newStatus !== undefined && newStatus !== oldStatus;
  const becameSettled = statusChanged && isFullySettled(newStatus) && !isFullySettled(oldStatus);
  const events: AppEvent[] = [
    {
      type: becameSettled ? "registration.paymentConfirmed" : "registration.updated",
      clientId,
      eventId,
      payload: { id, paymentStatus: newStatus ?? oldStatus },
      ts: Date.now(),
    },
  ];
  if (emitCountsChanged) {
    events.push({
      type: "eventAccess.countsChanged",
      clientId,
      eventId,
      payload: { id: eventId, accessIds },
      ts: Date.now(),
    });
  }
  return events;
}
