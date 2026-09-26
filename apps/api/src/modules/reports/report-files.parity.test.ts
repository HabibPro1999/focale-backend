import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import type {
  AccessRegistrantReportRow,
  CheckInReportRow,
  CheckInReportScope,
  EventSummaryData,
  SponsorshipReportRow,
} from "@app/db";
import { FULLY_SETTLED_STATUSES } from "@app/shared";

// 3.7b output parity: the streamed summary, access-registrants, sponsorships
// and check-in ZIP downloads must read back exactly like the pre-3.7b
// in-memory builders (verbatim in __testing__/) on the same fixtures. The db
// seam is faked from the legacy data shapes, rows in small pages; the real
// SQL behind the fakes is covered by report-export-reads.db.test.ts.

const PAGE = 2;

vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withExportStatementTimeout: vi.fn((fn: (tx: unknown) => unknown) => fn({ tx: true })),
  getEventSummaryData: vi.fn(),
  getReportEventAndAccess: vi.fn(),
  iterateAccessRegistrantsForReport: vi.fn(),
  getSponsorshipsReportData: vi.fn(),
  iterateSponsorshipsForReport: vi.fn(),
  iterateCheckInReportRows: vi.fn(),
}));

import * as db from "@app/db";
import { collect, readBack } from "../../core/exports/__testing__/export-output";
import {
  prepareAccessRegistrantsReport,
  prepareCheckInReport,
  prepareEventSummary,
  prepareSponsorshipsReport,
} from "./excel-generator";
import {
  generateAccessRegistrantsReport,
  generateCheckInReport,
  generateEventSummary,
  generateSponsorshipsReport,
} from "./__testing__/legacy-excel-generator";
import type { LegacySponsorshipReportRow } from "./__testing__/legacy-report-data";

const m = db as unknown as Record<string, ReturnType<typeof vi.fn>>;

async function* pagesOf<T>(rows: T[]): AsyncGenerator<T[]> {
  for (let i = 0; i < rows.length; i += PAGE) yield rows.slice(i, i + PAGE);
}

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const EVENT = { name: "Congrès — Médecine 2026", slug: "congres-2026" };
const LUNCH = "acc-lunch";
const WORKSHOP = "acc-workshop";
const EMPTY = "acc-empty";
const GONE = "acc-gone";

const accessItems = [
  { id: LUNCH, name: "Déjeuner", type: "MEAL" },
  { id: WORKSHOP, name: "Atelier : échographie cardiaque avancée (niveau 2)", type: "WORKSHOP" },
  { id: EMPTY, name: "ورشة", type: "WORKSHOP" },
];

const minute = (n: number) => new Date(Date.UTC(2026, 2, 1, 9, 0) + n * 60_000);
// 23:30 UTC on 31 Dec is 00:30 on 1 Jan in Tunis.
const LATE_UTC = new Date("2025-12-31T23:30:00Z");

interface FixtureRegistration {
  id: string;
  referenceNumber: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  paymentStatus: string;
  paymentMethod: string | null;
  totalAmount: number;
  sponsorshipAmount: number;
  currency: string;
  submittedAt: Date;
  checkedInAt: Date | null;
  accessTypeIds: string[];
  accessCheckIns: Array<{ accessId: string; checkedInAt: Date }>;
}

function reg(n: number, values: Partial<FixtureRegistration>): FixtureRegistration {
  return {
    id: `reg-${String(n).padStart(2, "0")}`,
    referenceNumber: `26-EV-${String(n).padStart(3, "0")}`,
    firstName: `Prénom ${n}`,
    lastName: `Nom ${n}`,
    email: `p${n}@example.test`,
    phone: n % 2 === 0 ? `+216 20 000 0${n}` : null,
    paymentStatus: "PAID",
    paymentMethod: "BANK_TRANSFER",
    totalAmount: 100 * n,
    sponsorshipAmount: 0,
    currency: "TND",
    submittedAt: minute(n),
    checkedInAt: null,
    accessTypeIds: [],
    accessCheckIns: [],
    ...values,
  };
}

/** Submission order (oldest first), as the check-in read returned them. */
const registrations: FixtureRegistration[] = [
  reg(1, {
    accessTypeIds: [LUNCH, WORKSHOP],
    checkedInAt: minute(500),
    accessCheckIns: [{ accessId: WORKSHOP, checkedInAt: LATE_UTC }],
  }),
  reg(2, { paymentStatus: "PENDING", accessTypeIds: [LUNCH], firstName: "=HYPERLINK(1)" }),
  reg(3, {
    paymentStatus: "SPONSORED",
    accessTypeIds: [LUNCH, LUNCH, GONE],
    checkedInAt: LATE_UTC,
    accessCheckIns: [{ accessId: LUNCH, checkedInAt: minute(600) }],
  }),
  reg(4, { paymentStatus: "WAIVED", firstName: null, lastName: null, accessTypeIds: [WORKSHOP] }),
  reg(5, { paymentStatus: "VERIFYING", referenceNumber: null, accessTypeIds: [LUNCH] }),
  reg(6, {
    paymentStatus: "PARTIAL",
    accessTypeIds: [WORKSHOP, LUNCH],
    accessCheckIns: [
      { accessId: LUNCH, checkedInAt: minute(700) },
      { accessId: GONE, checkedInAt: minute(701) },
    ],
  }),
  reg(7, { paymentStatus: "REFUNDED", submittedAt: LATE_UTC, accessTypeIds: [] }),
  reg(8, { paymentStatus: "PAID", checkedInAt: minute(800), accessTypeIds: [WORKSHOP] }),
  reg(9, { paymentStatus: "PENDING", accessTypeIds: [LUNCH, WORKSHOP] }),
].sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime() || a.id.localeCompare(b.id));

/** Export order (newest first). */
const newestFirst = [...registrations].reverse();

function sponsorship(
  n: number,
  labName: string,
  values: Partial<LegacySponsorshipReportRow> = {},
): LegacySponsorshipReportRow & { id: string } {
  return {
    id: `sp-${n}`,
    code: `SP-${String(n).padStart(3, "0")}`,
    status: "USED",
    beneficiaryName: `Bénéficiaire ${n}`,
    beneficiaryEmail: `b${n}@example.test`,
    beneficiaryPhone: n % 2 === 0 ? null : `+216 50 00 00 0${n}`,
    beneficiaryAddress: n % 3 === 0 ? null : `${n} rue de Carthage`,
    coversBasePrice: n % 2 === 1,
    coveredAccessIds: n % 2 === 0 ? [LUNCH, GONE] : [WORKSHOP],
    totalAmount: 150 * n,
    createdAt: minute(n * 10),
    batch: {
      labName,
      contactName: `Contact ${n}`,
      email: `lab${n}@example.test`,
      phone: n % 2 === 0 ? `+216 71 00 00 0${n}` : null,
    },
    usages: [],
    ...values,
  };
}

/** Newest first, as the sponsorship reads returned them. */
const sponsorships = [
  sponsorship(1, "Zeta Pharma", {
    usages: [
      {
        amountApplied: 100,
        appliedAt: minute(20),
        registration: { firstName: "Ana", lastName: null, email: "ana@example.test" },
      },
      { amountApplied: 50, appliedAt: LATE_UTC, registration: null },
    ],
  }),
  sponsorship(2, "élan Labs"),
  sponsorship(3, "Élan labs ", {
    usages: [
      {
        amountApplied: 450,
        appliedAt: minute(40),
        registration: { firstName: null, lastName: null, email: "anon@example.test" },
      },
    ],
  }),
  sponsorship(4, "Alpha", { status: "CANCELLED", beneficiaryName: "=1+1" }),
  sponsorship(5, "élan Labs"),
].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

// ----------------------------------------------------------------------------
// The db seam, derived from the legacy data
// ----------------------------------------------------------------------------

/** What the SQL aggregates compute (see getEventSummaryData). */
function summaryOf(rows: FixtureRegistration[]): EventSummaryData {
  const byStatus = new Map<string, number>();
  const byAccess = new Map<string, { registered: number; confirmed: number }>();
  for (const r of rows) {
    byStatus.set(r.paymentStatus, (byStatus.get(r.paymentStatus) ?? 0) + 1);
    const confirmed = (FULLY_SETTLED_STATUSES as readonly string[]).includes(r.paymentStatus);
    for (const accessId of r.accessTypeIds) {
      const counts = byAccess.get(accessId) ?? { registered: 0, confirmed: 0 };
      counts.registered++;
      if (confirmed) counts.confirmed++;
      byAccess.set(accessId, counts);
    }
  }
  return {
    event: EVENT,
    accessTypes: accessItems,
    total: rows.length,
    byStatus: [...byStatus].map(([paymentStatus, count]) => ({ paymentStatus, count })),
    byAccess: [...byAccess].map(([accessId, counts]) => ({ accessId, ...counts })),
  };
}

function accessRegistrantRow(r: FixtureRegistration): AccessRegistrantReportRow {
  return {
    id: r.id,
    firstName: r.firstName,
    lastName: r.lastName,
    email: r.email,
    phone: r.phone,
    paymentStatus: r.paymentStatus,
    totalAmount: r.totalAmount,
    currency: r.currency,
    submittedAt: r.submittedAt,
  };
}

function checkInRows(scope: CheckInReportScope): CheckInReportRow[] {
  const rows: CheckInReportRow[] = [];
  for (const r of registrations) {
    if (scope.accessId !== undefined && !r.accessTypeIds.includes(scope.accessId)) continue;
    const checkedInAt =
      scope.accessId === undefined
        ? r.checkedInAt
        : (r.accessCheckIns.find((c) => c.accessId === scope.accessId)?.checkedInAt ?? null);
    if ((checkedInAt !== null) !== scope.checkedIn) continue;
    rows.push({
      id: r.id,
      referenceNumber: r.referenceNumber,
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      phone: r.phone,
      paymentStatus: r.paymentStatus,
      submittedAt: r.submittedAt,
      checkedInAt,
    });
  }
  return rows;
}

function installFakes(fixture: {
  registrations: FixtureRegistration[];
  accessItems: typeof accessItems;
  sponsorships: Array<LegacySponsorshipReportRow & { id: string }>;
}) {
  m.getEventSummaryData!.mockResolvedValue({
    ...summaryOf(fixture.registrations),
    accessTypes: fixture.accessItems,
  });
  m.getReportEventAndAccess!.mockResolvedValue({ event: EVENT, accessItems: fixture.accessItems });
  m.iterateAccessRegistrantsForReport!.mockImplementation((_eventId: string, accessId: string) =>
    pagesOf(
      [...fixture.registrations]
        .reverse()
        .filter((r) => r.accessTypeIds.includes(accessId))
        .map(accessRegistrantRow),
    ),
  );
  m.iterateCheckInReportRows!.mockImplementation((_eventId: string, scope: CheckInReportScope) =>
    pagesOf(checkInRows(scope).filter((row) => fixture.registrations.some((r) => r.id === row.id))),
  );
  const byId = new Map(fixture.sponsorships.map((s) => [s.id, s]));
  m.getSponsorshipsReportData!.mockResolvedValue({
    event: EVENT,
    currency: "EUR",
    accessItems: fixture.accessItems.map(({ id, name }) => ({ id, name })),
    keys: fixture.sponsorships.map((s) => ({
      id: s.id,
      labName: s.batch.labName,
      totalAmount: s.totalAmount,
      createdAt: s.createdAt,
    })),
  });
  m.iterateSponsorshipsForReport!.mockImplementation((ids: readonly string[]) =>
    pagesOf(ids.map((id) => byId.get(id)! as SponsorshipReportRow)),
  );
}

const legacyInputs = (fixture: Parameters<typeof installFakes>[0]) => ({
  summary: {
    event: EVENT,
    accessTypes: fixture.accessItems,
    registrations: fixture.registrations.map((r) => ({
      id: r.id,
      paymentStatus: r.paymentStatus,
      paymentMethod: r.paymentMethod,
      accessTypeIds: r.accessTypeIds,
      sponsorshipAmount: r.sponsorshipAmount,
      totalAmount: r.totalAmount,
    })),
  },
  accessRegistrants: {
    event: EVENT,
    accessItems: fixture.accessItems,
    registrations: [...fixture.registrations].reverse(),
  },
  sponsorships: {
    event: EVENT,
    currency: "EUR",
    accessItems: fixture.accessItems.map(({ id, name }) => ({ id, name })),
    sponsorships: fixture.sponsorships,
  },
  checkIn: {
    event: EVENT,
    accessItems: fixture.accessItems.map(({ id, name }) => ({ id, name })),
    registrations: fixture.registrations,
  },
});

const fullFixture = { registrations, accessItems, sponsorships };
const emptyFixture = { registrations: [], accessItems: [], sponsorships: [] };

beforeEach(() => {
  vi.clearAllMocks();
  // "Report generated" lines and file dates: the same instant for both builders.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-02T10:15:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each([
  ["with registrations, access items and sponsorships", fullFixture],
  ["for an empty event", emptyFixture],
])("report file parity %s", (_label, fixture) => {
  beforeEach(() => installFakes(fixture));
  const legacy = legacyInputs(fixture);

  it("event summary", async () => {
    const download = await prepareEventSummary("event-1");
    const expected = await generateEventSummary(legacy.summary);

    expect(download.filename).toBe(expected.filename);
    expect(await readBack(await collect(download))).toEqual(await readBack(expected.data));
  });

  it("access registrants", async () => {
    const download = await prepareAccessRegistrantsReport("event-1");
    const expected = await generateAccessRegistrantsReport(legacy.accessRegistrants);

    expect(download.filename).toBe(expected.filename);
    expect(await readBack(await collect(download))).toEqual(await readBack(expected.data));
  });

  it("sponsorships", async () => {
    const download = await prepareSponsorshipsReport("event-1", { status: "USED" });
    const expected = await generateSponsorshipsReport(legacy.sponsorships);

    expect(download.filename).toBe(expected.filename);
    expect(m.getSponsorshipsReportData).toHaveBeenCalledWith(
      "event-1",
      { status: "USED" },
      { tx: true },
    );
    expect(await readBack(await collect(download))).toEqual(await readBack(expected.data));
  });

  it("check-in ZIP", async () => {
    const download = await prepareCheckInReport("event-1");
    const expected = await generateCheckInReport(legacy.checkIn);

    expect(download.filename).toBe(expected.filename);
    const zip = await JSZip.loadAsync(await collect(download), { checkCRC32: true });
    const legacyZip = await JSZip.loadAsync(expected.data);
    expect(Object.keys(zip.files)).toEqual(Object.keys(legacyZip.files));
    for (const name of Object.keys(legacyZip.files)) {
      expect(
        await readBack(await zip.file(name)!.async("nodebuffer")),
        name,
      ).toEqual(await readBack(await legacyZip.file(name)!.async("nodebuffer")));
    }
  });
});

describe("sponsorships order", () => {
  beforeEach(() => installFakes(fullFixture));

  it("reads the rows by lab (French collation, case and accents ignored), newest first within a lab", async () => {
    await collect(await prepareSponsorshipsReport("event-1"));

    // "Élan labs " sorts after "élan Labs" (trailing space) but shares its
    // lab total (trimmed, lower-cased), as before.
    const [ids] = m.iterateSponsorshipsForReport!.mock.calls[0] as [string[]];
    expect(ids).toEqual(["sp-4", "sp-5", "sp-2", "sp-3", "sp-1"]);
  });
});
