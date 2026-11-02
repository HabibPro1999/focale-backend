import { ConflictException } from "@nestjs/common";
import { ErrorCodes, StoredNetworkingMeetingCancellationSchema, type NetworkingConfig } from "@app/contracts";
import type { NetworkingRow, NetworkingStore } from "@app/db";
import type { NetworkingMeetingsService } from "./networking.meetings.service";
import { networkingPair, networkingSlots } from "./networking.policy";

const refused = (message: string) => new ConflictException({ code: ErrorCodes.NETWORKING_SLOT_CONFLICT, message });
/** Caller holds allocation-hour locks; failure rolls the complete transaction back. */
export async function restoreNetworkingMeeting(
  event: NetworkingRow<"events">, config: NetworkingConfig, row: NetworkingRow<"meetings">,
  store: NetworkingStore, meetings: NetworkingMeetingsService,
) {
  const saved = StoredNetworkingMeetingCancellationSchema.safeParse(row.cancellationState);
  if (row.status !== "CANCELLED" || !saved.success) throw refused("Meeting has no restorable cancellation");
  if (!config.enabled || !config.meetingsEnabled || row.startsAt <= new Date() ||
      !networkingSlots(config, event).includes(row.startsAt.toISOString()) ||
      row.endsAt.getTime() - row.startsAt.getTime() !== config.slotDurationMinutes * 60_000) {
    throw refused("The original meeting slot is no longer available");
  }
  const [profileAId, profileBId] = networkingPair(row.requesterId, row.recipientId);
  if (!await store.one("connections", { eventId: event.id, profileAId, profileBId }) ||
      await store.one("blocks", { eventId: event.id, profileId: row.requesterId, targetId: row.recipientId }) ||
      await store.one("blocks", { eventId: event.id, profileId: row.recipientId, targetId: row.requesterId })) {
    throw refused("Participants are no longer connected or available to each other");
  }
  const original = saved.data;
  const allocation = await meetings.reserve({ event, config }, { ...row, status: original.status }, row.startsAt, row.endsAt, store,
    { hold: original.status === "PENDING", ...(row.tableId ? { forcedTableId: row.tableId } : {}) });
  const [restored] = await store.update("meetings", { eventId: event.id, id: row.id, revision: row.revision }, {
    ...allocation, cancellationState: null, cancellationNote: "", revision: row.revision + 1,
    proposedStartsAt: original.proposedStartsAt && row.expiresAt > new Date() ? new Date(original.proposedStartsAt) : null,
    proposalBy: original.proposedStartsAt && row.expiresAt > new Date() ? original.proposalBy : null,
  });
  if (!restored) throw refused("Meeting changed while restoring it");
  return restored;
}
