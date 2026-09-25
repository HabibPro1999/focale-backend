import { beforeEach, describe, expect, it, vi } from "vitest";

const integrations = vi.hoisted(() => ({
  processEmailQueue: vi.fn(),
  generateCertificateEmailAttachments: vi.fn(),
}));
vi.mock("@app/integrations", () => integrations);
vi.mock("@app/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/shared")>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { EMAIL_BATCH_SIZE, EMAIL_DRAIN_MARGIN_MS, EmailQueueJob } from "./email-queue.job";
import type { JobContext } from "../job";

beforeEach(() => {
  vi.clearAllMocks();
  integrations.processEmailQueue.mockResolvedValue({ processed: 0, sent: 0, failed: 0, skipped: 0 });
});

describe("EmailQueueJob", () => {
  it("runs every 5 s within a 120 s budget", () => {
    const job = new EmailQueueJob();
    expect(job.intervalMs).toBe(5_000);
    expect(job.timeoutMs).toBe(120_000);
  });

  it("claims batches of 20 and drains until the run's deadline minus the margin", async () => {
    const signal = new AbortController().signal;
    const deadline = Date.now() + 120_000;
    await new EmailQueueJob().run({ signal, deadline, log: {} as JobContext["log"] });

    expect(EMAIL_BATCH_SIZE).toBe(20);
    expect(integrations.processEmailQueue).toHaveBeenCalledWith(20, {
      workerId: expect.stringContaining("email"),
      generateCertificateAttachments: integrations.generateCertificateEmailAttachments,
      signal,
      drainUntil: deadline - EMAIL_DRAIN_MARGIN_MS,
    });
    // The drain window leaves room for the last batch inside the budget.
    expect(EMAIL_DRAIN_MARGIN_MS).toBeGreaterThanOrEqual(30_000);
    expect(EMAIL_DRAIN_MARGIN_MS).toBeLessThan(120_000);
  });
});
