import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the db layer, as in sponsorships.admin.service.test.ts. The list is
// every @app/db function the public service calls: the sponsor form's reads
// and the batch intake, with its one settlement primitive (the auto-approved
// link). withLockingTxn runs the callback with a sentinel tx.
const TX = vi.hoisted(() => ({ __tx: true }));
const db = vi.hoisted(() => {
  const fns = [
    "getDb",
    "getActiveSponsorForm",
    "searchRegistrantsForSponsorship",
    "findActiveEventAccess",
    "insertSponsorshipBatch",
    "getFormSchema",
    "findEventForBatch",
    "findSponsorFormById",
    "getEventPricingForBatch",
    "findRegistrationsForBatch",
    "sponsorshipCodeExists",
    "insertSponsorship",
    "enqueueSponsorshipEmailOutbox",
    "enqueueTriggeredEmailOutbox",
    "insertAuditLog",
    "emitSettlementEvents",
    "lockRegistrationsForUpdate",
    "readSponsorshipTarget",
    "sponsorshipLinkRefusal",
    "linkSponsorshipToRegistrationTxn",
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

import { SponsorshipSettlementError, type SettleRegistrationResult } from "@app/db";
import { SponsorshipsPublicService } from "./sponsorships.public.service";
import type { AccessService } from "../access/access.service";

const m = db;

// AccessService is injected; the service only drops items that became full.
const access = { handleCapacityReached: vi.fn() };

function service() {
  return new SponsorshipsPublicService(access as unknown as AccessService);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.withLockingTxn.mockImplementation((fn: (tx: unknown) => unknown) => fn(TX));
  access.handleCapacityReached.mockResolvedValue(0);
  m.lockRegistrationsForUpdate.mockResolvedValue([]);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.emitSettlementEvents.mockResolvedValue([]);
  m.enqueueSponsorshipEmailOutbox.mockResolvedValue(true);
  m.enqueueTriggeredEmailOutbox.mockResolvedValue(true);
  m.sponsorshipLinkRefusal.mockResolvedValue(null);
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

function linkResult(overrides: Record<string, unknown> = {}) {
  return {
    sponsorship: {},
    usage: { id: "u1", sponsorshipId: "s1", registrationId: "r1", amountApplied: 200 },
    settled: settled({ status: "PENDING", sponsorship: 0 }, { status: "PARTIAL", sponsorship: 200 }),
    ...overrides,
  };
}

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
    status: "PENDING",
    beneficiaryName: "Ben",
    beneficiaryEmail: "b@x.com",
    coversBasePrice: true,
    coveredAccessIds: [],
    totalAmount: 100,
    ...overrides,
  };
}

const BATCH_REGISTRATION = {
  id: "r1",
  email: "r@x.com",
  firstName: "R",
  lastName: null,
  phone: null,
  totalAmount: 100,
  sponsorshipAmount: 0,
  baseAmount: 100,
  accessTypeIds: [],
  priceBreakdown: { calculatedBasePrice: 100, accessItems: [] },
  paymentStatus: "PENDING",
  linkBaseUrl: null,
  editToken: null,
};

function linkedBatchSetup(autoApprove: boolean) {
  m.findEventForBatch.mockResolvedValue(batchEvent());
  m.findSponsorFormById.mockResolvedValue({ id: "f1", schema: { sponsorshipSettings: { sponsorshipMode: "LINKED_ACCOUNT" } } });
  m.getEventPricingForBatch.mockResolvedValue({ basePrice: 100, currency: "TND" });
  m.findRegistrationsForBatch.mockResolvedValue([{ ...BATCH_REGISTRATION }]);
  m.insertSponsorshipBatch.mockResolvedValue({ id: "b1" });
  m.getFormSchema.mockResolvedValue({ sponsorshipSettings: { autoApproveSponsorship: autoApprove } });
  m.sponsorshipCodeExists.mockResolvedValue(false);
  m.insertSponsorship.mockResolvedValue(createdSponsorship());
  m.readSponsorshipTarget.mockResolvedValue({
    id: "r1",
    eventId: "e1",
    paymentStatus: "PENDING",
    paymentMethod: null,
    paidAmount: 0,
    totalAmount: 100,
    baseAmount: 100,
    sponsorshipAmount: 0,
    sponsorshipCode: null,
    priceBreakdown: { calculatedBasePrice: 100, subtotal: 100, accessItems: [] },
  });
}

describe("createSponsorshipBatch", () => {
  it("CODE mode happy path → batchId + count, batchCreated emitted", async () => {
    m.findEventForBatch.mockResolvedValue(batchEvent());
    m.findSponsorFormById.mockResolvedValue({ id: "f1", schema: { sponsorshipSettings: { sponsorshipMode: "CODE" } } });
    m.getEventPricingForBatch.mockResolvedValue({ basePrice: 100, currency: "TND" });
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
    expect(emittedTypes()).toEqual(["sponsorship.batchCreated"]);
    expect(m.emitSettlementEvents.mock.calls[0][1][0].payload).toEqual({ id: "b1", batchId: "b1", count: 1 });
  });

  it("CODE mode counts every beneficiary (loop, not just first)", async () => {
    m.findEventForBatch.mockResolvedValue(batchEvent());
    m.findSponsorFormById.mockResolvedValue({ id: "f1", schema: {} });
    m.getEventPricingForBatch.mockResolvedValue({ basePrice: 100, currency: "TND" });
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
    m.getEventPricingForBatch.mockResolvedValue({ basePrice: 100, currency: "TND" });
    m.findActiveEventAccess.mockResolvedValue([]); // none valid

    await expect(
      service().createSponsorshipBatch("e1", "f1", {
        sponsor: SPONSOR,
        beneficiaries: [{ name: "B", email: "b@x.com", coversBasePrice: false, coveredAccessIds: ["bad"] }],
      }),
    ).rejects.toMatchObject({ code: "RES_3003", statusCode: 400 });
  });

  it("linked mode, no auto-approve → PENDING targeted sponsorship, no lock and no link", async () => {
    linkedBatchSetup(false);

    const result = await service().createSponsorshipBatch("e1", "f1", {
      sponsor: SPONSOR,
      linkedBeneficiaries: [{ registrationId: "r1", coversBasePrice: true, coveredAccessIds: [] }],
    });

    expect(result.count).toBe(1);
    expect(m.insertSponsorship.mock.calls[0][1]).toMatchObject({
      status: "PENDING",
      targetRegistrationId: "r1",
      totalAmount: 100,
    });
    expect(m.lockRegistrationsForUpdate).not.toHaveBeenCalled();
    expect(m.linkSponsorshipToRegistrationTxn).not.toHaveBeenCalled();
  });

  it("linked mode, auto-approve → registrations locked first, each sponsorship linked and settled", async () => {
    linkedBatchSetup(true);
    m.linkSponsorshipToRegistrationTxn.mockResolvedValue(
      linkResult({
        usage: { id: "u1", sponsorshipId: "s1", registrationId: "r1", amountApplied: 100 },
        settled: settled({ status: "PENDING", total: 100 }, { status: "SPONSORED", sponsorship: 100 }),
      }),
    );

    const result = await service().createSponsorshipBatch("e1", "f1", {
      sponsor: SPONSOR,
      linkedBeneficiaries: [{ registrationId: "r1", coversBasePrice: true, coveredAccessIds: [] }],
    });

    expect(result.count).toBe(1);
    expect(m.lockRegistrationsForUpdate).toHaveBeenCalledWith(TX, ["r1"]);
    expect(m.lockRegistrationsForUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      m.insertSponsorship.mock.invocationCallOrder[0],
    );
    const inserted = m.insertSponsorship.mock.calls[0][1];
    expect(inserted).toMatchObject({ status: "PENDING", totalAmount: 100 });
    expect(inserted).not.toHaveProperty("targetRegistrationId");
    expect(m.linkSponsorshipToRegistrationTxn).toHaveBeenCalledWith(TX, {
      sponsorshipId: "s1",
      registrationId: "r1",
      appliedBy: "SYSTEM",
      fields: { paymentMethod: "LAB_SPONSORSHIP" },
    });
    expect(auditCalls("LINK_TO_REGISTRATION")).toHaveLength(1);
    expect(emittedTypes()).toEqual([
      "sponsorship.batchCreated",
      "sponsorship.linked",
      "registration.paymentConfirmed",
      "eventAccess.countsChanged",
    ]);
    const emailTriggers = [
      ...m.enqueueSponsorshipEmailOutbox.mock.calls.map(([, payload]) => payload.trigger),
      ...m.enqueueTriggeredEmailOutbox.mock.calls.map(([, payload]) => payload.trigger),
    ];
    expect(emailTriggers).toEqual(["SPONSORSHIP_BATCH_SUBMITTED", "SPONSORSHIP_LINKED", "PAYMENT_CONFIRMED"]);
  });

  it("linked mode, auto-approve on a settled registration → PENDING targeted, not linked", async () => {
    linkedBatchSetup(true);
    m.sponsorshipLinkRefusal.mockResolvedValue(
      new SponsorshipSettlementError("TARGET_SETTLED", { registrationId: "r1", paymentStatus: "REFUNDED" }),
    );

    const result = await service().createSponsorshipBatch("e1", "f1", {
      sponsor: SPONSOR,
      linkedBeneficiaries: [{ registrationId: "r1", coversBasePrice: true, coveredAccessIds: [] }],
    });

    expect(result.count).toBe(1);
    expect(m.insertSponsorship.mock.calls[0][1]).toMatchObject({ status: "PENDING", targetRegistrationId: "r1" });
    expect(m.linkSponsorshipToRegistrationTxn).not.toHaveBeenCalled();
    expect(emittedTypes()).toEqual(["sponsorship.batchCreated"]);
  });

  it("linked mode, registration missing → 404", async () => {
    m.findEventForBatch.mockResolvedValue(batchEvent());
    m.findSponsorFormById.mockResolvedValue({ id: "f1", schema: { sponsorshipSettings: { sponsorshipMode: "LINKED_ACCOUNT" } } });
    m.getEventPricingForBatch.mockResolvedValue({ basePrice: 100, currency: "TND" });
    m.findRegistrationsForBatch.mockResolvedValue([]); // none found

    await expect(
      service().createSponsorshipBatch("e1", "f1", {
        sponsor: SPONSOR,
        linkedBeneficiaries: [{ registrationId: "r1", coversBasePrice: true, coveredAccessIds: [] }],
      }),
    ).rejects.toMatchObject({ code: "RES_3001", statusCode: 404 });
  });
});
