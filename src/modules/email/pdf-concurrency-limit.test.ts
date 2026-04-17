/**
 * Fix 4 — PDF concurrency semaphore
 *
 * Firing 10 parallel "PDF generation" tasks through the module's withPdfSlot
 * helper should never have more than 3 inflight at the same time (PDF_CONCURRENCY_MAX=3).
 */
import { describe, it, expect } from "vitest";
import { getPdfInflight, withPdfSlot } from "@modules/email/email-queue.service.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PDF concurrency semaphore (Fix 4)", () => {
  it("getPdfInflight starts at 0 in a fresh module load", () => {
    // After other tests it may be higher if they leaked, but in an isolated
    // test run (vitest isolates modules per test file) it must be 0.
    expect(getPdfInflight()).toBe(0);
  });

  it("peak inflight never exceeds 3 when 10 tasks run in parallel", async () => {
    const peakSamples: number[] = [];

    // Simulate 10 concurrent "PDF generation" tasks, each taking a small delay
    const tasks = Array.from({ length: 10 }, (_, i) =>
      withPdfSlot(async () => {
        // Sample inflight immediately after acquiring slot
        peakSamples.push(getPdfInflight());
        await delay(20); // simulate PDF work
        return i;
      }),
    );

    const results = await Promise.all(tasks);

    // All 10 completed
    expect(results).toHaveLength(10);
    expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // Peak inflight never exceeded 3
    const peak = Math.max(...peakSamples);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThanOrEqual(1); // at least 1 was inflight

    // After all tasks complete, semaphore is fully drained
    expect(getPdfInflight()).toBe(0);
  });

  it("slot is released even if the task throws", async () => {
    const before = getPdfInflight();

    await expect(
      withPdfSlot(async () => {
        throw new Error("PDF generation failed");
      }),
    ).rejects.toThrow("PDF generation failed");

    // Slot must be released on error
    expect(getPdfInflight()).toBe(before);
  });

  it("sequential tasks each see inflight=1", async () => {
    const observed: number[] = [];

    for (let i = 0; i < 5; i++) {
      await withPdfSlot(async () => {
        observed.push(getPdfInflight());
      });
    }

    // Each sequential task runs alone — inflight is always 1 during execution
    expect(observed.every((v) => v === 1)).toBe(true);
    expect(getPdfInflight()).toBe(0);
  });
});
