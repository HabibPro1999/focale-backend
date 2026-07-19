import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This script self-invokes `main()` at import time and calls process.exit() on
// completion — so tests spy on process.exit (never letting it actually kill
// the test worker) and re-import (vi.resetModules) for each argv scenario.

const mocks = vi.hoisted(() => ({
  findSkippedAbstractEmails: vi.fn(),
  enqueueAbstractEmailOutboxEvent: vi.fn(),
}));

vi.mock("@app/db", () => ({
  findSkippedAbstractEmails: mocks.findSkippedAbstractEmails,
  enqueueAbstractEmailOutboxEvent: mocks.enqueueAbstractEmailOutboxEvent,
  withTxn: (fn: (tx: unknown) => unknown) => fn({ tx: true }),
}));

const ORIGINAL_ARGV = process.argv;

function setArgv(...args: string[]) {
  process.argv = [ORIGINAL_ARGV[0]!, ORIGINAL_ARGV[1]!, ...args];
}

function skippedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "log-abc",
    abstractId: "ab-1",
    abstractTrigger: "ABSTRACT_DECISION",
    recipientEmail: "a@x.com",
    recipientName: "A",
    errorMessage: null,
    queuedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

async function runScript() {
  vi.resetModules();
  await import("./requeue-skipped-abstract-emails.js");
  // Flush the microtasks queued by main()'s internal awaits (not itself
  // awaited by the module — main().then(...) is fire-and-forget at the
  // top level).
  await new Promise((r) => setTimeout(r, 10));
}

describe("requeue-skipped-abstract-emails", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.enqueueAbstractEmailOutboxEvent.mockResolvedValue(true);
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    vi.restoreAllMocks();
  });

  // H6: the dedupe key must be derived from the ORIGINAL email_logs id so a
  // second --apply run on the same historical row cannot double-send.
  it("passes a dedupeKey derived from the original email_logs id on --apply", async () => {
    setArgv("--apply");
    mocks.findSkippedAbstractEmails.mockResolvedValue([skippedRow()]);

    await runScript();

    expect(mocks.enqueueAbstractEmailOutboxEvent).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueAbstractEmailOutboxEvent).toHaveBeenCalledWith(
      { tx: true },
      expect.objectContaining({
        trigger: "ABSTRACT_DECISION",
        abstractId: "ab-1",
      }),
      "requeue-skipped-abstract-email:log-abc",
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("derives a distinct dedupeKey per distinct original row", async () => {
    setArgv("--apply");
    mocks.findSkippedAbstractEmails.mockResolvedValue([
      skippedRow({ id: "log-a", recipientEmail: "a@x.com" }),
      skippedRow({ id: "log-b", recipientEmail: "b@x.com" }),
    ]);

    await runScript();

    const keys = mocks.enqueueAbstractEmailOutboxEvent.mock.calls.map(
      (c) => c[2],
    );
    expect(keys).toEqual([
      "requeue-skipped-abstract-email:log-a",
      "requeue-skipped-abstract-email:log-b",
    ]);
  });

  it("dry run (no --apply) enqueues nothing", async () => {
    setArgv();
    mocks.findSkippedAbstractEmails.mockResolvedValue([skippedRow()]);

    await runScript();

    expect(mocks.enqueueAbstractEmailOutboxEvent).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
