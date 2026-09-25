import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The script runs main() on import and calls process.exit(): tests spy on
// process.exit and re-import it for each argv. The planner and the link
// itself are DB-tested in packages/db (sponsorship-code-repair.db.test.ts).

const mocks = vi.hoisted(() => ({
  planSponsorshipCodeRepair: vi.fn(),
  applySponsorshipCodeLink: vi.fn(),
  configureDb: vi.fn(),
  closeDb: vi.fn(),
}));
vi.mock("@app/db", () => mocks);

const ORIGINAL_ARGV = process.argv;

function setArgv(...args: string[]) {
  process.argv = [ORIGINAL_ARGV[0]!, ORIGINAL_ARGV[1]!, ...args];
}

function link(registrationId: string, overrides: Record<string, unknown> = {}) {
  return {
    eventId: "ev-1",
    code: `SP-${registrationId.toUpperCase()}`,
    sponsorshipId: `sp-${registrationId}`,
    registrationId,
    referenceNumber: "26-EV-001",
    before: { paymentStatus: "PENDING", paidAmount: 0, totalAmount: 200, sponsorshipAmount: 200, updatedAt: "2026-09-01T00:00:00.000Z" },
    after: { paymentStatus: "SPONSORED", sponsorshipAmount: 200, amountDue: 0 },
    paidPlaces: { "acc-1": 1 },
    fillsCapacity: [],
    ...overrides,
  };
}

const PLAN = {
  links: [link("reg-1"), link("reg-2")],
  decisions: [
    {
      reason: "SEVERAL_CLAIMANTS",
      eventId: "ev-1",
      code: "SP-SHARED",
      sponsorshipId: "sp-shared",
      registrationIds: ["reg-3", "reg-4"],
      detail: "stored by 2",
    },
  ],
  alreadyLinked: 1,
};

async function runScript() {
  vi.resetModules();
  await import("./repair-sponsorship-code-usages.js");
  await new Promise((r) => setTimeout(r, 10));
}

describe("repair-sponsorship-code-usages", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any;
  let logs: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    logs = [];
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.planSponsorshipCodeRepair.mockResolvedValue(PLAN);
    mocks.applySponsorshipCodeLink.mockImplementation(async (l: { registrationId: string }) => ({
      outcome: "linked",
      registrationId: l.registrationId,
      paymentStatus: "SPONSORED",
      sponsorshipAmount: 200,
    }));
    mocks.closeDb.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.argv = ORIGINAL_ARGV;
    vi.restoreAllMocks();
  });

  it("dry run by default: prints the links and the decision list, applies nothing", async () => {
    setArgv("--event", "ev-1");
    await runScript();
    expect(mocks.planSponsorshipCodeRepair).toHaveBeenCalledWith({ eventId: "ev-1" });
    expect(mocks.applySponsorshipCodeLink).not.toHaveBeenCalled();
    expect(logs[0]).toBe("Dry run: 2 link(s), 1 decision(s), 1 code(s) already linked.");
    expect(logs).toContainEqual(expect.stringContaining("decide reason=SEVERAL_CLAIMANTS event=ev-1 code=SP-SHARED"));
    expect(logs).toContainEqual(
      expect.stringContaining("link registration=reg-1 ref=26-EV-001 event=ev-1 code=SP-REG-1 status=PENDING->SPONSORED"),
    );
    expect(mocks.closeDb).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("--json prints the plan", async () => {
    setArgv("--json");
    await runScript();
    expect(JSON.parse(logs[0])).toEqual(PLAN);
    expect(mocks.applySponsorshipCodeLink).not.toHaveBeenCalled();
  });

  it("--apply --registration links only the listed rows and reports skips", async () => {
    mocks.applySponsorshipCodeLink.mockResolvedValueOnce({
      outcome: "skipped",
      registrationId: "reg-2",
      reason: "STALE",
      detail: "now SEVERAL_CLAIMANTS",
    });
    setArgv("--apply", "--confirm-2-8-deployed", "--registration", "reg-2", "--registration", "reg-9");
    await runScript();
    expect(mocks.applySponsorshipCodeLink).toHaveBeenCalledTimes(1);
    expect(mocks.applySponsorshipCodeLink).toHaveBeenCalledWith(PLAN.links[1]);
    expect(logs).toContain("not-planned registration=reg-9 (no single-claimant link for it now)");
    expect(logs).toContainEqual(expect.stringContaining("skipped registration=reg-2 reason=STALE"));
    expect(logs.at(-1)).toBe("Linked 0 of 1 planned link(s).");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("--apply --all links every planned row", async () => {
    setArgv("--apply", "--confirm-2-8-deployed", "--all");
    await runScript();
    expect(mocks.applySponsorshipCodeLink.mock.calls.map((c) => c[0].registrationId)).toEqual(["reg-1", "reg-2"]);
    expect(logs.at(-1)).toBe("Linked 2 of 2 planned link(s).");
  });

  it.each([
    [["--apply", "--all"]],
    [["--apply", "--confirm-2-8-deployed"]],
    [["--apply", "--confirm-2-8-deployed", "--all", "--registration", "reg-1"]],
    [["--all"]],
    [["--registration", "reg-1"]],
    [["--bogus"]],
  ])("refuses %j before touching the database", async (args) => {
    setArgv(...args);
    await runScript();
    expect(mocks.configureDb).not.toHaveBeenCalled();
    expect(mocks.planSponsorshipCodeRepair).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
