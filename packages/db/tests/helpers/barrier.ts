/**
 * N-party rendezvous. Every caller blocks at `arrive()` until all N have arrived,
 * then all proceed. Used to force the drift window in the recompute-race tests:
 * hold every transaction at the point *after* it has read + computed but *before*
 * it writes, so under READ COMMITTED each sees only its own uncommitted child row.
 */
export function makeBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) open();
    await gate;
  };
}
