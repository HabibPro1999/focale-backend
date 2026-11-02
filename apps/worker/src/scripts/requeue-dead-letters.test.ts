import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The script runs main() on import and calls process.exit(): tests spy on
// process.exit and re-import it for each argv.

const mocks = vi.hoisted(() => ({
  findDeadLetteredOutboxEvents: vi.fn(),
  requeueDeadLetteredOutboxEvents: vi.fn(),
  configureDb: vi.fn(),
  closeDb: vi.fn(),
}));
vi.mock("@app/db", () => mocks);

const ORIGINAL_ARGV = process.argv;

function setArgv(...args: string[]) {
  process.argv = [ORIGINAL_ARGV[0]!, ORIGINAL_ARGV[1]!, ...args];
}

function deadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ob-1",
    type: "email.triggered",
    aggregateType: "Registration",
    aggregateId: "reg-1",
    attemptCount: 5,
    maxAttempts: 5,
    errorMessage: "provider down",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    deadLetteredAt: new Date("2026-09-02T00:00:00.000Z"),
    ...overrides,
  };
}

async function runScript() {
  vi.resetModules();
  await import("./requeue-dead-letters.js");
  await new Promise((r) => setTimeout(r, 10));
}

describe("requeue-dead-letters", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any;
  let logs: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    logs = [];
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.findDeadLetteredOutboxEvents.mockResolvedValue([deadRow(), deadRow({ id: "ob-2" })]);
    mocks.requeueDeadLetteredOutboxEvents.mockResolvedValue(2);
    mocks.closeDb.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    vi.restoreAllMocks();
  });

  it("dry run by default: lists the candidates and changes nothing", async () => {
    setArgv();
    await runScript();
    expect(mocks.findDeadLetteredOutboxEvents).toHaveBeenCalledWith({
      ids: undefined,
      type: undefined,
      since: undefined,
      limit: 100,
    });
    expect(mocks.requeueDeadLetteredOutboxEvents).not.toHaveBeenCalled();
    expect(logs[0]).toBe("Dry run: 2 dead-lettered outbox row(s) match.");
    expect(logs[1]).toContain("candidate id=ob-1 type=email.triggered aggregate=Registration/reg-1 attempts=5/5");
    expect(mocks.closeDb).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("--apply requeues exactly the listed rows, with the filters passed through", async () => {
    setArgv("--apply", "--type", "email.triggered", "--id", "ob-1", "--id", "ob-2", "--since", "2026-09-01T00:00:00Z", "--limit", "5");
    await runScript();
    expect(mocks.findDeadLetteredOutboxEvents).toHaveBeenCalledWith({
      ids: ["ob-1", "ob-2"],
      type: "email.triggered",
      since: new Date("2026-09-01T00:00:00Z"),
      limit: 5,
    });
    expect(mocks.requeueDeadLetteredOutboxEvents).toHaveBeenCalledWith(["ob-1", "ob-2"]);
    expect(logs.at(-1)).toBe("Requeued 2 of 2 row(s).");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it.each([
    ["--limit", "0"],
    ["--limit", "1001"],
    ["--since", "not-a-date"],
    ["--bogus"],
  ])("rejects invalid arguments (%s %s) before touching the database", async (...args) => {
    setArgv(...args.filter((a): a is string => typeof a === "string"));
    await runScript();
    expect(mocks.findDeadLetteredOutboxEvents).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
