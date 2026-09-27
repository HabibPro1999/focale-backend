import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the entire db layer; the service owns orchestration + math, db fns are
// thin primitives (mocked here). withTxn runs the callback with a sentinel tx.
vi.mock("@app/db", async (importOriginal) => {
  // Derive mocks from real exports: query renames need no hand-maintained list,
  // while a typo still fails instead of creating a nonexistent query via Proxy.
  const actual = await importOriginal<Record<string, unknown>>();
  const mod = Object.fromEntries(Object.entries(actual).map(([name, value]) => [
    name, typeof value === "function" ? vi.fn() : value,
  ]));
  const TX = { __tx: true };
  mod.withTxn = vi.fn((fn: (tx: unknown) => unknown) => fn(TX));
  mod.withLockingTxn = vi.fn((fn: (tx: unknown) => unknown) => fn(TX));
  return mod;
});

import * as db from "@app/db";
import { SponsorshipsService } from "./sponsorships.service";
import type { AccessService } from "../access/access.service";

const m = db as unknown as Record<string, ReturnType<typeof vi.fn>>;

// AccessService is injected; the service only calls these two methods on it.
const access = {
  getAlreadyCoveredAccessIds: vi.fn(),
  syncPaidCountDelta: vi.fn(),
};

function service() {
  return new SponsorshipsService(access as unknown as AccessService);
}

// Gate-passing event/client defaults (assertEventWritable/assertModuleEnabledForClient).
const OK_EVENT = {
  clientId: "c1",
  status: "OPEN",
  client: { active: true, enabledModules: ["sponsorships"] },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.withTxn.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
  m.withLockingTxn.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
  // Neutral defaults so unrelated calls don't throw.
  access.getAlreadyCoveredAccessIds.mockResolvedValue(new Set());
  access.syncPaidCountDelta.mockResolvedValue(undefined);
  m.updateRegistrationSettlement.mockResolvedValue(undefined);
  m.updateSponsorshipRow.mockResolvedValue(undefined);
  m.updateUsageAmount.mockResolvedValue(undefined);
  m.deleteUsage.mockResolvedValue(undefined);
  m.deleteSponsorshipRow.mockResolvedValue(undefined);
});

// ============================================================================
// Passthrough reads
// ============================================================================

describe("passthrough reads", () => {
  it("getSponsorshipClientId", async () => {
    m.getSponsorshipClientId.mockResolvedValue("c1");
    expect(await service().getSponsorshipClientId("s1")).toBe("c1");
  });

  it("listSponsorships", async () => {
    const page = { data: [], meta: {}, stats: {} };
    m.listSponsorships.mockResolvedValue(page);
    expect(await service().listSponsorships("e1", {} as never)).toBe(page);
  });
});

// ============================================================================
// updateSponsorship
// ============================================================================

describe("updateSponsorship", () => {
  it("404 when not found", async () => {
    m.findSponsorshipForMutation.mockResolvedValue(null);
    await expect(
      service().updateSponsorship("s1", { beneficiaryName: "X" }),
    ).rejects.toMatchObject({ code: "RES_3001", statusCode: 404 });
  });

  it("simple beneficiary update writes only that field, returns re-fetched row", async () => {
    m.findSponsorshipForMutation.mockResolvedValue({
      id: "s1",
      eventId: "e1",
      coversBasePrice: true,
      coveredAccessIds: [],
      totalAmount: 100,
      usages: [],
      event: OK_EVENT,
    });
    const fresh = { id: "s1", beneficiaryName: "X" };
    m.getSponsorshipById.mockResolvedValue(fresh);

    const result = await service().updateSponsorship("s1", { beneficiaryName: "X" });

    expect(m.updateSponsorshipRow).toHaveBeenCalledWith({}, "s1", {
      beneficiaryName: "X",
    });
    expect(result).toBe(fresh);
  });

  it("coverage change recomputes totalAmount", async () => {
    m.findSponsorshipForMutation.mockResolvedValue({
      id: "s1",
      eventId: "e1",
      coversBasePrice: false,
      coveredAccessIds: [],
      totalAmount: 0,
      usages: [],
      event: OK_EVENT,
    });
    m.findActiveEventAccess.mockResolvedValue([
      { id: "a1", name: "A", type: "MEAL", groupLabel: null, startsAt: null, endsAt: null, price: 200 },
    ]);
    m.getSponsorshipEventPricing.mockResolvedValue({ basePrice: 100, currency: "TND" });
    m.getSponsorshipById.mockResolvedValue({ id: "s1" });

    await service().updateSponsorship("s1", {
      coversBasePrice: true,
      coveredAccessIds: ["a1"],
    });

    expect(m.updateSponsorshipRow).toHaveBeenCalledWith(
      {},
      "s1",
      expect.objectContaining({
        coversBasePrice: true,
        coveredAccessIds: ["a1"],
        totalAmount: 300,
      }),
    );
  });

  it("coverage change with usages runs recalculateUsageAmounts", async () => {
    m.findSponsorshipForMutation.mockResolvedValue({
      id: "s1",
      eventId: "e1",
      coversBasePrice: true,
      coveredAccessIds: ["a1"],
      totalAmount: 300,
      usages: [{ id: "u1", registrationId: "r1" }],
      event: OK_EVENT,
    });
    m.findActiveEventAccess.mockResolvedValue([
      { id: "a1", name: "A", type: "MEAL", groupLabel: null, startsAt: null, endsAt: null, price: 200 },
    ]);
    m.getSponsorshipEventPricing.mockResolvedValue({ basePrice: 100, currency: "TND" });
    m.findSponsorshipForRecalc.mockResolvedValue(recalcSponsorship({
      totalAmount: 300, baseAmount: 100, accessTypeIds: ["a1"],
      priceBreakdown: {
        calculatedBasePrice: 100, subtotal: 300,
        accessItems: [{ accessId: "a1", subtotal: 200 }],
      },
    }, { coveredAccessIds: ["a1"], totalAmount: 300 }));
    m.findUsageAmountsByRegistration.mockResolvedValue([{ amountApplied: 300 }]);
    m.getSponsorshipById.mockResolvedValue({ id: "s1" });

    await service().updateSponsorship("s1", { coveredAccessIds: ["a1"] });

    const call = m.updateRegistrationSettlement.mock.calls[0][2] as Record<string, unknown>;
    expect(call).toMatchObject({
      sponsorshipAmount: 300,
      paymentStatus: "SPONSORED",
    });
    expect((call.priceBreakdown as Record<string, unknown>).sponsorshipTotal).toBe(300);
    expect((call.priceBreakdown as Record<string, unknown>).total).toBe(0);
  });

  it('status:"CANCELLED" delegates to cancel', async () => {
    m.findSponsorshipForMutation.mockResolvedValue({
      id: "s1",
      eventId: "e1",
      status: "PENDING",
      usages: [],
      event: OK_EVENT,
    });
    m.getSponsorshipById.mockResolvedValue({ id: "s1", status: "CANCELLED" });

    const result = await service().updateSponsorship("s1", { status: "CANCELLED" });

    expect(m.updateSponsorshipRow).toHaveBeenCalledWith({}, "s1", {
      status: "CANCELLED",
    });
    expect((result as { status: string }).status).toBe("CANCELLED");
  });
});

// ============================================================================
// cancelSponsorship
// ============================================================================

describe("cancelSponsorship", () => {
  it("no usages → status set CANCELLED, no unlink", async () => {
    m.findSponsorshipForMutation.mockResolvedValue({
      id: "s1",
      eventId: "e1",
      status: "PENDING",
      usages: [],
      event: OK_EVENT,
    });
    m.getSponsorshipById.mockResolvedValue({ id: "s1", status: "CANCELLED" });

    await service().cancelSponsorship("s1");

    expect(m.findUsage).not.toHaveBeenCalled();
    expect(m.updateSponsorshipRow).toHaveBeenCalledWith({}, "s1", {
      status: "CANCELLED",
    });
  });

  it("with usages → unlinks (deleteUsage) then cancels", async () => {
    m.findSponsorshipForMutation.mockResolvedValue({
      id: "s1",
      eventId: "e1",
      status: "USED",
      usages: [{ id: "u1", registrationId: "r1" }],
      event: OK_EVENT,
    });
    m.findUsage.mockResolvedValue({ id: "u1", amountApplied: 100 });
    m.findRegistrationSettlementState.mockResolvedValue({
      sponsorshipAmount: 100,
      paidAmount: 0,
      paymentMethod: "LAB_SPONSORSHIP",
      paymentStatus: "PENDING",
      eventId: "e1",
      totalAmount: 500,
      priceBreakdown: {},
    });
    m.findSponsorshipUnlinkState.mockResolvedValue({
      status: "USED",
      coveredAccessIds: [],
      event: { status: "OPEN", client: { active: true, enabledModules: ["sponsorships"] } },
    });
    m.findUsageAmountsByRegistration.mockResolvedValue([]);
    m.countUsagesForSponsorship.mockResolvedValue(0);
    m.getSponsorshipById.mockResolvedValue({ id: "s1", status: "CANCELLED" });

    await service().cancelSponsorship("s1");

    expect(m.deleteUsage).toHaveBeenCalledWith({}, "u1");
    expect(m.updateSponsorshipRow).toHaveBeenCalledWith({}, "s1", {
      status: "CANCELLED",
    });
  });

  it("404 when not found", async () => {
    m.findSponsorshipForMutation.mockResolvedValue(null);
    await expect(service().cancelSponsorship("s1")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

// ============================================================================
// deleteSponsorship
// ============================================================================

describe("deleteSponsorship", () => {
  it("no usages → deletes row", async () => {
    m.findSponsorshipForMutation.mockResolvedValue({
      id: "s1",
      eventId: "e1",
      status: "PENDING",
      usages: [],
      event: OK_EVENT,
    });
    await expect(service().deleteSponsorship("s1")).resolves.toBeUndefined();
    expect(m.deleteSponsorshipRow).toHaveBeenCalledWith({}, "s1");
  });

  it("with usages → unlink then delete", async () => {
    m.findSponsorshipForMutation.mockResolvedValue({
      id: "s1",
      eventId: "e1",
      status: "USED",
      usages: [{ id: "u1", registrationId: "r1" }],
      event: OK_EVENT,
    });
    m.findUsage.mockResolvedValue({ id: "u1", amountApplied: 100 });
    m.findRegistrationSettlementState.mockResolvedValue({
      sponsorshipAmount: 100,
      paidAmount: 0,
      paymentMethod: null,
      paymentStatus: "PENDING",
      eventId: "e1",
      totalAmount: 500,
      priceBreakdown: {},
    });
    m.findSponsorshipUnlinkState.mockResolvedValue({
      status: "USED",
      coveredAccessIds: [],
      event: { status: "OPEN", client: { active: true, enabledModules: ["sponsorships"] } },
    });
    m.findUsageAmountsByRegistration.mockResolvedValue([]);
    m.countUsagesForSponsorship.mockResolvedValue(0);

    await service().deleteSponsorship("s1");

    expect(m.deleteUsage).toHaveBeenCalled();
    expect(m.deleteSponsorshipRow).toHaveBeenCalledWith({}, "s1");
  });

  it("404 when not found", async () => {
    m.findSponsorshipForMutation.mockResolvedValue(null);
    await expect(service().deleteSponsorship("s1")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

// ============================================================================
// linkSponsorshipToRegistration
// ============================================================================

function linkSponsorship(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    eventId: "e1",
    status: "PENDING",
    coversBasePrice: true,
    coveredAccessIds: [],
    totalAmount: 200,
    beneficiaryName: "Lab",
    event: {
      clientId: "c1",
      name: "Ev",
      slug: "ev",
      startDate: new Date(),
      location: null,
      status: "OPEN",
      client: { active: true, enabledModules: ["sponsorships"], name: "Client" },
    },
    batch: { labName: "Lab", contactName: "C", email: "l@x.com" },
    ...overrides,
  };
}

function linkRegistration(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    email: "r@x.com",
    firstName: "R",
    lastName: null,
    phone: null,
    eventId: "e1",
    totalAmount: 500,
    paidAmount: 0,
    baseAmount: 200,
    linkBaseUrl: null,
    editToken: null,
    accessTypeIds: [],
    priceBreakdown: { calculatedBasePrice: 200, accessItems: [] },
    paymentStatus: "PENDING",
    sponsorshipAmount: 0,
    existingUsages: [],
    ...overrides,
  };
}

function recalcSponsorship(
  registration: Record<string, unknown>,
  sponsorship: Record<string, unknown> = {},
) {
  return {
    coversBasePrice: true, coveredAccessIds: [], totalAmount: 100,
    usages: [{ id: "u1", registration: linkRegistration({ paidAt: null, ...registration }) }],
    ...sponsorship,
  };
}

describe("linkSponsorshipToRegistration", () => {
  it("happy path (partial) — exact registration settlement args + result", async () => {
    m.findSponsorshipForLink.mockResolvedValue(linkSponsorship());
    m.findRegistrationForLink.mockResolvedValue(linkRegistration());
    m.findUsage.mockResolvedValue(null);
    m.insertUsage.mockResolvedValue({ id: "u1", sponsorshipId: "s1", amountApplied: 200 });
    m.casSetSponsorshipUsed.mockResolvedValue(1);
    m.findUsageAmountsByRegistration.mockResolvedValue([{ amountApplied: 200 }]);

    const result = await service().linkSponsorshipToRegistration("s1", "r1", "admin");

    expect(m.updateRegistrationSettlement.mock.calls[0][2]).toEqual({
      sponsorshipAmount: 200,
      paymentMethod: "LAB_SPONSORSHIP",
      paymentStatus: "PARTIAL",
    });
    expect(result).toEqual({
      usage: { id: "u1", sponsorshipId: "s1", amountApplied: 200 },
      registration: { totalAmount: 500, sponsorshipAmount: 200, amountDue: 300 },
      warnings: [],
    });
  });

  it("full coverage → SPONSORED with paidAt", async () => {
    m.findSponsorshipForLink.mockResolvedValue(linkSponsorship());
    m.findRegistrationForLink.mockResolvedValue(linkRegistration({ totalAmount: 200 }));
    m.findUsage.mockResolvedValue(null);
    m.insertUsage.mockResolvedValue({ id: "u1", sponsorshipId: "s1", amountApplied: 200 });
    m.casSetSponsorshipUsed.mockResolvedValue(1);
    m.findUsageAmountsByRegistration.mockResolvedValue([{ amountApplied: 200 }]);

    await service().linkSponsorshipToRegistration("s1", "r1", "admin");

    const call = m.updateRegistrationSettlement.mock.calls[0][2] as Record<string, unknown>;
    expect(call.paymentStatus).toBe("SPONSORED");
    expect(call.paidAt).toBeInstanceOf(Date);
  });

  it("404 sponsorship not found", async () => {
    m.findSponsorshipForLink.mockResolvedValue(null);
    await expect(
      service().linkSponsorshipToRegistration("s1", "r1", "admin"),
    ).rejects.toMatchObject({ code: "RES_3001", statusCode: 404 });
  });

  it("400 cancelled sponsorship", async () => {
    m.findSponsorshipForLink.mockResolvedValue(linkSponsorship({ status: "CANCELLED" }));
    await expect(
      service().linkSponsorshipToRegistration("s1", "r1", "admin"),
    ).rejects.toMatchObject({ code: "RES_3003", statusCode: 400 });
  });

  it("404 registration not found", async () => {
    m.findSponsorshipForLink.mockResolvedValue(linkSponsorship());
    m.findRegistrationForLink.mockResolvedValue(null);
    await expect(
      service().linkSponsorshipToRegistration("s1", "r1", "admin"),
    ).rejects.toMatchObject({ code: "REG_8001", statusCode: 404 });
  });

  it("400 different events", async () => {
    m.findSponsorshipForLink.mockResolvedValue(linkSponsorship());
    m.findRegistrationForLink.mockResolvedValue(linkRegistration({ eventId: "e2" }));
    await expect(
      service().linkSponsorshipToRegistration("s1", "r1", "admin"),
    ).rejects.toMatchObject({ code: "RES_3003", statusCode: 400 });
  });

  it("409 already linked", async () => {
    m.findSponsorshipForLink.mockResolvedValue(linkSponsorship());
    m.findRegistrationForLink.mockResolvedValue(linkRegistration());
    m.findUsage.mockResolvedValue({ id: "u0" });
    await expect(
      service().linkSponsorshipToRegistration("s1", "r1", "admin"),
    ).rejects.toMatchObject({ code: "RES_3002", statusCode: 409 });
  });

  it("400 coverage does not apply (applicable 0, totalAmount > 0)", async () => {
    m.findSponsorshipForLink.mockResolvedValue(
      linkSponsorship({ coversBasePrice: false, coveredAccessIds: ["x"], totalAmount: 100 }),
    );
    m.findRegistrationForLink.mockResolvedValue(linkRegistration());
    m.findUsage.mockResolvedValue(null);
    await expect(
      service().linkSponsorshipToRegistration("s1", "r1", "admin"),
    ).rejects.toMatchObject({ code: "SPO_14001", statusCode: 400 });
  });

  it("409 status conflict when CAS returns 0", async () => {
    m.findSponsorshipForLink.mockResolvedValue(linkSponsorship());
    m.findRegistrationForLink.mockResolvedValue(linkRegistration());
    m.findUsage.mockResolvedValue(null);
    m.insertUsage.mockResolvedValue({ id: "u1", sponsorshipId: "s1", amountApplied: 200 });
    m.casSetSponsorshipUsed.mockResolvedValue(0);
    await expect(
      service().linkSponsorshipToRegistration("s1", "r1", "admin"),
    ).rejects.toMatchObject({ code: "SPO_14002", statusCode: 409 });
  });

  it("overlap warning is advisory — link still succeeds", async () => {
    m.findSponsorshipForLink.mockResolvedValue(linkSponsorship());
    m.findRegistrationForLink.mockResolvedValue(
      linkRegistration({
        existingUsages: [
          { sponsorshipId: "sX", sponsorship: { code: "SP-X", coversBasePrice: true, coveredAccessIds: [] } },
        ],
      }),
    );
    m.findUsage.mockResolvedValue(null);
    m.insertUsage.mockResolvedValue({ id: "u1", sponsorshipId: "s1", amountApplied: 200 });
    m.casSetSponsorshipUsed.mockResolvedValue(1);
    m.findUsageAmountsByRegistration.mockResolvedValue([{ amountApplied: 200 }]);

    const result = await service().linkSponsorshipToRegistration("s1", "r1", "admin");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Base price is already covered");
  });
});

// ============================================================================
// linkSponsorshipByCode
// ============================================================================

describe("linkSponsorshipByCode", () => {
  it("happy path resolves by code then links", async () => {
    m.getRegistrationForSponsorship.mockResolvedValue({ id: "r1", event: { id: "e1", clientId: "c1" } });
    m.getSponsorshipByCode.mockResolvedValue({ id: "s1" });
    m.findSponsorshipForLink.mockResolvedValue(linkSponsorship());
    m.findRegistrationForLink.mockResolvedValue(linkRegistration());
    m.findUsage.mockResolvedValue(null);
    m.insertUsage.mockResolvedValue({ id: "u1", sponsorshipId: "s1", amountApplied: 200 });
    m.casSetSponsorshipUsed.mockResolvedValue(1);
    m.findUsageAmountsByRegistration.mockResolvedValue([{ amountApplied: 200 }]);

    const result = await service().linkSponsorshipByCode("r1", "SP-ABCD", "admin");
    expect(m.getSponsorshipByCode).toHaveBeenCalledWith("e1", "SP-ABCD");
    expect(result.usage.id).toBe("u1");
  });

  it("404 registration not found", async () => {
    m.getRegistrationForSponsorship.mockResolvedValue(null);
    await expect(
      service().linkSponsorshipByCode("r1", "SP-ABCD", "admin"),
    ).rejects.toMatchObject({ code: "REG_8001", statusCode: 404 });
  });

  it("404 code not found for event", async () => {
    m.getRegistrationForSponsorship.mockResolvedValue({ id: "r1", event: { id: "e1", clientId: "c1" } });
    m.getSponsorshipByCode.mockResolvedValue(null);
    await expect(
      service().linkSponsorshipByCode("r1", "SP-ABCD", "admin"),
    ).rejects.toMatchObject({ code: "RES_3001", statusCode: 404, details: { code: "SPONSORSHIP_NOT_FOUND" } });
  });
});

// ============================================================================
// unlinkSponsorshipFromRegistration
// ============================================================================

describe("unlinkSponsorshipFromRegistration", () => {
  it("no remaining → settlement exactly {sponsorshipAmount:0, paymentMethod:null}, sponsorship→PENDING", async () => {
    m.findUsage.mockResolvedValue({ id: "u1", amountApplied: 100 });
    m.findRegistrationSettlementState.mockResolvedValue({
      sponsorshipAmount: 100,
      paidAmount: 0,
      paymentMethod: "LAB_SPONSORSHIP",
      paymentStatus: "PENDING",
      eventId: "e1",
      totalAmount: 500,
      priceBreakdown: {},
    });
    m.findSponsorshipUnlinkState.mockResolvedValue({
      status: "USED",
      coveredAccessIds: [],
      event: { status: "OPEN", client: { active: true, enabledModules: ["sponsorships"] } },
    });
    m.findUsageAmountsByRegistration.mockResolvedValue([]);
    m.countUsagesForSponsorship.mockResolvedValue(0);

    await service().unlinkSponsorshipFromRegistration("s1", "r1");

    expect(m.updateRegistrationSettlement.mock.calls[0][2]).toEqual({
      sponsorshipAmount: 0,
      paymentMethod: null,
    });
    expect(m.updateSponsorshipRow).toHaveBeenCalledWith({}, "s1", { status: "PENDING" });
  });

  it("others remaining → settlement exactly {sponsorshipAmount:150}", async () => {
    m.findUsage.mockResolvedValue({ id: "u1", amountApplied: 100 });
    m.findRegistrationSettlementState.mockResolvedValue({
      sponsorshipAmount: 250,
      paidAmount: 0,
      paymentMethod: "LAB_SPONSORSHIP",
      paymentStatus: "PENDING",
      eventId: "e1",
      totalAmount: 500,
      priceBreakdown: {},
    });
    m.findSponsorshipUnlinkState.mockResolvedValue({
      status: "USED",
      coveredAccessIds: [],
      event: { status: "OPEN", client: { active: true, enabledModules: ["sponsorships"] } },
    });
    m.findUsageAmountsByRegistration.mockResolvedValue([{ amountApplied: 150 }]);
    m.countUsagesForSponsorship.mockResolvedValue(1);

    await service().unlinkSponsorshipFromRegistration("s1", "r1");

    expect(m.updateRegistrationSettlement.mock.calls[0][2]).toEqual({
      sponsorshipAmount: 150,
    });
  });

  it("404 when link not found", async () => {
    m.findUsage.mockResolvedValue(null);
    await expect(
      service().unlinkSponsorshipFromRegistration("s1", "r1"),
    ).rejects.toMatchObject({ code: "RES_3001", statusCode: 404 });
  });
});

// ============================================================================
// getAvailableSponsorships
// ============================================================================

describe("getAvailableSponsorships", () => {
  const coverage = {
    id: "r1",
    eventId: "e1",
    totalAmount: 500,
    baseAmount: 100,
    accessTypeIds: ["a1"],
    priceBreakdown: { calculatedBasePrice: 100, accessItems: [{ accessId: "a1", subtotal: 200 }] },
    existingUsages: [],
  };

  it("computes applicable amounts (0 for non-overlapping, >0 for overlapping)", async () => {
    m.getRegistrationCoverage.mockResolvedValue(coverage);
    m.getPendingSponsorships.mockResolvedValue([
      { id: "s1", code: "SP-1", beneficiaryName: "A", beneficiaryEmail: "a@x", totalAmount: 200, coversBasePrice: false, coveredAccessIds: ["a1"], batch: { labName: "L" } },
      { id: "s2", code: "SP-2", beneficiaryName: "B", beneficiaryEmail: "b@x", totalAmount: 200, coversBasePrice: false, coveredAccessIds: ["zzz"], batch: { labName: "L" } },
    ]);

    const result = await service().getAvailableSponsorships("e1", "r1");
    expect(result[0].applicableAmount).toBe(200);
    expect(result[1].applicableAmount).toBe(0);
  });

  it("populates conflicts against existing linked coverage", async () => {
    m.getRegistrationCoverage.mockResolvedValue({
      ...coverage,
      existingUsages: [
        { sponsorshipId: "sX", sponsorship: { code: "SP-X", coversBasePrice: true, coveredAccessIds: [] } },
      ],
    });
    m.getPendingSponsorships.mockResolvedValue([
      { id: "s1", code: "SP-1", beneficiaryName: "A", beneficiaryEmail: "a@x", totalAmount: 100, coversBasePrice: true, coveredAccessIds: [], batch: { labName: "L" } },
    ]);

    const result = await service().getAvailableSponsorships("e1", "r1");
    expect(result[0].conflicts).toHaveLength(1);
  });

  it("404 registration not found", async () => {
    m.getRegistrationCoverage.mockResolvedValue(null);
    await expect(service().getAvailableSponsorships("e1", "r1")).rejects.toMatchObject({
      code: "REG_8001",
      statusCode: 404,
    });
  });

  it("400 registration/event mismatch", async () => {
    m.getRegistrationCoverage.mockResolvedValue({ ...coverage, eventId: "eOTHER" });
    await expect(service().getAvailableSponsorships("e1", "r1")).rejects.toMatchObject({
      code: "RES_3003",
      statusCode: 400,
    });
  });
});

// ============================================================================
// createSponsorshipBatch
// ============================================================================

const SPONSOR = { labName: "Lab", contactName: "Contact", email: "l@x.com" };

function batchEvent() {
  return {
    id: "e1",
    name: "Ev",
    slug: "ev",
    status: "OPEN",
    startDate: new Date(),
    location: null,
    clientId: "c1",
    client: { active: true, enabledModules: ["sponsorships"], name: "Client" },
  };
}

// insertSponsorship rows feed the batch/linked email contexts, so the mocked
// return values must carry the fields those builders read.
function createdSponsorship(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    code: "SP-1",
    beneficiaryName: "Ben",
    beneficiaryEmail: "b@x.com",
    coversBasePrice: true,
    coveredAccessIds: [],
    totalAmount: 100,
    ...overrides,
  };
}

describe("createSponsorshipBatch", () => {
  it("CODE mode happy path → batchId + count", async () => {
    m.findEventForBatch.mockResolvedValue(batchEvent());
    m.findSponsorFormById.mockResolvedValue({ id: "f1", schema: { sponsorshipSettings: { sponsorshipMode: "CODE" } } });
    m.getSponsorshipEventPricing.mockResolvedValue({ basePrice: 100, currency: "TND" });
    m.insertSponsorshipBatch.mockResolvedValue({ id: "b1" });
    m.getFormSchema.mockResolvedValue({ sponsorshipSettings: { autoApproveSponsorship: false } });
    m.sponsorshipCodeExists.mockResolvedValue(false);
    m.insertSponsorship.mockResolvedValue(createdSponsorship());

    const result = await service().createSponsorshipBatch("e1", "f1", {
      sponsor: SPONSOR,
      beneficiaries: [{ name: "Ben", email: "b@x.com", coversBasePrice: true, coveredAccessIds: [] }],
    });

    expect(result).toEqual({ batchId: "b1", count: 1 });
    expect(m.insertSponsorship).toHaveBeenCalledTimes(1);
  });

  it("CODE mode counts every beneficiary (loop, not just first)", async () => {
    m.findEventForBatch.mockResolvedValue(batchEvent());
    m.findSponsorFormById.mockResolvedValue({ id: "f1", schema: {} });
    m.getSponsorshipEventPricing.mockResolvedValue({ basePrice: 100, currency: "TND" });
    m.insertSponsorshipBatch.mockResolvedValue({ id: "b1" });
    m.getFormSchema.mockResolvedValue({});
    m.sponsorshipCodeExists.mockResolvedValue(false);
    m.insertSponsorship.mockResolvedValue(createdSponsorship());

    const result = await service().createSponsorshipBatch("e1", "f1", {
      sponsor: SPONSOR,
      beneficiaries: [
        { name: "B1", email: "b1@x.com", coversBasePrice: true, coveredAccessIds: [] },
        { name: "B2", email: "b2@x.com", coversBasePrice: true, coveredAccessIds: [] },
      ],
    });
    expect(result.count).toBe(2);
  });

  it("event not found → 404", async () => {
    m.findEventForBatch.mockResolvedValue(null);
    await expect(
      service().createSponsorshipBatch("e1", "f1", {
        sponsor: SPONSOR,
        beneficiaries: [{ name: "B", email: "b@x.com", coversBasePrice: true, coveredAccessIds: [] }],
      }),
    ).rejects.toMatchObject({ code: "RES_3001", statusCode: 404 });
  });

  it("sponsor form not found → 404", async () => {
    m.findEventForBatch.mockResolvedValue(batchEvent());
    m.findSponsorFormById.mockResolvedValue(null);
    await expect(
      service().createSponsorshipBatch("e1", "f1", {
        sponsor: SPONSOR,
        beneficiaries: [{ name: "B", email: "b@x.com", coversBasePrice: true, coveredAccessIds: [] }],
      }),
    ).rejects.toMatchObject({ code: "RES_3001", statusCode: 404 });
  });

  it("invalid access ids → 400 BAD_REQUEST", async () => {
    m.findEventForBatch.mockResolvedValue(batchEvent());
    m.findSponsorFormById.mockResolvedValue({ id: "f1", schema: {} });
    m.getSponsorshipEventPricing.mockResolvedValue({ basePrice: 100, currency: "TND" });
    m.findActiveEventAccess.mockResolvedValue([]); // none valid

    await expect(
      service().createSponsorshipBatch("e1", "f1", {
        sponsor: SPONSOR,
        beneficiaries: [{ name: "B", email: "b@x.com", coversBasePrice: false, coveredAccessIds: ["bad"] }],
      }),
    ).rejects.toMatchObject({ code: "RES_3003", statusCode: 400 });
  });

  it("linked mode, no auto-approve → PENDING sponsorship, no usage/registration mutation", async () => {
    m.findEventForBatch.mockResolvedValue(batchEvent());
    m.findSponsorFormById.mockResolvedValue({ id: "f1", schema: { sponsorshipSettings: { sponsorshipMode: "LINKED_ACCOUNT" } } });
    m.getSponsorshipEventPricing.mockResolvedValue({ basePrice: 100, currency: "TND" });
    m.findRegistrationsForBatch.mockResolvedValue([
      { id: "r1", email: "r@x.com", firstName: "R", lastName: null, phone: null, totalAmount: 500, sponsorshipAmount: 0, baseAmount: 100, accessTypeIds: [], priceBreakdown: {}, paymentStatus: "PENDING", linkBaseUrl: null, editToken: null },
    ]);
    m.insertSponsorshipBatch.mockResolvedValue({ id: "b1" });
    m.getFormSchema.mockResolvedValue({ sponsorshipSettings: { autoApproveSponsorship: false } });
    m.sponsorshipCodeExists.mockResolvedValue(false);
    m.insertSponsorship.mockResolvedValue(createdSponsorship());

    const result = await service().createSponsorshipBatch("e1", "f1", {
      sponsor: SPONSOR,
      linkedBeneficiaries: [{ registrationId: "r1", coversBasePrice: true, coveredAccessIds: [] }],
    });

    expect(result.count).toBe(1);
    expect(m.insertSponsorship.mock.calls[0][1]).toMatchObject({
      status: "PENDING",
      targetRegistrationId: "r1",
    });
    expect(m.insertUsage).not.toHaveBeenCalled();
    expect(m.updateRegistrationSettlement).not.toHaveBeenCalled();
  });

  it("linked mode, auto-approve → USED sponsorship + usage + registration update", async () => {
    m.findEventForBatch.mockResolvedValue(batchEvent());
    m.findSponsorFormById.mockResolvedValue({ id: "f1", schema: { sponsorshipSettings: { sponsorshipMode: "LINKED_ACCOUNT" } } });
    m.getSponsorshipEventPricing.mockResolvedValue({ basePrice: 100, currency: "TND" });
    m.findRegistrationsForBatch.mockResolvedValue([
      { id: "r1", email: "r@x.com", firstName: "R", lastName: null, phone: null, totalAmount: 100, sponsorshipAmount: 0, baseAmount: 100, accessTypeIds: [], priceBreakdown: { calculatedBasePrice: 100, accessItems: [] }, paymentStatus: "PENDING", linkBaseUrl: null, editToken: null },
    ]);
    m.insertSponsorshipBatch.mockResolvedValue({ id: "b1" });
    m.getFormSchema.mockResolvedValue({ sponsorshipSettings: { autoApproveSponsorship: true } });
    m.sponsorshipCodeExists.mockResolvedValue(false);
    m.insertSponsorship.mockResolvedValue(createdSponsorship());

    const result = await service().createSponsorshipBatch("e1", "f1", {
      sponsor: SPONSOR,
      linkedBeneficiaries: [{ registrationId: "r1", coversBasePrice: true, coveredAccessIds: [] }],
    });

    expect(result.count).toBe(1);
    expect(m.insertSponsorship.mock.calls[0][1]).toMatchObject({ status: "USED" });
    expect(m.insertUsage).toHaveBeenCalled();
    expect(m.updateRegistrationSettlement).toHaveBeenCalled();
  });

  it("linked mode, registration missing → 404", async () => {
    m.findEventForBatch.mockResolvedValue(batchEvent());
    m.findSponsorFormById.mockResolvedValue({ id: "f1", schema: { sponsorshipSettings: { sponsorshipMode: "LINKED_ACCOUNT" } } });
    m.getSponsorshipEventPricing.mockResolvedValue({ basePrice: 100, currency: "TND" });
    m.findRegistrationsForBatch.mockResolvedValue([]); // none found

    await expect(
      service().createSponsorshipBatch("e1", "f1", {
        sponsor: SPONSOR,
        linkedBeneficiaries: [{ registrationId: "r1", coversBasePrice: true, coveredAccessIds: [] }],
      }),
    ).rejects.toMatchObject({ code: "RES_3001", statusCode: 404 });
  });
});

// These tables deliberately preserve the different rules at each settlement site.
// Exercise public workflows so later helper extraction must retain patch omissions,
// transaction orchestration, and the caller's paidAt/paymentMethod behavior.
describe("settlement truth tables", () => {
  const NOW = new Date("2026-09-27T12:00:00.000Z");
  const OLD_PAID_AT = new Date("2026-01-01T00:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    m.findActiveEventAccess.mockResolvedValue([]);
    m.getSponsorshipEventPricing.mockResolvedValue({ basePrice: 100, currency: "TND" });
  });
  afterEach(() => vi.useRealTimers());

  // current, gross total, sponsorship amount, next status, paidAt patch.
  it.each([
    ["PENDING", 100, 0, "PENDING", "omit"],
    ["PENDING", 100, 40, "PARTIAL", "omit"],
    ["PENDING", 100, 100, "SPONSORED", "new"],
    ["PARTIAL", 100, 0, "PARTIAL", "omit"],
    ["PARTIAL", 100, 40, "PARTIAL", "omit"],
    ["PARTIAL", 100, 100, "SPONSORED", "new"],
    ["SPONSORED", 100, 0, "SPONSORED", "new"],
    ["SPONSORED", 100, 40, "PARTIAL", "omit"],
    ["SPONSORED", 100, 100, "SPONSORED", "new"],
    ["PAID", 100, 0, "PAID", "omit"],
    ["PAID", 100, 40, "PAID", "omit"],
    ["PAID", 100, 100, "PAID", "omit"],
    ["WAIVED", 100, 0, "WAIVED", "omit"],
    ["WAIVED", 100, 40, "WAIVED", "omit"],
    ["WAIVED", 100, 100, "WAIVED", "omit"],
    ["REFUNDED", 100, 0, "REFUNDED", "omit"],
    ["REFUNDED", 100, 40, "PARTIAL", "omit"],
    ["REFUNDED", 100, 100, "SPONSORED", "new"],
    ["VERIFYING", 100, 0, "VERIFYING", "omit"],
    ["VERIFYING", 100, 40, "PARTIAL", "omit"],
    ["VERIFYING", 100, 100, "SPONSORED", "new"],
    ["PENDING", 0, 0, "SPONSORED", "new"],
    ["REFUNDED", 0, 0, "SPONSORED", "new"],
    ["VERIFYING", 0, 0, "SPONSORED", "new"],
    ["PAID", 0, 0, "PAID", "omit"],
    ["WAIVED", 0, 0, "WAIVED", "omit"],
  ] as const)(
    "apply: %s, total=%i, sponsored=%i → %s (paidAt=%s)",
    async (current, total, amount, next, paidAt) => {
      m.findSponsorshipForLink.mockResolvedValue(linkSponsorship({ totalAmount: amount }));
      m.findRegistrationForLink.mockResolvedValue(linkRegistration({
        paymentStatus: current, totalAmount: total, baseAmount: total,
        paidAt: OLD_PAID_AT, paymentMethod: "BANK_TRANSFER",
        priceBreakdown: { calculatedBasePrice: total, accessItems: [] },
      }));
      m.findUsage.mockResolvedValue(null);
      m.insertUsage.mockResolvedValue({ id: "u1", sponsorshipId: "s1", amountApplied: amount });
      m.casSetSponsorshipUsed.mockResolvedValue(1);
      m.findUsageAmountsByRegistration.mockResolvedValue([{ amountApplied: amount }]);

      await service().linkSponsorshipToRegistration("s1", "r1", "admin");

      expect(m.updateRegistrationSettlement).toHaveBeenCalledExactlyOnceWith({}, "r1", {
        sponsorshipAmount: amount,
        paymentStatus: next,
        paymentMethod: "LAB_SPONSORSHIP",
        ...(paidAt === "new" ? { paidAt: NOW } : {}),
      });
    },
  );

  it("batch apply: zero total is fully sponsored, even with a positive sponsorship price", async () => {
    m.findEventForBatch.mockResolvedValue(batchEvent());
    m.findSponsorFormById.mockResolvedValue({
      id: "f1", schema: { sponsorshipSettings: { sponsorshipMode: "LINKED_ACCOUNT" } },
    });
    m.findRegistrationsForBatch.mockResolvedValue([linkRegistration({
      paymentStatus: "VERIFYING", totalAmount: 0, baseAmount: 0,
      paidAt: OLD_PAID_AT, paymentMethod: "BANK_TRANSFER",
      priceBreakdown: { calculatedBasePrice: 0, accessItems: [] },
    })]);
    m.insertSponsorshipBatch.mockResolvedValue({ id: "b1" });
    m.getFormSchema.mockResolvedValue({ sponsorshipSettings: { autoApproveSponsorship: true } });
    m.sponsorshipCodeExists.mockResolvedValue(false);
    m.insertSponsorship.mockResolvedValue(createdSponsorship());

    await service().createSponsorshipBatch("e1", "f1", {
      sponsor: SPONSOR,
      linkedBeneficiaries: [{ registrationId: "r1", coversBasePrice: true, coveredAccessIds: [] }],
    });

    expect(m.updateRegistrationSettlement).toHaveBeenCalledExactlyOnceWith({}, "r1", {
      sponsorshipAmount: 0, paymentStatus: "SPONSORED",
      paymentMethod: "LAB_SPONSORSHIP", paidAt: NOW,
    });
  });

  // current, gross total, paid amount, remaining sponsorship, next status patch.
  // Only SPONSORED/PARTIAL can change. Omission also preserves the old paidAt.
  it.each([
    ["PENDING", 100, 0, 0, undefined],
    ["PENDING", 100, 0, 40, undefined],
    ["PAID", 100, 100, 0, undefined],
    ["WAIVED", 100, 0, 0, undefined],
    ["REFUNDED", 100, 0, 0, undefined],
    ["REFUNDED", 100, 0, 40, undefined],
    ["VERIFYING", 100, 0, 0, undefined],
    ["VERIFYING", 100, 0, 40, undefined],
    ["SPONSORED", 100, 0, 100, undefined],
    ["SPONSORED", 100, 0, 40, "PARTIAL"],
    ["SPONSORED", 100, 0, 0, "PENDING"],
    ["SPONSORED", 100, 20, 0, "PARTIAL"],
    ["SPONSORED", 100, 60, 40, "PARTIAL"],
    ["PARTIAL", 100, 0, 40, undefined],
    ["PARTIAL", 100, 0, 100, undefined],
    ["PARTIAL", 100, 0, 0, "PENDING"],
    ["PARTIAL", 100, 20, 0, "PARTIAL"],
    ["SPONSORED", 0, 0, 0, undefined],
    ["PARTIAL", 0, 0, 0, "PENDING"],
    ["REFUNDED", 0, 0, 0, undefined],
    ["VERIFYING", 0, 0, 0, undefined],
  ] as const)(
    "unlink: %s, total=%i, paid=%i, sponsored=%i → %s",
    async (current, total, paid, amount, next) => {
      m.findUsage.mockResolvedValue({ id: "u1" });
      m.findRegistrationSettlementState.mockResolvedValue({
        id: "r1", eventId: "e1", paymentStatus: current, totalAmount: total,
        paidAmount: paid, paidAt: OLD_PAID_AT, paymentMethod: "LAB_SPONSORSHIP",
        priceBreakdown: {},
      });
      m.findSponsorshipUnlinkState.mockResolvedValue({ status: "USED", event: OK_EVENT });
      m.findUsageAmountsByRegistration.mockResolvedValue([{ amountApplied: amount }]);
      m.countUsagesForSponsorship.mockResolvedValue(0);

      await service().unlinkSponsorshipFromRegistration("s1", "r1");

      expect(m.updateRegistrationSettlement).toHaveBeenCalledExactlyOnceWith({}, "r1", {
        sponsorshipAmount: amount,
        ...(amount === 0 ? { paymentMethod: null } : {}),
        ...(next !== undefined ? {
          paymentStatus: next, ...(paid === 0 ? { paidAt: null } : {}),
        } : {}),
      });
    },
  );

  // current, gross total, paid, sponsorship, old paidAt, next status, next paidAt.
  it.each([
    ["PAID", 100, 100, 0, OLD_PAID_AT, "PAID", OLD_PAID_AT],
    ["PAID", 100, 0, 100, null, "PAID", null],
    ["WAIVED", 100, 0, 0, OLD_PAID_AT, "WAIVED", OLD_PAID_AT],
    ["REFUNDED", 100, 0, 0, OLD_PAID_AT, "REFUNDED", OLD_PAID_AT],
    ["REFUNDED", 100, 0, 100, null, "REFUNDED", null],
    ["VERIFYING", 100, 0, 0, OLD_PAID_AT, "PENDING", null],
    ["VERIFYING", 100, 0, 40, OLD_PAID_AT, "PARTIAL", null],
    ["VERIFYING", 100, 0, 100, null, "SPONSORED", NOW],
    ["PENDING", 100, 0, 100, null, "SPONSORED", NOW],
    ["PENDING", 100, 0, 100, OLD_PAID_AT, "SPONSORED", OLD_PAID_AT],
    ["PENDING", 100, 0, 40, OLD_PAID_AT, "PARTIAL", null],
    ["PENDING", 100, 60, 40, OLD_PAID_AT, "PENDING", null],
    ["PARTIAL", 100, 100, 0, OLD_PAID_AT, "PENDING", null],
    ["SPONSORED", 100, 0, 0, OLD_PAID_AT, "PENDING", null],
    ["SPONSORED", 0, 0, 0, OLD_PAID_AT, "PENDING", null],
    ["VERIFYING", 0, 0, 0, OLD_PAID_AT, "PENDING", null],
    ["REFUNDED", 0, 0, 0, OLD_PAID_AT, "REFUNDED", OLD_PAID_AT],
  ] as const)(
    "recalc: %s, total=%i, paid=%i, sponsored=%i, paidAt=%s → %s (%s)",
    async (current, total, paid, amount, oldPaidAt, next, nextPaidAt) => {
      m.findSponsorshipForMutation.mockResolvedValue({
        id: "s1", eventId: "e1", coversBasePrice: true, coveredAccessIds: [],
        totalAmount: amount, usages: [{ id: "u1", registrationId: "r1" }], event: OK_EVENT,
      });
      m.getSponsorshipEventPricing.mockResolvedValue({ basePrice: amount, currency: "TND" });
      m.findSponsorshipForRecalc.mockResolvedValue(recalcSponsorship({
        totalAmount: total, paidAmount: paid,
        baseAmount: total, paymentStatus: current, paidAt: oldPaidAt,
        paymentMethod: "BANK_TRANSFER",
        priceBreakdown: { calculatedBasePrice: total, subtotal: total, accessItems: [] },
      }, { totalAmount: amount }));
      m.findUsageAmountsByRegistration.mockResolvedValue([{ amountApplied: amount }]);
      m.getSponsorshipById.mockResolvedValue({ id: "s1" });

      await service().updateSponsorship("s1", { coversBasePrice: true });

      expect(m.updateRegistrationSettlement).toHaveBeenCalledExactlyOnceWith({}, "r1", {
        sponsorshipAmount: amount, paymentStatus: next, paidAt: nextPaidAt,
        priceBreakdown: {
          calculatedBasePrice: total, subtotal: total, accessItems: [],
          sponsorshipTotal: amount, total: total - amount,
        },
      });
    },
  );
});


describe("sponsorship email enqueue characterization", () => {
  const TX = { emailTransaction: true };

  beforeEach(() => {
    m.withTxn.mockImplementation((fn: (tx: unknown) => unknown) => fn(TX));
    m.withLockingTxn.mockImplementation((fn: (tx: unknown) => unknown) => fn(TX));
    m.findActiveEventAccess.mockResolvedValue([]);
    m.getSponsorshipEventPricing.mockResolvedValue({ basePrice: 100, currency: "TND" });
  });

  function setupLinkedBatch(
    firstName: string | null,
    beneficiaryName: string,
    totalAmount: number,
    baseAmount = 100,
    autoApproveSponsorship = true,
  ) {
    m.findEventForBatch.mockResolvedValue(batchEvent());
    m.findSponsorFormById.mockResolvedValue({
      id: "f1", schema: { sponsorshipSettings: { sponsorshipMode: "LINKED_ACCOUNT" } },
    });
    m.findRegistrationsForBatch.mockResolvedValue([linkRegistration({
      firstName, lastName: "Recipient Last", email: "recipient@example.com",
      totalAmount, baseAmount,
      priceBreakdown: { calculatedBasePrice: baseAmount, accessItems: [] },
    })]);
    m.insertSponsorshipBatch.mockResolvedValue({ id: "batch-email-1" });
    m.getFormSchema.mockResolvedValue({ sponsorshipSettings: { autoApproveSponsorship } });
    m.sponsorshipCodeExists.mockResolvedValue(false);
    m.insertSponsorship.mockResolvedValue(createdSponsorship({
      code: "SP-ABCDEFGH", beneficiaryName, totalAmount: baseAmount,
      beneficiaryEmail: "recipient@example.com",
    }));
  }

  const BATCH_CONFIRMATION = [
    TX,
    {
      trigger: "SPONSORSHIP_BATCH_SUBMITTED", eventId: "e1",
      input: {
        recipientEmail: "l@x.com", recipientName: "Contact",
        context: expect.any(Object),
      },
    },
    "email:sponsorship:SPONSORSHIP_BATCH_SUBMITTED:batch-email-1",
  ];

  it.each([
    ["R", "R Recipient Last", "R", 100, 100, "full"],
    ["", "Recipient Last", "Recipient Last", 100, 100, "full"],
    [null, "Recipient Last", "Recipient Last", 100, 100, "full"],
    ["R", "R Recipient Last", "R", 200, 100, "partial"],
    ["", "Recipient Last", "Recipient Last", 200, 100, "partial"],
    [null, "Recipient Last", "Recipient Last", 200, 100, "partial"],
    ["", "Recipient Last", "Recipient Last", 200, 0, "none"],
  ] as const)(
    "linked batch firstName=%s beneficiary=%s recipient=%s total=%i base=%i (%s)",
    async (firstName, beneficiaryName, recipientName, total, base, coverage) => {
      setupLinkedBatch(firstName, beneficiaryName, total, base);

      await service().createSponsorshipBatch("e1", "f1", {
        sponsor: SPONSOR,
        linkedBeneficiaries: [{ registrationId: "r1", coversBasePrice: true, coveredAccessIds: [] }],
      });

      const input = {
        recipientEmail: "recipient@example.com", recipientName, registrationId: "r1",
        context: expect.objectContaining({ registrationId: "r1", email: "recipient@example.com" }),
      };
      expect(m.enqueueSponsorshipEmailOutbox.mock.calls).toEqual([
        BATCH_CONFIRMATION,
        [TX, { trigger: "SPONSORSHIP_LINKED", eventId: "e1", input },
          "email:sponsorship:SPONSORSHIP_LINKED:r1:SP-ABCDEFGH"],
        ...(coverage === "partial" ? [[
          TX, { trigger: "SPONSORSHIP_PARTIAL", eventId: "e1", input },
          "email:sponsorship:SPONSORSHIP_PARTIAL:r1:SP-ABCDEFGH",
        ]] : []),
      ]);
      expect(m.enqueueTriggeredEmailOutbox.mock.calls).toEqual(coverage === "full" ? [[
        TX,
        {
          trigger: "PAYMENT_CONFIRMED", eventId: "e1",
          registration: { id: "r1", email: "recipient@example.com", firstName, lastName: "Recipient Last" },
        },
        "email:triggered:PAYMENT_CONFIRMED:r1",
      ]] : []);
    },
  );

  it("a pending linked batch queues only the sponsor confirmation", async () => {
    setupLinkedBatch("R", "R Recipient Last", 100, 100, false);

    await service().createSponsorshipBatch("e1", "f1", {
      sponsor: SPONSOR,
      linkedBeneficiaries: [{ registrationId: "r1", coversBasePrice: true, coveredAccessIds: [] }],
    });

    expect(m.enqueueSponsorshipEmailOutbox.mock.calls).toEqual([BATCH_CONFIRMATION]);
    expect(m.enqueueTriggeredEmailOutbox).not.toHaveBeenCalled();
  });

  it.each([
    ["R", "R"],
    ["", "Sponsor Beneficiary"],
    [null, "Sponsor Beneficiary"],
  ] as const)("applied: firstName=%s uses recipient=%s and the sponsorship ID in its key", async (firstName, recipientName) => {
    m.findSponsorshipForLink.mockResolvedValue(linkSponsorship({
      code: "SP-ABCDEFGH", beneficiaryName: "Sponsor Beneficiary",
    }));
    m.findRegistrationForLink.mockResolvedValue(linkRegistration({
      firstName, email: "recipient@example.com",
    }));
    m.findUsage.mockResolvedValue(null);
    m.insertUsage.mockResolvedValue({ id: "u1", sponsorshipId: "s1", amountApplied: 200 });
    m.casSetSponsorshipUsed.mockResolvedValue(1);
    m.findUsageAmountsByRegistration.mockResolvedValue([{ amountApplied: 200 }]);

    await service().linkSponsorshipToRegistration("s1", "r1", "admin");

    expect(m.enqueueSponsorshipEmailOutbox).toHaveBeenCalledExactlyOnceWith(
      TX,
      {
        trigger: "SPONSORSHIP_APPLIED", eventId: "e1",
        input: {
          recipientEmail: "recipient@example.com", recipientName, registrationId: "r1",
          context: expect.objectContaining({ registrationId: "r1", email: "recipient@example.com" }),
        },
      },
      "email:sponsorship:SPONSORSHIP_APPLIED:r1:s1",
    );
    expect(m.enqueueTriggeredEmailOutbox).not.toHaveBeenCalled();
  });
});
