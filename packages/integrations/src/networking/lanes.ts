/**
 * A group of worker lanes sharing one claim source (the networking lane loop,
 * shared by the embedding and delivery workers).
 */
export interface ClaimLaneGroup<T> {
  /** Concurrent lanes in this group. */
  lanes: number;
  /** Claims the next batch; an empty batch means nothing is due. */
  claim(): Promise<T[]>;
  // Method syntax: a group of any row type is a ClaimLaneGroup<unknown>.
  process(claimed: T[]): Promise<void>;
  /** Claims the whole group may make (empty claims included); unbounded when unset. */
  maxBatches?: number;
  /**
   * Dedicated lanes: after an empty claim, try again after this delay for as
   * long as any lane of a non-polling group is still working. Unset: the
   * group stops at its first empty claim.
   */
  idlePollMs?: number;
}

export interface ClaimLaneStop {
  /** Epoch ms after which no lane starts another claim. */
  until?: number;
  signal?: AbortSignal;
}

function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Runs every group's lanes until each is drained or stopped. A lane claims
 * only when it is ready to work on the batch, so leases never expire waiting
 * for a slot. Every lane settles before the first lane error is rethrown.
 */
export async function runClaimLanes(
  groups: ClaimLaneGroup<unknown>[],
  stop: ClaimLaneStop = {},
): Promise<void> {
  let working = groups
    .filter((group) => group.idlePollMs === undefined)
    .reduce((total, group) => total + group.lanes, 0);
  const open = () =>
    !stop.signal?.aborted && (stop.until === undefined || Date.now() < stop.until);
  const lanes = groups.flatMap((group) => {
    const state = { drained: false, batches: 0 };
    const polling = group.idlePollMs !== undefined;
    const lane = async () => {
      try {
        while (!state.drained && open() && state.batches++ < (group.maxBatches ?? Infinity)) {
          const claimed = await group.claim();
          if (claimed.length) {
            await group.process(claimed);
            continue;
          }
          if (!polling) {
            state.drained = true;
            break;
          }
          // Nothing due for a dedicated lane: stop with the other lanes.
          if (working === 0) break;
          await pause(group.idlePollMs!, stop.signal);
        }
      } finally {
        if (!polling) working--;
      }
    };
    return Array.from({ length: group.lanes }, lane);
  });
  const settled = await Promise.allSettled(lanes);
  const error = settled.find((result) => result.status === "rejected");
  if (error?.status === "rejected") throw error.reason;
}
