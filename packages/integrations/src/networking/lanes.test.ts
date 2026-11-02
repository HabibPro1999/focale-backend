import { describe, expect, it, vi } from "vitest";
import { runClaimLanes } from "./lanes";

const batches = (...items: number[][]) => {
  const queue = [...items];
  return vi.fn(async () => queue.shift() ?? []);
};

describe("runClaimLanes", () => {
  it("drains a group across its lanes and stops at the first empty claim", async () => {
    const claim = batches([1], [2], [3]);
    const seen: number[] = [];
    await runClaimLanes([{ lanes: 2, claim, process: async (rows: number[]) => void seen.push(...rows) }]);
    expect(seen.sort()).toEqual([1, 2, 3]);
    // Three batches, then one empty claim per lane at most.
    expect(claim.mock.calls.length).toBeLessThanOrEqual(5);
  });
  it("bounds a group's claims with maxBatches (the embedding tick)", async () => {
    const claim = vi.fn(async () => [1]);
    await runClaimLanes([{ lanes: 3, maxBatches: 4, claim, process: async () => {} }]);
    expect(claim).toHaveBeenCalledTimes(4);
  });
  it("keeps a polling group claiming while another group works, then stops with it", async () => {
    let release!: () => void;
    const busy = new Promise<void>((resolve) => (release = resolve));
    const general = batches([1]);
    const dedicated = batches([], [10], []);
    const seen: number[] = [];
    const done = runClaimLanes([
      { lanes: 1, claim: general, process: async () => busy },
      { lanes: 1, claim: dedicated, idlePollMs: 5, process: async (rows: number[]) => void seen.push(...rows) },
    ]);
    await vi.waitFor(() => expect(seen).toEqual([10]));
    release();
    await done;
    expect(dedicated.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it("a polling group alone stops at its first empty claim", async () => {
    const claim = batches();
    await runClaimLanes([{ lanes: 2, claim, idlePollMs: 1_000, process: async () => {} }]);
    expect(claim).toHaveBeenCalledTimes(2);
  });
  it("claims nothing after the deadline or once aborted", async () => {
    const claim = vi.fn(async () => [1]);
    await runClaimLanes([{ lanes: 2, claim, process: async () => {} }], { until: Date.now() - 1 });
    const aborted = new AbortController();
    aborted.abort();
    await runClaimLanes([{ lanes: 2, claim, process: async () => {} }], { signal: aborted.signal });
    expect(claim).not.toHaveBeenCalled();
  });
  it("lets every lane settle before rethrowing the first lane error", async () => {
    const other = vi.fn(async (_rows: number[]) => {});
    const failing = vi.fn(async () => {
      throw new Error("claim failed");
    });
    await expect(runClaimLanes([
      { lanes: 1, claim: failing, process: async () => {} },
      { lanes: 1, claim: batches([1], [2]), process: other },
    ])).rejects.toThrow("claim failed");
    expect(other).toHaveBeenCalledTimes(2);
  });
});
