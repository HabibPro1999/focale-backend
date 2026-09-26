// Shared unit-test harness for the registrations services (test-only,
// excluded from the build): the @app/db, @app/integrations and file-type
// mocks, the settlement mocks over the mocked rows, and the row fixtures.
//
// A test file mocks the modules with this harness:
//
//   vi.mock("@app/db", async (importOriginal) =>
//     (await import("./__testing__/service-mocks.js")).mockDbModule(importOriginal));
//   vi.mock("@app/integrations", async (importOriginal) =>
//     (await import("./__testing__/service-mocks.js")).mockIntegrationsModule(importOriginal));
//   vi.mock("file-type", async () => (await import("./__testing__/service-mocks.js")).ft);
//
// and calls `installServiceMocks()` in its beforeEach.
import { expect, vi } from "vitest";
import type { ApplyRegistrationSettlementInput, RegistrationPatch } from "@app/db";
import {
  calculateApplicableAmount,
  calculateDiscountAmount,
  deriveSettlement,
  netBreakdown,
  paidAccessQuantities,
} from "@app/shared";

// --- @app/db mock -----------------------------------------------------------
/** What the mocked getDb() returns: writes outside a transaction pass it explicitly. */
export const rootDb = { executor: "root" };
export const db = {
  getDb: vi.fn(() => rootDb),
  withTxn: vi.fn(),
  withLockingTxn: vi.fn(),
  lockRegistrationForUpdate: vi.fn(),
  lockRegistrationSponsorships: vi.fn(),
  releaseRegistrationUsagesTxn: vi.fn(),
  settleRegistrationTxn: vi.fn(),
  claimSponsorshipCodeTxn: vi.fn(),
  linkSponsorshipUsageTxn: vi.fn(),
  applyRegistrationSettlement: vi.fn(),
  emitSettlementEvents: vi.fn(),
  enqueueNetworkingRegistrationSyncs: vi.fn(),
  enqueueNetworkingRegistrationCreatedSync: vi.fn(),
  enqueueRealtimeOutboxEvent: vi.fn(),
  enqueueTriggeredEmailOutbox: vi.fn(),
  casIncrementRegisteredTx: vi.fn(),
  casDecrementRegisteredTx: vi.fn(),
  getEventCounterInfoTx: vi.fn(),
  updateUsageAmount: vi.fn(),
  countUsagesForSponsorship: vi.fn(),
  updateSponsorshipRow: vi.fn(),
  findFormById: vi.fn(),
  findActiveRegistrationFormById: vi.fn(),
  findAccessDetailsByIds: vi.fn(),
  findClientModuleState: vi.fn(),
  searchRegistrantsForSponsorship: vi.fn(),
  getRegistrationByIdRow: vi.fn(),
  getRegistrationByIdempotencyKeyRow: vi.fn(),
  getRegistrationClientId: vi.fn(),
  getRegistrationEditToken: vi.fn(),
  getRegistrationEditLinkSource: vi.fn(),
  listRegistrationRows: vi.fn(),
  getEventForRegistrationCreate: vi.fn(),
  getEventForRegistrationAdmin: vi.fn(),
  findRegistrationFormForEvent: vi.fn(),
  registrationExistsByEmailForm: vi.fn(),
  findRegistrationForMutation: vi.fn(),
  findRegistrationWithFormEvent: vi.fn(),
  insertRegistrationRow: vi.fn(),
  deleteRegistrationRow: vi.fn(),
  getNetworkingProfilePhotoByRegistration: vi.fn(),
  findRegistrationUsagesForRecalc: vi.fn(),
  findRegistrationUsageLinks: vi.fn(),
  deleteRegistrationUsages: vi.fn(),
  allocateReferenceNumber: vi.fn(),
  insertAuditLog: vi.fn(),
  listRegistrationAuditLogRows: vi.fn(),
  findUserNamesByIds: vi.fn(),
  listRegistrationEmailLogRows: vi.fn(),
  getRegistrationFormSchemaForEvent: vi.fn(),
  pgUniqueViolation: (err: unknown) => {
    const e = err as { code?: unknown; constraint?: unknown } | null;
    return e?.code === "23505"
      ? { constraint: typeof e.constraint === "string" ? e.constraint : "" }
      : null;
  },
};

export async function mockDbModule(importOriginal: () => Promise<unknown>) {
  const real = (await importOriginal()) as typeof import("@app/db");
  return {
    ...db,
    settlementEventPair: real.settlementEventPair,
    // The paid-count error classes are the real ones (mapped by class).
    AccessCapacityExceededError: real.AccessCapacityExceededError,
    AccessNotFoundError: real.AccessNotFoundError,
    AccessPaidCountUnderflowError: real.AccessPaidCountUnderflowError,
  };
}

/**
 * settleRegistrationTxn over the mocked rows (the real one is DB-tested in
 * packages/db), with its rules: usages recomputed against the breakdown (or
 * its sponsorshipTotal kept without usages), the caller's decision or the
 * derived status, paid places by the old → new delta, and one writer call
 * with the changed money columns.
 */
type SettleMockOptions = {
  priceBreakdown?: Record<string, unknown> & { subtotal: number; sponsorshipTotal: number; accessItems: unknown[]; calculatedBasePrice: number };
  totalAmount?: number;
  paidAmount?: number;
  paymentStatus?: string;
  paidAt?: Date | null;
  decide?: (state: Record<string, unknown>) => { paymentStatus?: string; paidAmount?: number; paidAt?: Date | null } | undefined;
  fields?: Record<string, unknown>;
};
db.settleRegistrationTxn.mockImplementation(async (tx: unknown, id: string, options: SettleMockOptions = {}) => {
  const row = await db.findRegistrationForMutation(id, tx);
  if (!row) return null;
  const before = {
    paymentStatus: row.paymentStatus,
    paidAt: row.paidAt ?? null,
    paidAmount: row.paidAmount,
    totalAmount: row.totalAmount,
    sponsorshipAmount: row.sponsorshipAmount,
    priceBreakdown: row.priceBreakdown,
  };
  const repriced = options.priceBreakdown !== undefined;
  const gross = options.priceBreakdown ?? before.priceBreakdown;
  const usages = (await db.findRegistrationUsagesForRecalc(id, tx)) ?? [];
  const covered = new Set<string>();
  let sponsorship = usages.length === 0 ? gross.sponsorshipTotal : 0;
  for (const usage of usages) {
    for (const accessId of usage.sponsorship.coveredAccessIds ?? []) covered.add(accessId);
    const amount = calculateApplicableAmount(usage.sponsorship, {
      totalAmount: gross.subtotal,
      baseAmount: gross.calculatedBasePrice,
      accessTypeIds: gross.accessItems.map((item: { accessId: string }) => item.accessId),
      priceBreakdown: gross,
    });
    sponsorship += amount;
    if (amount !== usage.amountApplied) await db.updateUsageAmount(tx, usage.id, amount);
  }
  sponsorship = Math.min(sponsorship, gross.subtotal);
  const priceBreakdown = netBreakdown(gross, sponsorship);
  const totalAmount = options.totalAmount ?? (repriced ? priceBreakdown.subtotal : before.totalAmount);
  const decision = options.decide?.({ before, gross: totalAmount, sponsorship, net: Math.max(0, totalAmount - sponsorship) }) ?? {
    paymentStatus: options.paymentStatus,
    paidAmount: options.paidAmount,
    paidAt: options.paidAt,
  };
  const paidAmount = decision.paidAmount ?? before.paidAmount;
  let paymentStatus: string;
  let paidAt: Date | null;
  if (decision.paymentStatus !== undefined) {
    paymentStatus = decision.paymentStatus;
    paidAt = decision.paidAt !== undefined ? decision.paidAt : before.paidAt;
  } else {
    const derived = deriveSettlement({
      gross: totalAmount,
      sponsorship,
      paid: paidAmount,
      currentStatus: before.paymentStatus,
      paidAt: before.paidAt,
      now: new Date(),
    });
    paymentStatus = derived.status;
    paidAt = derived.paidAt;
  }
  const oldPaid = paidAccessQuantities(before.paymentStatus, before.priceBreakdown, covered);
  const newPaid = paidAccessQuantities(paymentStatus, priceBreakdown, covered);
  const paidAccess = { incremented: [] as string[], decremented: [] as string[] };
  for (const accessId of new Set([...oldPaid.keys(), ...newPaid.keys()])) {
    const delta = (newPaid.get(accessId) ?? 0) - (oldPaid.get(accessId) ?? 0);
    if (delta > 0) paidAccess.incremented.push(accessId);
    if (delta < 0) paidAccess.decremented.push(accessId);
  }
  const settlement: Record<string, unknown> = {};
  if (repriced) Object.assign(settlement, { priceBreakdown, totalAmount, sponsorshipAmount: sponsorship });
  if (decision.paidAmount !== undefined) settlement.paidAmount = paidAmount;
  if (paymentStatus !== before.paymentStatus) settlement.paymentStatus = paymentStatus;
  if ((paidAt?.getTime() ?? null) !== (before.paidAt?.getTime() ?? null)) settlement.paidAt = paidAt;
  await db.applyRegistrationSettlement(tx, { registrationId: id, settlement, fields: options.fields });
  const after = { paymentStatus, paidAt, paidAmount, totalAmount, sponsorshipAmount: sponsorship, priceBreakdown };
  return { written: true, eventId: row.eventId, before, after, coveredAccessIds: [...covered], paidAccess };
});

// emitSettlementEvents with @app/db's body, over the mocked primitives.
db.emitSettlementEvents.mockImplementation(
  async (tx: unknown, events: Array<{ type: string; eventId?: string; payload: { id: unknown } }>) => {
    await db.enqueueNetworkingRegistrationSyncs(
      tx,
      events.flatMap((ev) =>
        (ev.type === "registration.updated" || ev.type === "registration.paymentConfirmed") && ev.eventId
          ? [{ registrationId: String(ev.payload.id), eventId: ev.eventId }]
          : [],
      ),
    );
    const results: unknown[] = [];
    for (const ev of events) results.push(await db.enqueueRealtimeOutboxEvent(tx, ev));
    return results;
  },
);

/**
 * The columns the settlement writer was asked to set by its call `n`: the
 * other fields, the settlement, and the amounts the writer derives from a
 * written breakdown.
 */
export function writtenPatch(n = 0): RegistrationPatch {
  const input = db.applyRegistrationSettlement.mock.calls[n]?.[1] as ApplyRegistrationSettlementInput | undefined;
  if (!input) throw new Error(`applyRegistrationSettlement call ${n} not made`);
  const pb = input.settlement.priceBreakdown;
  return {
    ...input.fields,
    ...input.settlement,
    ...(pb
      ? {
          baseAmount: pb.calculatedBasePrice,
          accessAmount: pb.accessTotal,
          discountAmount: calculateDiscountAmount(pb.appliedRules),
        }
      : {}),
  };
}

// --- @app/integrations + file-type mocks (payment-proof upload path) --------
export const integ = {
  getStorageProvider: vi.fn(),
  compressFile: vi.fn(),
};

export async function mockIntegrationsModule(importOriginal: () => Promise<unknown>) {
  return {
    // Keep the real extractStorageKeyFromUrl (pure); stub the storage/IO fns.
    ...((await importOriginal()) as Record<string, unknown>),
    ...integ,
  };
}

export const ft = { fileTypeFromBuffer: vi.fn() };

export const FUTURE = new Date(Date.now() + 86_400_000);

export function emptyBreakdown(total = 0) {
  return {
    basePrice: total,
    appliedRules: [],
    calculatedBasePrice: total,
    accessItems: [],
    accessTotal: 0,
    subtotal: total,
    sponsorships: [],
    sponsorshipTotal: 0,
    total,
    currency: "TND",
    droppedAccessItems: [],
  };
}

/** A stored breakdown whose sponsorship matches the sponsorship_amount column. */
export function sponsoredBreakdown(total: number, sponsorship: number) {
  return { ...emptyBreakdown(total), sponsorshipTotal: sponsorship, total: total - sponsorship };
}

export function makeRegRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "reg1",
    formId: "form1",
    eventId: "ev1",
    email: "a@b.com",
    firstName: "A",
    lastName: "B",
    phone: null,
    paymentStatus: "PENDING",
    paidAmount: 0,
    totalAmount: 100,
    sponsorshipAmount: 0,
    sponsorshipCode: null,
    paidAt: null,
    note: null,
    role: "PARTICIPANT",
    accessTypeIds: [],
    formData: {},
    priceBreakdown: emptyBreakdown(100),
    editToken: "tok-64",
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    form: { id: "form1", name: "Reg Form" },
    event: { id: "ev1", name: "Ev", slug: "ev", clientId: "c1" },
    accessCheckIns: [],
    ...overrides,
  };
}

// Registration form with one free-text answer (admin create/edit load it).
export const ANSWER_SCHEMA = {
  steps: [{ id: "s1", title: "Step", fields: [{ id: "answer", type: "text" }] }],
};

export function activeClient() {
  return { active: true, enabledModules: ["registrations", "pricing"] };
}

// --- response shapes (0.5): internal columns and the public DTO keys --------
// Every internal column populated with a recognisable sentinel.
const SENTINELS = [
  "tok-64",
  "idem-key-1",
  "SECRET-NOTE",
  "staff-user-1",
  "https://link-base.example",
  "proofs/secret-proof.pdf",
  "BANKREF-1",
];
export const internalRow = (overrides: Record<string, unknown> = {}) =>
  makeRegRow({
    referenceNumber: "26-EV-001",
    networkingOptIn: true,
    paymentMethod: "BANK_TRANSFER",
    labName: null,
    currency: "TND",
    baseAmount: 100,
    discountAmount: 0,
    accessAmount: 0,
    submittedAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    lastEditedAt: null,
    formSchemaVersion: 3,
    droppedAccessIds: [],
    idempotencyKey: "idem-key-1",
    note: "SECRET-NOTE",
    checkedInAt: new Date("2026-01-02T00:00:00.000Z"),
    checkedInBy: "staff-user-1",
    linkBaseUrl: "https://link-base.example",
    paymentProofUrl: "proofs/secret-proof.pdf",
    paymentReference: "BANKREF-1",
    ...overrides,
  });
export const PUBLIC_KEYS = [
  "accessAmount",
  "accessSelections",
  "baseAmount",
  "createdAt",
  "currency",
  "discountAmount",
  "droppedAccessSelections",
  "email",
  "event",
  "eventId",
  "firstName",
  "form",
  "formData",
  "formId",
  "hasPaymentProof",
  "id",
  "labName",
  "lastEditedAt",
  "lastName",
  "networkingOptIn",
  "paidAmount",
  "paidAt",
  "paymentMethod",
  "paymentStatus",
  "phone",
  "priceBreakdown",
  "referenceNumber",
  "sponsorshipAmount",
  "sponsorshipCode",
  "submittedAt",
  "totalAmount",
  "updatedAt",
];
export const withoutSentinels = (value: unknown, allow: string[] = []) => {
  const json = JSON.stringify(value);
  for (const sentinel of SENTINELS.filter((x) => !allow.includes(x))) {
    expect(json).not.toContain(sentinel);
  }
};

// --- per-test defaults --------------------------------------------------------
export type AccessMock = {
  assertAccessSelectionRequirement: ReturnType<typeof vi.fn>;
  validateAccessSelections: ReturnType<typeof vi.fn>;
  incrementAccessRegisteredCountTx: ReturnType<typeof vi.fn>;
  decrementAccessRegisteredCountTx: ReturnType<typeof vi.fn>;
  syncPaidCountDelta: ReturnType<typeof vi.fn>;
  getAlreadyCoveredAccessIds: ReturnType<typeof vi.fn>;
  handleCapacityReached: ReturnType<typeof vi.fn>;
};
export type PricingMock = { calculatePrice: ReturnType<typeof vi.fn> };
export type StorageMock = {
  uploadPrivate: ReturnType<typeof vi.fn>;
  getSignedUrl: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

/**
 * Clear every mock and install the defaults each test starts from; returns
 * fresh AccessService, PricingService and storage doubles.
 */
export function installServiceMocks(): {
  access: AccessMock;
  pricing: PricingMock;
  storage: StorageMock;
} {
  vi.clearAllMocks();
  db.withTxn.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
  db.withLockingTxn.mockImplementation((fn: (tx: unknown) => unknown) => db.withTxn(fn));
  db.lockRegistrationForUpdate.mockResolvedValue(true);
  db.enqueueRealtimeOutboxEvent.mockResolvedValue(true);
  db.enqueueTriggeredEmailOutbox.mockResolvedValue(true);
  db.enqueueNetworkingRegistrationSyncs.mockResolvedValue([]);
  db.enqueueNetworkingRegistrationCreatedSync.mockResolvedValue(true);
  db.casIncrementRegisteredTx.mockResolvedValue(true);
  db.casDecrementRegisteredTx.mockResolvedValue(true);
  db.allocateReferenceNumber.mockResolvedValue("26-EV-001");
  db.insertAuditLog.mockResolvedValue(undefined);
  db.applyRegistrationSettlement.mockResolvedValue(true);
  db.findAccessDetailsByIds.mockResolvedValue([]);
  db.findClientModuleState.mockResolvedValue(activeClient());
  db.findRegistrationUsagesForRecalc.mockResolvedValue([]);
  db.getRegistrationFormSchemaForEvent.mockResolvedValue({ schema: ANSWER_SCHEMA });

  ft.fileTypeFromBuffer.mockResolvedValue({ mime: "application/pdf", ext: "pdf" });
  integ.compressFile.mockResolvedValue({
    buffer: Buffer.from("x"),
    contentType: "application/pdf",
    ext: "pdf",
  });
  const storage: StorageMock = {
    uploadPrivate: vi.fn().mockResolvedValue("event/reg1/proof.pdf"),
    getSignedUrl: vi.fn().mockResolvedValue("https://signed"),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  integ.getStorageProvider.mockReturnValue(storage);

  const access: AccessMock = {
    assertAccessSelectionRequirement: vi.fn().mockResolvedValue(undefined),
    validateAccessSelections: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
    incrementAccessRegisteredCountTx: vi.fn().mockResolvedValue(undefined),
    decrementAccessRegisteredCountTx: vi.fn().mockResolvedValue(undefined),
    syncPaidCountDelta: vi.fn().mockResolvedValue(undefined),
    handleCapacityReached: vi.fn().mockResolvedValue(0),
    getAlreadyCoveredAccessIds: vi.fn().mockResolvedValue(new Set()),
  };
  const pricing: PricingMock = { calculatePrice: vi.fn().mockResolvedValue(emptyBreakdown(100)) };

  return { access, pricing, storage };
}
