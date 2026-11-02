import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The script runs main() on import and calls process.exit(): tests spy on
// process.exit and re-import it for each argv. Manifest parsing/building is
// the real @app/db code; the planner, the per-row apply and the invariant
// checks are DB-tested in packages/db (paid-repair / settlement-invariants).

const mocks = vi.hoisted(() => ({
  planPaidSettlementRepair: vi.fn(),
  applyPaidRepairRow: vi.fn(),
  checkSettlementInvariants: vi.fn(),
  configureDb: vi.fn(),
  closeDb: vi.fn(),
}));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/db")>()),
  ...mocks,
}));

const ORIGINAL_ARGV = process.argv;
const SINCE = "2026-06-01T00:00:00.000Z";

function setArgv(...args: string[]) {
  process.argv = [ORIGINAL_ARGV[0]!, ORIGINAL_ARGV[1]!, ...args];
}

function candidate(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    eventId: "ev-1",
    referenceNumber: `26-EV-${id}`,
    section: "A",
    proposedAction: "BACKFILL_PAID",
    flags: [],
    detail: "paid 0 < net 300",
    evidence: ["audit-1"],
    expected: { paymentStatus: "PAID", paidAmount: 0, updatedAt: "2026-07-01T00:00:00.000Z" },
    totalAmount: 300,
    sponsorshipAmount: 0,
    net: 300,
    paidAt: "2026-06-10T00:00:00.000Z",
    proposedPaidAt: "2026-06-10T00:00:00.000Z",
    seatDelta: { BACKFILL_PAID: {}, CONVERT_PARTIAL: { "acc-1": -1 } },
    ...overrides,
  };
}

const REPORT = {
  since: SINCE,
  generatedAt: "2026-09-26T00:00:00.000Z",
  eventId: null,
  candidates: [
    candidate("reg-1"),
    candidate("reg-2", {
      section: "B2",
      proposedAction: "REPROMOTE_PAID",
      expected: { paymentStatus: "PARTIAL", paidAmount: 100, updatedAt: "2026-07-02T00:00:00.000Z" },
      seatDelta: { REPROMOTE_PAID: { "acc-1": 1 } },
      flags: ["CAPACITY_FULL"],
    }),
  ],
  seatImpact: [
    {
      accessId: "acc-1",
      eventId: "ev-1",
      name: "Gala",
      maxCapacity: 10,
      paidCount: 10,
      proposedDelta: 1,
      overCapacity: true,
      registrationIds: ["reg-2"],
    },
  ],
};

async function runScript() {
  vi.resetModules();
  await import("./repair-paid-settlement.js");
  await new Promise((r) => setTimeout(r, 20));
}

// Each test re-imports the script, and with it the real @app/db (for the
// manifest code): slow on a loaded machine, hence the longer timeouts.
describe("repair-paid-settlement", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await vi.importActual("@app/db");
  }, 60_000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any;
  let logs: string[];
  let errors: string[];
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    logs = [];
    errors = [];
    dir = mkdtempSync(join(tmpdir(), "repair-paid-"));
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
    vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(String(line)));
    mocks.planPaidSettlementRepair.mockResolvedValue(REPORT);
    mocks.closeDb.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function approved(rows: Array<Record<string, unknown>>) {
    const path = join(dir, "approved.json");
    writeFileSync(
      path,
      JSON.stringify({
        kind: "focale.repair-paid-settlement",
        version: 1,
        generatedAt: REPORT.generatedAt,
        since: SINCE,
        eventId: null,
        rows,
      }),
    );
    return path;
  }

  it("dry run: prints the sections and writes a manifest with every action unset", async () => {
    const out = join(dir, "repair-manifest.json");
    setArgv("--since", SINCE, "--out", out);
    await runScript();
    expect(mocks.planPaidSettlementRepair).toHaveBeenCalledWith({ since: new Date(SINCE), eventId: undefined });
    expect(mocks.applyPaidRepairRow).not.toHaveBeenCalled();
    expect(logs[0]).toBe(`Dry run since ${SINCE}: 2 candidate(s).`);
    expect(logs).toContain("A: PAID with paid_amount < net: 1");
    expect(logs).toContain("B1: admin-edit demotions: 0");
    expect(logs).toContainEqual(
      expect.stringContaining("registration=reg-2 ref=26-EV-reg-2 event=ev-1 status=PARTIAL paid=100 net=300 proposed=REPROMOTE_PAID flags=CAPACITY_FULL seats=REPROMOTE_PAID=acc-1:+1"),
    );
    expect(logs).toContainEqual(expect.stringContaining("access=acc-1 name=\"Gala\" paid=10 capacity=10 delta=+1 OVER_CAPACITY"));
    const manifest = JSON.parse(readFileSync(out, "utf8"));
    expect(manifest).toMatchObject({ kind: "focale.repair-paid-settlement", version: 1, since: SINCE });
    expect(manifest.rows).toEqual([
      expect.objectContaining({
        id: "reg-1",
        section: "A",
        proposedAction: "BACKFILL_PAID",
        action: null,
        expected: { paymentStatus: "PAID", paidAmount: 0, updatedAt: "2026-07-01T00:00:00.000Z" },
        seatDelta: { BACKFILL_PAID: {}, CONVERT_PARTIAL: { "acc-1": -1 } },
      }),
      expect.objectContaining({ id: "reg-2", section: "B2", action: null }),
    ]);
    expect(logs.at(-1)).toBe(`Wrote ${out} (2 row(s), every action unset). No rows changed.`);
    expect(mocks.closeDb).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("never overwrites an existing manifest", async () => {
    const out = join(dir, "repair-manifest.json");
    writeFileSync(out, "{}");
    setArgv("--since", SINCE, "--out", out);
    await runScript();
    expect(mocks.configureDb).not.toHaveBeenCalled();
    expect(readFileSync(out, "utf8")).toBe("{}");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--apply executes exactly the approved rows, in order, with the manifest's --since", async () => {
    mocks.applyPaidRepairRow
      .mockResolvedValueOnce({
        outcome: "applied",
        id: "reg-1",
        action: "BACKFILL_PAID",
        before: { paymentStatus: "PAID", paidAmount: 0, paidAt: "2026-06-10T00:00:00.000Z" },
        after: { paymentStatus: "PAID", paidAmount: 300, paidAt: "2026-06-10T00:00:00.000Z" },
        seatsMoved: { incremented: [], decremented: [] },
      })
      .mockResolvedValueOnce({ outcome: "skipped", id: "reg-2", action: "REPROMOTE_PAID", reason: "STALE", detail: "now PAID" })
      .mockResolvedValueOnce({ outcome: "skipped", id: "reg-3", action: "SKIP", reason: "SKIP", detail: "approved as SKIP" });
    const rows = [
      { id: "reg-1", section: "A", action: "BACKFILL_PAID", expected: REPORT.candidates[0].expected },
      { id: "reg-2", section: "B2", action: "REPROMOTE_PAID", expected: REPORT.candidates[1].expected },
      { id: "reg-3", section: "B3", action: "SKIP", expected: { paymentStatus: "PENDING", paidAmount: 0, updatedAt: SINCE } },
    ];
    setArgv("--apply", "--manifest", approved(rows));
    await runScript();
    expect(mocks.planPaidSettlementRepair).not.toHaveBeenCalled();
    expect(mocks.applyPaidRepairRow.mock.calls).toEqual(rows.map((row) => [row, { since: new Date(SINCE) }]));
    expect(logs).toContain(
      "applied registration=reg-1 action=BACKFILL_PAID status=PAID->PAID paid=0->300 paidAt=2026-06-10T00:00:00.000Z->2026-06-10T00:00:00.000Z seats=-",
    );
    expect(logs).toContain('skipped registration=reg-2 action=REPROMOTE_PAID reason=STALE detail="now PAID"');
    expect(logs).toContain("skip registration=reg-3 (approved SKIP)");
    expect(logs.at(-1)).toBe("Applied 1, skipped 1 (changed or not applicable), 1 approved SKIP.");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("--apply refuses a manifest with a row whose action is not allowed for its section, before touching the database", async () => {
    setArgv(
      "--apply",
      "--manifest",
      approved([
        { id: "reg-1", section: "A", action: "BACKFILL_PAID", expected: REPORT.candidates[0].expected },
        { id: "reg-2", section: "B2", action: "CONVERT_PARTIAL", expected: REPORT.candidates[1].expected },
      ]),
    );
    await runScript();
    expect(mocks.configureDb).not.toHaveBeenCalled();
    expect(mocks.applyPaidRepairRow).not.toHaveBeenCalled();
    expect(errors[0]).toContain("row 1 (reg-2): action CONVERT_PARTIAL is not allowed for section B2 with status PARTIAL");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--apply refuses a dry-run manifest nobody reviewed", async () => {
    setArgv("--apply", "--manifest", approved([{ id: "reg-1", section: "A", action: null, expected: REPORT.candidates[0].expected }]));
    await runScript();
    expect(mocks.applyPaidRepairRow).not.toHaveBeenCalled();
    expect(errors[0]).toContain("row 0 (reg-1): no action");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("invariants prints each check and exits 2 when one fails", async () => {
    mocks.checkSettlementInvariants.mockResolvedValue({
      ok: false,
      checkedAt: "2026-09-26T00:00:00.000Z",
      eventId: "ev-1",
      checks: [
        { name: "status_vs_amounts", description: "status", violations: 3, samples: [{ id: "reg-1", problem: "PAID_BELOW_NET" }] },
        { name: "count_drift", description: "counts", violations: 0, samples: [] },
      ],
    });
    setArgv("invariants", "--event", "ev-1", "--limit", "1");
    await runScript();
    expect(mocks.checkSettlementInvariants).toHaveBeenCalledWith({ eventId: "ev-1", sampleLimit: 1 });
    expect(logs).toEqual([
      "Settlement invariants (event ev-1): FAILED",
      "status_vs_amounts: 3 (status)",
      '  {"id":"reg-1","problem":"PAID_BELOW_NET"}',
      "  … 2 more",
      "count_drift: 0 (counts)",
    ]);
    expect(mocks.closeDb).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("invariants exits 0 when every check passes", async () => {
    mocks.checkSettlementInvariants.mockResolvedValue({ ok: true, checkedAt: "x", eventId: null, checks: [] });
    setArgv("invariants", "--json");
    await runScript();
    expect(JSON.parse(logs[0])).toMatchObject({ ok: true });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it.each([
    [[]],
    [["--since", "not-a-date"]],
    [["--apply"]],
    [["--apply", "--manifest", "m.json", "--since", SINCE]],
    [["--manifest", "m.json", "--since", SINCE]],
    [["invariants", "--since", SINCE]],
    [["invariants", "--limit", "-1"]],
    [["repair"]],
    [["--bogus"]],
  ])("refuses %j before touching the database", async (args) => {
    setArgv(...args);
    await runScript();
    expect(mocks.configureDb).not.toHaveBeenCalled();
    expect(mocks.planPaidSettlementRepair).not.toHaveBeenCalled();
    expect(mocks.applyPaidRepairRow).not.toHaveBeenCalled();
    expect(existsSync("repair-manifest.json")).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
