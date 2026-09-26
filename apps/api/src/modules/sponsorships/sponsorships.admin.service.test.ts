import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the db layer (the batch intake's tests are in
// sponsorships.public.service.test.ts). The service orchestrates: it locks
// and re-reads for the gates, delegates the money change to the shared
// settlement primitives (mocked here; their behaviour is covered by the DB
// tier), maps their refusals to AppExceptions and writes the side effects.
// withLockingTxn runs the callback with a sentinel tx.
const TX = vi.hoisted(() => ({ __tx: true }));
const db = vi.hoisted(() => {
  const fns = [
    "getDb",
    "listSponsorships",
    "getSponsorshipById",
    "getSponsorshipClientId",
    "getLinkedSponsorships",
    "getRegistrationForSponsorship",
    "getRegistrationCoverage",
    "getPendingSponsorships",
    "findSponsorshipForMutation",
    "findActiveEventAccess",
    "getEventBasePrice",
    "updateSponsorshipRow",
    "deleteSponsorshipRow",
    "getEventPricingForBatch",
    "findSponsorshipForLink",
    "findRegistrationForLink",
    "getSponsorshipByCode",
    "enqueueSponsorshipEmailOutbox",
    "insertAuditLog",
    "emitSettlementEvents",
    "lockSponsorshipForUpdate",
    "linkSponsorshipToRegistrationTxn",
    "unlinkSponsorshipFromRegistrationTxn",
    "releaseSponsorshipTxn",
    "changeSponsorshipCoverageTxn",
  ];
  const mod: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const f of fns) mod[f] = vi.fn();
  mod.withLockingTxn = vi.fn((fn: (tx: unknown) => unknown) => fn(TX));
  return mod;
});
vi.mock("@app/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@app/db")>();
  return {
    ...db,
    settlementEventPair: real.settlementEventPair,
    SponsorshipSettlementError: real.SponsorshipSettlementError,
    AccessCapacityExceededError: real.AccessCapacityExceededError,
    AccessNotFoundError: real.AccessNotFoundError,
    AccessPaidCountUnderflowError: real.AccessPaidCountUnderflowError,
  };
});

import { AccessCapacityExceededError, SponsorshipSettlementError, type SettleRegistrationResult } from "@app/db";
import { SponsorshipsAdminService } from "./sponsorships.admin.service";
import type { AccessService } from "../access/access.service";

const m = db;

// AccessService is injected; the service only drops items that became full.
const access = { handleCapacityReached: vi.fn() };

function service() {
  return new SponsorshipsAdminService(access as unknown as AccessService);
}

// Gate-passing event/client defaults (assertEventWritable/assertModuleEnabledForClient).
const OK_EVENT = {
  clientId: "c1",
  status: "OPEN",
  client: { active: true, enabledModules: ["sponsorships"] },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.withLockingTxn.mockImplementation((fn: (tx: unknown) => unknown) => fn(TX));
  access.handleCapacityReached.mockResolvedValue(0);
  m.lockSponsorshipForUpdate.mockResolvedValue(true);
  m.updateSponsorshipRow.mockResolvedValue(undefined);
  m.deleteSponsorshipRow.mockResolvedValue(undefined);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.emitSettlementEvents.mockResolvedValue([]);
  m.enqueueSponsorshipEmailOutbox.mockResolvedValue(true);
});

/** A settleRegistrationTxn result with the given money state change. */
function settled(
  before: { status?: string; sponsorship?: number; total?: number; paid?: number } = {},
  after: { status?: string; sponsorship?: number; total?: number; paid?: number } = {},
  paidAccess: { incremented?: string[]; decremented?: string[] } = {},
): SettleRegistrationResult {
  const snapshot = (s: typeof before) => ({
    paymentStatus: (s.status ?? "PENDING") as never,
    paidAt: null,
    paidAmount: s.paid ?? 0,
    totalAmount: s.total ?? 500,
    sponsorshipAmount: s.sponsorship ?? 0,
    priceBreakdown: {} as never,
  });
  return {
    written: true,
    eventId: "e1",
    before: snapshot(before),
    after: snapshot({ ...before, ...after }),
    coveredAccessIds: [],
    paidAccess: { incremented: paidAccess.incremented ?? [], decremented: paidAccess.decremented ?? [] },
  };
}

function auditCalls(action: string) {
  return m.insertAuditLog.mock.calls
    .map(([entry]) => entry as { action: string; entityId: string; changes: Record<string, unknown>; performedBy: string | null })
    .filter((entry) => entry.action === action);
}

function emittedTypes(): string[] {
  return m.emitSettlementEvents.mock.calls.flatMap(([, events]) => (events as Array<{ type: string }>).map((e) => e.type));
}

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

function mutationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    eventId: "e1",
    code: "SP-AAAA",
    status: "PENDING",
    beneficiaryName: "Ben",
    beneficiaryEmail: "b@x.com",
    beneficiaryPhone: null,
    beneficiaryAddress: null,
    coversBasePrice: true,
    coveredAccessIds: [],
    totalAmount: 100,
    usages: [],
    event: OK_EVENT,
    ...overrides,
  };
}

describe("updateSponsorship", () => {
  it("404 when the sponsorship does not exist", async () => {
    m.lockSponsorshipForUpdate.mockResolvedValue(false);
    await expect(
      service().updateSponsorship("s1", { beneficiaryName: "X" }),
    ).rejects.toMatchObject({ code: "RES_3001", statusCode: 404 });
    expect(m.findSponsorshipForMutation).not.toHaveBeenCalled();
  });

  it("locks, then re-reads before deciding", async () => {
    m.findSponsorshipForMutation.mockResolvedValue(mutationRow());
    m.getSponsorshipById.mockResolvedValue({ id: "s1" });

    await service().updateSponsorship("s1", { beneficiaryName: "X" });

    expect(m.lockSponsorshipForUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      m.findSponsorshipForMutation.mock.invocationCallOrder[0],
    );
    expect(m.lockSponsorshipForUpdate).toHaveBeenCalledWith(TX, "s1");
  });

  it("beneficiary update writes that field, audits it and emits sponsorship.updated", async () => {
    m.findSponsorshipForMutation.mockResolvedValue(mutationRow());
    const fresh = { id: "s1", beneficiaryName: "X" };
    m.getSponsorshipById.mockResolvedValue(fresh);

    const result = await service().updateSponsorship("s1", { beneficiaryName: "X" }, "admin-1");

    expect(m.updateSponsorshipRow).toHaveBeenCalledWith(TX, "s1", { beneficiaryName: "X" });
    expect(m.changeSponsorshipCoverageTxn).not.toHaveBeenCalled();
    expect(auditCalls("UPDATE")).toEqual([
      expect.objectContaining({
        entityId: "s1",
        changes: { beneficiaryName: { old: "Ben", new: "X" } },
        performedBy: "admin-1",
      }),
    ]);
    expect(emittedTypes()).toEqual(["sponsorship.updated"]);
    expect(result).toBe(fresh);
  });

  it("coverage change recomputes totalAmount and settles every linked registration", async () => {
    m.findSponsorshipForMutation.mockResolvedValue(
      mutationRow({ coversBasePrice: false, coveredAccessIds: [], totalAmount: 0 }),
    );
    m.findActiveEventAccess.mockResolvedValue([
      { id: "a1", name: "A", type: "MEAL", groupLabel: null, startsAt: null, endsAt: null, price: 200 },
    ]);
    m.getEventBasePrice.mockResolvedValue(100);
    m.getSponsorshipById.mockResolvedValue({ id: "s1" });
    m.changeSponsorshipCoverageTxn.mockResolvedValue({
      sponsorship: {},
      settled: [
        {
          ...settled({ status: "PARTIAL", sponsorship: 100 }, { status: "SPONSORED", sponsorship: 500 }, { incremented: ["a1"] }),
          registrationId: "r1",
        },
      ],
    });

    await service().updateSponsorship("s1", {
      coversBasePrice: true,
      coveredAccessIds: ["a1"],
      beneficiaryName: "Y",
    });

    expect(m.changeSponsorshipCoverageTxn).toHaveBeenCalledWith(
      TX,
      "s1",
      { coversBasePrice: true, coveredAccessIds: ["a1"], totalAmount: 300 },
      { beneficiaryName: "Y" },
    );
    expect(m.updateSponsorshipRow).not.toHaveBeenCalled();
    expect(access.handleCapacityReached).toHaveBeenCalledWith("e1", ["a1"], TX);
    expect(auditCalls("UPDATE")[0].changes).toMatchObject({
      coversBasePrice: { old: false, new: true },
      coveredAccessIds: { old: [], new: ["a1"] },
      totalAmount: { old: 0, new: 300 },
    });
    expect(emittedTypes()).toEqual([
      "registration.paymentConfirmed",
      "eventAccess.countsChanged",
      "sponsorship.updated",
    ]);
  });

  it("409 SPONSORSHIP_TARGET_SETTLED when a PAID registration's amount would change", async () => {
    m.findSponsorshipForMutation.mockResolvedValue(mutationRow());
    m.getEventBasePrice.mockResolvedValue(100);
    m.changeSponsorshipCoverageTxn.mockRejectedValue(
      new SponsorshipSettlementError("TARGET_SETTLED", { registrationId: "r1", paymentStatus: "PAID" }),
    );

    await expect(service().updateSponsorship("s1", { coversBasePrice: false })).rejects.toMatchObject({
      code: "SPO_14004",
      statusCode: 409,
      details: { registrationId: "r1", paymentStatus: "PAID" },
    });
    expect(m.insertAuditLog).not.toHaveBeenCalled();
  });

  it('status:"CANCELLED" delegates to cancel', async () => {
    m.findSponsorshipForMutation.mockResolvedValue(mutationRow());
    m.releaseSponsorshipTxn.mockResolvedValue({ sponsorship: {}, unlinked: [] });
    m.getSponsorshipById.mockResolvedValue({ id: "s1", status: "CANCELLED" });

    const result = await service().updateSponsorship("s1", { status: "CANCELLED" });

    expect(m.updateSponsorshipRow).toHaveBeenCalledWith(TX, "s1", { status: "CANCELLED" });
    expect((result as { status: string }).status).toBe("CANCELLED");
  });
});

// ============================================================================
// cancelSponsorship / deleteSponsorship
// ============================================================================

function unlinkResult(overrides: Record<string, unknown> = {}) {
  return {
    registrationId: "r1",
    usage: { id: "u1", sponsorshipId: "s1", registrationId: "r1", amountApplied: 100 },
    settled: settled({ status: "SPONSORED", sponsorship: 100, total: 100 }, { status: "PENDING", sponsorship: 0 }, {
      decremented: ["a1"],
    }),
    clearedSponsorshipCode: null,
    clearedPaymentMethod: "LAB_SPONSORSHIP",
    ...overrides,
  };
}

describe("cancelSponsorship", () => {
  it("no usages → status set CANCELLED, audited, sponsorship.cancelled only", async () => {
    m.findSponsorshipForMutation.mockResolvedValue(mutationRow());
    m.releaseSponsorshipTxn.mockResolvedValue({ sponsorship: {}, unlinked: [] });
    m.getSponsorshipById.mockResolvedValue({ id: "s1", status: "CANCELLED" });

    await service().cancelSponsorship("s1", "admin-1");

    expect(m.releaseSponsorshipTxn).toHaveBeenCalledWith(TX, "s1");
    expect(m.updateSponsorshipRow).toHaveBeenCalledWith(TX, "s1", { status: "CANCELLED" });
    expect(auditCalls("CANCEL")).toEqual([
      expect.objectContaining({ changes: { status: { old: "PENDING", new: "CANCELLED" } }, performedBy: "admin-1" }),
    ]);
    expect(emittedTypes()).toEqual(["sponsorship.cancelled"]);
  });

  it("with usages → each registration is unlinked, audited and re-emitted", async () => {
    m.findSponsorshipForMutation.mockResolvedValue(mutationRow({ status: "USED" }));
    m.releaseSponsorshipTxn.mockResolvedValue({ sponsorship: {}, unlinked: [unlinkResult()] });
    m.getSponsorshipById.mockResolvedValue({ id: "s1", status: "CANCELLED" });

    await service().cancelSponsorship("s1", "admin-1");

    expect(auditCalls("UNLINK_FROM_REGISTRATION")).toEqual([
      expect.objectContaining({
        entityId: "s1",
        changes: {
          registrationId: { old: "r1", new: null },
          amountApplied: { old: 100, new: 0 },
          sponsorshipAmount: { old: 100, new: 0 },
          paymentStatus: { old: "SPONSORED", new: "PENDING" },
          paymentMethod: { old: "LAB_SPONSORSHIP", new: null },
        },
      }),
    ]);
    expect(emittedTypes()).toEqual(["registration.updated", "sponsorship.cancelled", "eventAccess.countsChanged"]);
  });

  it("an already CANCELLED sponsorship still releases lingering usages, without a second CANCEL", async () => {
    m.findSponsorshipForMutation.mockResolvedValue(mutationRow({ status: "CANCELLED" }));
    m.releaseSponsorshipTxn.mockResolvedValue({ sponsorship: {}, unlinked: [unlinkResult()] });
    m.getSponsorshipById.mockResolvedValue({ id: "s1", status: "CANCELLED" });

    await service().cancelSponsorship("s1");

    expect(m.updateSponsorshipRow).not.toHaveBeenCalled();
    expect(auditCalls("CANCEL")).toEqual([]);
    expect(auditCalls("UNLINK_FROM_REGISTRATION")).toHaveLength(1);
  });

  it("409 when a linked registration is PAID", async () => {
    m.findSponsorshipForMutation.mockResolvedValue(mutationRow({ status: "USED" }));
    m.releaseSponsorshipTxn.mockRejectedValue(
      new SponsorshipSettlementError("TARGET_SETTLED", { registrationId: "r1", paymentStatus: "PAID" }),
    );

    await expect(service().cancelSponsorship("s1")).rejects.toMatchObject({ code: "SPO_14004", statusCode: 409 });
    expect(m.updateSponsorshipRow).not.toHaveBeenCalled();
  });

  it("404 when not found", async () => {
    m.lockSponsorshipForUpdate.mockResolvedValue(false);
    await expect(service().cancelSponsorship("s1")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("deleteSponsorship", () => {
  it("unlinks, audits DELETE with the row's fields, then deletes", async () => {
    m.findSponsorshipForMutation.mockResolvedValue(mutationRow({ status: "USED" }));
    m.releaseSponsorshipTxn.mockResolvedValue({ sponsorship: {}, unlinked: [unlinkResult()] });

    await service().deleteSponsorship("s1", "admin-1");

    expect(auditCalls("DELETE")[0].changes).toEqual({
      code: { old: "SP-AAAA", new: null },
      status: { old: "USED", new: null },
      beneficiaryName: { old: "Ben", new: null },
      beneficiaryEmail: { old: "b@x.com", new: null },
      totalAmount: { old: 100, new: null },
    });
    expect(m.releaseSponsorshipTxn.mock.invocationCallOrder[0]).toBeLessThan(
      m.deleteSponsorshipRow.mock.invocationCallOrder[0],
    );
    expect(m.deleteSponsorshipRow).toHaveBeenCalledWith(TX, "s1");
    expect(emittedTypes()).toEqual(["registration.updated", "sponsorship.deleted", "eventAccess.countsChanged"]);
  });

  it("404 when not found", async () => {
    m.lockSponsorshipForUpdate.mockResolvedValue(false);
    await expect(service().deleteSponsorship("s1")).rejects.toMatchObject({ statusCode: 404 });
  });
});

// ============================================================================
// linkSponsorshipToRegistration
// ============================================================================

function linkSponsorship(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    eventId: "e1",
    code: "SP-AAAA",
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
    paymentStatus: "PARTIAL",
    sponsorshipAmount: 200,
    existingUsages: [
      { sponsorshipId: "s1", sponsorship: { code: "SP-AAAA", coversBasePrice: true, coveredAccessIds: [] } },
    ],
    ...overrides,
  };
}

function linkResult(overrides: Record<string, unknown> = {}) {
  return {
    sponsorship: {},
    usage: { id: "u1", sponsorshipId: "s1", registrationId: "r1", amountApplied: 200 },
    settled: settled({ status: "PENDING", sponsorship: 0 }, { status: "PARTIAL", sponsorship: 200 }),
    ...overrides,
  };
}

describe("linkSponsorshipToRegistration", () => {
  beforeEach(() => {
    m.findSponsorshipForLink.mockResolvedValue(linkSponsorship());
    m.findRegistrationForLink.mockResolvedValue(linkRegistration());
    m.getEventPricingForBatch.mockResolvedValue({ basePrice: 200, currency: "TND" });
    m.findActiveEventAccess.mockResolvedValue([]);
  });

  it("locks the sponsorship, links through the shared settlement and returns the settled amounts", async () => {
    m.linkSponsorshipToRegistrationTxn.mockResolvedValue(linkResult());

    const result = await service().linkSponsorshipToRegistration("s1", "r1", "admin-1");

    expect(m.lockSponsorshipForUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      m.findSponsorshipForLink.mock.invocationCallOrder[0],
    );
    expect(m.linkSponsorshipToRegistrationTxn).toHaveBeenCalledWith(TX, {
      sponsorshipId: "s1",
      registrationId: "r1",
      appliedBy: "admin-1",
      fields: { paymentMethod: "LAB_SPONSORSHIP" },
    });
    expect(result).toEqual({
      usage: { id: "u1", sponsorshipId: "s1", amountApplied: 200 },
      registration: { totalAmount: 500, sponsorshipAmount: 200, amountDue: 300 },
      warnings: [],
    });
  });

  it("restores the side effects: audit, sponsorship.linked, registration events, email", async () => {
    m.linkSponsorshipToRegistrationTxn.mockResolvedValue(
      linkResult({
        settled: settled({ status: "PENDING" }, { status: "SPONSORED", sponsorship: 500 }, { incremented: ["a1"] }),
      }),
    );

    await service().linkSponsorshipToRegistration("s1", "r1", "admin-1");

    expect(access.handleCapacityReached).toHaveBeenCalledWith("e1", ["a1"], TX);
    expect(auditCalls("LINK_TO_REGISTRATION")).toEqual([
      expect.objectContaining({
        entityId: "s1",
        performedBy: "admin-1",
        changes: {
          registrationId: { old: null, new: "r1" },
          amountApplied: { old: 0, new: 200 },
          sponsorshipAmount: { old: 0, new: 500 },
          status: { old: "PENDING", new: "USED" },
          paymentStatus: { old: "PENDING", new: "SPONSORED" },
        },
      }),
    ]);
    expect(emittedTypes()).toEqual([
      "sponsorship.linked",
      "registration.paymentConfirmed",
      "eventAccess.countsChanged",
    ]);
    const countsEvent = m.emitSettlementEvents.mock.calls[0][1][2];
    expect(countsEvent.payload).toEqual({ id: "e1", accessIds: ["a1"] });
    expect(m.enqueueSponsorshipEmailOutbox).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ trigger: "SPONSORSHIP_APPLIED" }),
      "email:sponsorship:SPONSORSHIP_APPLIED:r1:s1",
    );
  });

  it("warns about overlap with the registration's other sponsorships only", async () => {
    m.linkSponsorshipToRegistrationTxn.mockResolvedValue(linkResult());
    m.findRegistrationForLink.mockResolvedValue(
      linkRegistration({
        existingUsages: [
          { sponsorshipId: "s1", sponsorship: { code: "SP-AAAA", coversBasePrice: true, coveredAccessIds: [] } },
          { sponsorshipId: "s2", sponsorship: { code: "SP-BBBB", coversBasePrice: true, coveredAccessIds: [] } },
        ],
      }),
    );

    const result = await service().linkSponsorshipToRegistration("s1", "r1", "admin-1");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("SP-BBBB");
  });

  it("404 when the sponsorship does not exist", async () => {
    m.lockSponsorshipForUpdate.mockResolvedValue(false);
    await expect(service().linkSponsorshipToRegistration("s1", "r1", "a")).rejects.toMatchObject({
      code: "RES_3001",
      statusCode: 404,
    });
    expect(m.linkSponsorshipToRegistrationTxn).not.toHaveBeenCalled();
  });

  it("refuses when the event is archived, before linking", async () => {
    m.findSponsorshipForLink.mockResolvedValue(
      linkSponsorship({ event: { ...linkSponsorship().event, status: "ARCHIVED" } }),
    );
    await expect(service().linkSponsorshipToRegistration("s1", "r1", "a")).rejects.toMatchObject({ statusCode: 400 });
    expect(m.linkSponsorshipToRegistrationTxn).not.toHaveBeenCalled();
  });

  it.each([
    ["SPONSORSHIP_NOT_FOUND", { code: "RES_3001", statusCode: 404 }],
    ["SPONSORSHIP_CANCELLED", { code: "RES_3003", statusCode: 400, details: { code: "SPONSORSHIP_CANCELLED" } }],
    ["REGISTRATION_NOT_FOUND", { code: "REG_8001", statusCode: 404 }],
    ["EVENT_MISMATCH", { code: "RES_3003", statusCode: 400 }],
    ["ALREADY_LINKED", { code: "RES_3002", statusCode: 409, details: { code: "SPONSORSHIP_ALREADY_LINKED" } }],
    ["NOT_APPLICABLE", { code: "SPO_14001", statusCode: 400 }],
    ["TARGET_SETTLED", { code: "SPO_14004", statusCode: 409 }],
    ["EXCEEDS_AMOUNT_DUE", { code: "SPO_14005", statusCode: 409 }],
  ] as const)("maps %s", async (reason, expected) => {
    m.linkSponsorshipToRegistrationTxn.mockRejectedValue(new SponsorshipSettlementError(reason, {}));
    await expect(service().linkSponsorshipToRegistration("s1", "r1", "a")).rejects.toMatchObject(expected);
    expect(m.insertAuditLog).not.toHaveBeenCalled();
  });

  it("EXCEEDS_AMOUNT_DUE carries the paid amount and the new amount due", async () => {
    m.linkSponsorshipToRegistrationTxn.mockRejectedValue(
      new SponsorshipSettlementError("EXCEEDS_AMOUNT_DUE", { registrationId: "r1", paidAmount: 400, amountDue: 300 }),
    );
    await expect(service().linkSponsorshipToRegistration("s1", "r1", "a")).rejects.toMatchObject({
      details: { registrationId: "r1", paidAmount: 400, amountDue: 300 },
    });
  });

  it("a full access item is the usual 409 ACCESS_CAPACITY_EXCEEDED", async () => {
    m.linkSponsorshipToRegistrationTxn.mockRejectedValue(new AccessCapacityExceededError("a1", "Workshop", 0, 1));
    await expect(service().linkSponsorshipToRegistration("s1", "r1", "a")).rejects.toMatchObject({
      code: "ACC_7002",
      statusCode: 409,
    });
  });
});

describe("linkSponsorshipByCode", () => {
  it("normalizes the code, resolves it for the registration's event, then links", async () => {
    m.getRegistrationForSponsorship.mockResolvedValue({ event: { id: "e1" } });
    m.getSponsorshipByCode.mockResolvedValue({ id: "s1" });
    m.findSponsorshipForLink.mockResolvedValue(linkSponsorship());
    m.findRegistrationForLink.mockResolvedValue(linkRegistration());
    m.getEventPricingForBatch.mockResolvedValue(null);
    m.findActiveEventAccess.mockResolvedValue([]);
    m.linkSponsorshipToRegistrationTxn.mockResolvedValue(linkResult());

    const result = await service().linkSponsorshipByCode("r1", "  sp-aaaa ", "admin-1");

    expect(m.getSponsorshipByCode).toHaveBeenCalledWith("e1", "SP-AAAA");
    expect(result.usage.id).toBe("u1");
  });

  it("404 registration not found", async () => {
    m.getRegistrationForSponsorship.mockResolvedValue(null);
    await expect(service().linkSponsorshipByCode("r1", "X", "a")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("404 code not found for event", async () => {
    m.getRegistrationForSponsorship.mockResolvedValue({ event: { id: "e1" } });
    m.getSponsorshipByCode.mockResolvedValue(null);
    await expect(service().linkSponsorshipByCode("r1", "NOPE", "a")).rejects.toMatchObject({
      statusCode: 404,
      details: { code: "SPONSORSHIP_NOT_FOUND" },
    });
  });
});

// ============================================================================
// unlinkSponsorshipFromRegistration
// ============================================================================

describe("unlinkSponsorshipFromRegistration", () => {
  it("unlinks through the shared settlement, audits and emits", async () => {
    m.findSponsorshipForMutation.mockResolvedValue(mutationRow({ status: "USED" }));
    m.unlinkSponsorshipFromRegistrationTxn.mockResolvedValue({
      ...unlinkResult({ clearedSponsorshipCode: "sp-aaaa" }),
      sponsorship: {},
      status: { before: "USED", after: "PENDING" },
    });

    await service().unlinkSponsorshipFromRegistration("s1", "r1", "admin-1");

    expect(m.unlinkSponsorshipFromRegistrationTxn).toHaveBeenCalledWith(TX, { sponsorshipId: "s1", registrationId: "r1" });
    expect(auditCalls("UNLINK_FROM_REGISTRATION")).toEqual([
      expect.objectContaining({
        performedBy: "admin-1",
        changes: {
          registrationId: { old: "r1", new: null },
          amountApplied: { old: 100, new: 0 },
          sponsorshipAmount: { old: 100, new: 0 },
          paymentStatus: { old: "SPONSORED", new: "PENDING" },
          paymentMethod: { old: "LAB_SPONSORSHIP", new: null },
          sponsorshipCode: { old: "sp-aaaa", new: null },
          status: { old: "USED", new: "PENDING" },
        },
      }),
    ]);
    expect(emittedTypes()).toEqual(["sponsorship.unlinked", "registration.updated", "eventAccess.countsChanged"]);
  });

  it("404 when the sponsorship does not exist", async () => {
    m.lockSponsorshipForUpdate.mockResolvedValue(false);
    await expect(service().unlinkSponsorshipFromRegistration("s1", "r1")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("404 when the link does not exist", async () => {
    m.findSponsorshipForMutation.mockResolvedValue(mutationRow());
    m.unlinkSponsorshipFromRegistrationTxn.mockRejectedValue(new SponsorshipSettlementError("NOT_LINKED", {}));
    await expect(service().unlinkSponsorshipFromRegistration("s1", "r1")).rejects.toMatchObject({
      code: "RES_3001",
      statusCode: 404,
    });
  });

  it("409 when the registration is PAID", async () => {
    m.findSponsorshipForMutation.mockResolvedValue(mutationRow({ status: "USED" }));
    m.unlinkSponsorshipFromRegistrationTxn.mockRejectedValue(
      new SponsorshipSettlementError("TARGET_SETTLED", { registrationId: "r1", paymentStatus: "PAID" }),
    );
    await expect(service().unlinkSponsorshipFromRegistration("s1", "r1")).rejects.toMatchObject({
      code: "SPO_14004",
      statusCode: 409,
    });
    expect(m.insertAuditLog).not.toHaveBeenCalled();
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
