/**
 * N-party rendezvous. Every caller blocks at `arrive()` until all N have arrived,
 * then all proceed. Used to force the drift window in the recompute-race tests:
 * hold every transaction at the point *after* it has read + computed but *before*
 * it writes, so under READ COMMITTED each sees only its own uncommitted child row.
 */
export function makeBarrier(parties: number, timeoutMs = 10_000): () => Promise<void> {
  if (!Number.isInteger(parties) || parties < 1) {
    throw new Error("Barrier parties must be a positive integer");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Barrier timeout must be a positive number of milliseconds");
  }
  let arrived = 0;
  let open!: () => void;
  let fail!: (error: Error) => void;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return async () => {
    if (arrived === 0) {
      timeout = setTimeout(() => {
        fail(new Error(`Barrier timed out after ${timeoutMs}ms (${arrived}/${parties} arrived)`));
      }, timeoutMs);
    }
    arrived += 1;
    if (arrived === parties) {
      if (timeout) clearTimeout(timeout);
      open();
    }
    await gate;
  };
}
