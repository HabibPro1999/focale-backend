import { ErrorCodes, type AppEvent } from "@app/contracts";
import {
  casDecrementRegisteredTx,
  casIncrementRegisteredTx,
  enqueueRealtimeOutboxEvent,
  enqueueTriggeredEmailOutbox,
  getEventCounterInfoTx,
  insertAuditLog,
  syncNetworkingRegistration,
  type DbExecutor,
} from "@app/db";
import { isFullySettled } from "@app/shared";
import { badRequest, conflict, notFound } from "../../core/app-exception";

// ==========================================================================
// Shared side-effect + settlement helpers
// ==========================================================================

export async function emitRegistrationEventsAndSyncNetworking(exec: DbExecutor, events: AppEvent[]): Promise<unknown> {
  const changedIds = new Set(events.filter(ev =>
    ev.type === "registration.updated" || ev.type === "registration.paymentConfirmed"
  ).map(ev => String(ev.payload.id)));
  for (const id of changedIds) await syncNetworkingRegistration(id, exec);
  return Promise.all(events.map((ev) => enqueueRealtimeOutboxEvent(exec, ev)));
}

/**
 * Event pair for a status-affecting edit: registration.paymentConfirmed when
 * the registration newly reached a fully-settled status, else
 * registration.updated; plus eventAccess.countsChanged when access counts may
 * have moved.
 */
export function settlementEventPair(args: {
  id: string;
  eventId: string;
  clientId: string;
  oldStatus: string;
  newStatus: string | undefined;
  emitCountsChanged: boolean;
}): AppEvent[] {
  const { id, eventId, clientId, oldStatus, newStatus, emitCountsChanged } =
    args;
  const statusChanged = newStatus !== undefined && newStatus !== oldStatus;
  const becameSettled =
    statusChanged &&
    isFullySettled(newStatus) &&
    !isFullySettled(oldStatus);
  const events: AppEvent[] = [
    {
      type: becameSettled
        ? "registration.paymentConfirmed"
        : "registration.updated",
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
      payload: { id: eventId, accessIds: [] },
      ts: Date.now(),
    });
  }
  return events;
}

export async function syncNetworkingAndQueueRegistrationCreatedEmail(
  exec: DbExecutor,
  eventId: string,
  registration: {
    id: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
  },
): Promise<boolean> {
  await syncNetworkingRegistration(registration.id, exec);
  return enqueueTriggeredEmailOutbox(
    exec,
    {
      trigger: "REGISTRATION_CREATED",
      eventId,
      registration: {
        id: registration.id,
        email: registration.email,
        firstName: registration.firstName ?? null,
        lastName: registration.lastName ?? null,
      },
    },
    `email:triggered:REGISTRATION_CREATED:${registration.id}`,
  );
}

/** Atomic event registered-count increment; mirrors legacy incrementRegisteredCountTx. */
export async function incrementEventRegistered(
  exec: DbExecutor,
  eventId: string,
): Promise<void> {
  if (await casIncrementRegisteredTx(exec, eventId)) return;
  const info = await getEventCounterInfoTx(exec, eventId);
  if (!info) {
    throw notFound("Event not found");
  }
  if (info.status !== "OPEN") {
    throw badRequest("Event is not accepting public actions", { code: ErrorCodes.EVENT_NOT_OPEN });
  }
  throw conflict("Event is at capacity", { code: ErrorCodes.EVENT_FULL });
}

export async function decrementEventRegistered(
  exec: DbExecutor,
  eventId: string,
): Promise<void> {
  if (await casDecrementRegisteredTx(exec, eventId)) return;
  const info = await getEventCounterInfoTx(exec, eventId);
  if (!info) {
    throw notFound("Event not found");
  }
  throw badRequest("Event registered count is already zero");
}

export function audit(
  exec: DbExecutor,
  entry: {
    entityId: string;
    action: string;
    changes: Record<string, { old: unknown; new: unknown }>;
    performedBy?: string | null;
  },
): Promise<void> {
  return insertAuditLog(
    {
      entityType: "Registration",
      entityId: entry.entityId,
      action: entry.action,
      changes: entry.changes,
      performedBy: entry.performedBy ?? null,
    },
    exec,
  );
}
