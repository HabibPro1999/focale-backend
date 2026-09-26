import type { NetworkingNotice } from "@app/db";
import { logger } from "./logger.service";

/** Wakes one participant stream; the stream then reads its own rows. */
export type NetworkingNoticeListener = () => void;

/**
 * In-process hub for participant notification streams, separate from the admin
 * realtime `eventBus`: admin streams filter only on client/event, so sharing
 * that bus would let them see participant traffic.
 *
 * A notice names one participant of one event (IDs only, no content). Listeners
 * are keyed by exactly that pair, so a notice never wakes another participant's
 * or another event's stream, and a woken stream reads only its own
 * participant's rows. Fed after commit by api networking transactions and by
 * the realtime pump (`networking.notify` outbox rows from the worker and
 * db-level producers). Process-local, like the admin bus: one api instance.
 */
export class NetworkingNotificationHub {
  private readonly listeners = new Map<string, Set<NetworkingNoticeListener>>();

  subscribe(target: NetworkingNotice, listener: NetworkingNoticeListener): () => void {
    const key = hubKey(target);
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(key);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(key);
    };
  }

  /** Wake every stream of this participant; returns how many were woken. */
  publish(notice: NetworkingNotice): number {
    const woken = [...(this.listeners.get(hubKey(notice)) ?? [])];
    for (const listener of woken) {
      try {
        listener();
      } catch (err) {
        logger.error({ err }, "Networking notice listener threw; isolated from other listeners");
      }
    }
    return woken.length;
  }

  /** Open listeners across all participants (health and tests). */
  get size(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

function hubKey(notice: NetworkingNotice): string {
  return JSON.stringify([notice.eventId, notice.profileId]);
}

export const networkingNotificationHub = new NetworkingNotificationHub();
