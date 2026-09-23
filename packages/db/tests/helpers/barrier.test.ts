import { describe, expect, it } from "vitest";
import { makeBarrier } from "./barrier";

describe("makeBarrier", () => {
  it("releases every participant after all have arrived", async () => {
    const barrier = makeBarrier(3, 100);
    await Promise.all([barrier(), barrier(), barrier()]);
  });

  it("rejects instead of hanging when a participant never arrives", async () => {
    const barrier = makeBarrier(2, 5);
    await expect(barrier()).rejects.toThrow("Barrier timed out after 5ms (1/2 arrived)");
  });
});
