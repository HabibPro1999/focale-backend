import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportRegistrationsBody, ExportLanguage } from "@app/contracts";
import type {
  ExportRegistrationRow,
  ModularRegistrationRow,
  RegistrationTableColumns,
  SponsorshipLabDetail,
} from "@app/db";

// 3.7 output parity: each streamed export (ExcelJS WorkbookWriter, row
// commit, keyset pages) must read back exactly like the pre-3.7 in-memory
// builder on the same fixtures. The pre-3.7 code lives, verbatim, in
// __testing__/ (test-only). The db seam is faked: rows come in small pages.

const PAGE = 3;

vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withExportStatementTimeout: vi.fn((fn: (tx: unknown) => unknown) => fn({ tx: true })),
  getEventSlug: vi.fn(),
  getEventSlugAndName: vi.fn(),
  getRegistrationTableColumns: vi.fn(),
  getEventAccessNames: vi.fn(),
  getSponsorshipLabDetails: vi.fn(),
  getRegistrationFormDataKeys: vi.fn(),
  iterateRegistrationsForExport: vi.fn(),
  iterateRegistrationsForModularExport: vi.fn(),
}));

import * as db from "@app/db";
import { ReportsService } from "./reports.service";
import { prepareRegistrationsWorkbook } from "./registrations-export-builder";
import { collect, readBack } from "../../core/exports/__testing__/export-output";
import { legacyBuildRegistrationsWorkbook } from "./__testing__/legacy-registrations-workbook";
import { legacyCsv, legacyJson, legacyXlsx } from "./__testing__/legacy-registrations-export";

const m = db as unknown as Record<string, ReturnType<typeof vi.fn>>;

function pagesOf<T>(rows: T[]) {
  return async function* () {
    for (let i = 0; i < rows.length; i += PAGE) yield rows.slice(i, i + PAGE);
  };
}

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

const ACCESS_LUNCH = "3f1f0c1e-0000-4000-8000-000000000001";
const ACCESS_WORKSHOP = "3f1f0c1e-0000-4000-8000-000000000002";
const ACCESS_GONE = "3f1f0c1e-0000-4000-8000-000000000003";

const accessItems = [
  { id: ACCESS_LUNCH, name: "Déjeuner" },
  { id: ACCESS_WORKSHOP, name: "Atelier : échographie" },
];

const tableColumns: RegistrationTableColumns = {
  fixedColumns: [],
  formColumns: [
    {
      id: "specialty",
      label: "Spécialité",
      type: "dropdown",
      options: [
        { id: "cardio", label: "Cardiologie" },
        { id: "other", label: "Autre" },
      ],
      mergeWith: { fieldId: "specialty_other", triggerValue: "other" },
    },
    {
      id: "topics",
      label: "Sujets",
      type: "checkbox",
      options: [
        { id: "t1", label: "Imagerie" },
        { id: "t2", label: "Rythmologie" },
      ],
    },
    { id: "bio", label: "Bio", type: "textarea" },
    { id: "city", label: "Ville", type: "text" },
  ],
};

const labDetails: SponsorshipLabDetail[] = [
  {
    code: "LAB-A",
    beneficiaryAddress: "12 rue de Carthage\nTunis",
    batch: { labName: "Lab A", contactName: "Sami", email: "a@lab.test", phone: "+216 71 000 000" },
  },
  {
    code: "LAB-B",
    beneficiaryAddress: null,
    batch: { labName: "مخبر ب", contactName: "Leïla", email: "b@lab.test", phone: null },
  },
];

const minute = (n: number) => new Date(Date.UTC(2026, 8, 1, 8, 0) - n * 60_000);

function registration(n: number, over: Partial<ModularRegistrationRow> = {}): ModularRegistrationRow {
  return {
    id: `00000000-0000-4000-8000-00000000000${n}`,
    formId: "form-1",
    eventId: "event-1",
    formData: {},
    networkingOptIn: null,
    submittedAt: minute(n),
    formSchemaVersion: 1,
    email: `person${n}@example.test`,
    firstName: `Prénom ${n}`,
    lastName: null,
    phone: null,
    referenceNumber: `REF-${n}`,
    paymentStatus: "PENDING",
    totalAmount: 0,
    paidAmount: 0,
    currency: "TND",
    paymentMethod: null,
    paymentReference: null,
    paymentProofUrl: null,
    priceBreakdown: {},
    baseAmount: 0,
    discountAmount: 0,
    accessAmount: 0,
    sponsorshipCode: null,
    sponsorshipAmount: 0,
    labName: null,
    paidAt: null,
    createdAt: minute(n + 1),
    updatedAt: minute(n),
    lastEditedAt: null,
    editToken: null,
    linkBaseUrl: null,
    idempotencyKey: null,
    note: null,
    role: "PARTICIPANT",
    accessTypeIds: [],
    droppedAccessIds: [],
    checkedInAt: null,
    checkedInBy: null,
    accessCheckIns: [],
    transactions: [],
    ...over,
  };
}

const registrations: ModularRegistrationRow[] = [
  registration(1, {
    lastName: "=HYPERLINK(\"https://evil.test\")",
    phone: "+216 20 000 000",
    paymentStatus: "PAID",
    paymentMethod: "BANK_TRANSFER",
    totalAmount: 450_000,
    paidAmount: 450_000,
    baseAmount: 400_000,
    accessAmount: 50_000,
    paidAt: minute(0),
    paymentReference: "VIR-1",
    paymentProofUrl: "https://files.test/proof.pdf",
    formData: { specialty: "cardio", topics: ["t1", "t2"], bio: "Ligne 1\nLigne 2", city: "Sfax" },
    accessTypeIds: [ACCESS_LUNCH, ACCESS_WORKSHOP],
    accessCheckIns: [{ accessId: ACCESS_LUNCH, checkedInAt: minute(-60) }],
    transactions: [
      {
        type: "PAYMENT",
        amount: 450_000,
        method: "BANK_TRANSFER",
        reference: "VIR-1",
        note: null,
        performedBy: "admin@focale.test",
        createdAt: minute(0),
      },
    ],
    checkedInAt: minute(-61),
    checkedInBy: "Hall A",
    role: "SPEAKER",
    note: "@cmd",
  }),
  registration(2, {
    formData: { specialty: "other", specialty_other: "Médecine du sport", topics: ["t9"], city: 42 },
    sponsorshipCode: "LAB-A",
    labName: "Lab A",
    paymentStatus: "SPONSORED",
    paymentMethod: "LAB_SPONSORSHIP",
    sponsorshipAmount: 300_000,
    droppedAccessIds: [ACCESS_WORKSHOP, ACCESS_GONE],
  }),
  registration(3, { formData: [], lastEditedAt: minute(1), role: "MODERATOR" }),
  registration(4, {
    sponsorshipCode: "LAB-B",
    formData: { specialty: "unknown-option", bio: { nested: true } },
    firstName: null,
    email: "arabic@example.test",
    lastName: "بن علي",
  }),
  registration(5, { sponsorshipCode: "LAB-A", paymentStatus: "REFUNDED", formSchemaVersion: 3 }),
  registration(6, { sponsorshipCode: "LAB-MISSING", currency: "EUR", discountAmount: 10_000 }),
  registration(7, {
    paymentStatus: "PARTIAL",
    paymentMethod: "CASH",
    totalAmount: 100,
    paidAmount: 40,
    transactions: [
      {
        type: "PAYMENT",
        amount: 40,
        method: null,
        reference: null,
        note: "acompte",
        performedBy: null,
        createdAt: minute(2),
      },
      {
        type: "ADJUSTMENT",
        amount: -5,
        method: "CASH",
        reference: "ADJ",
        note: null,
        performedBy: "ops",
        createdAt: minute(1),
      },
    ],
  }),
];

function body(language: ExportLanguage, columns: Partial<ExportRegistrationsBody["columns"]> = {}) {
  return {
    filters: {},
    language,
    columns: {
      identity: [],
      submission: [],
      payment: [],
      sponsorship: [],
      accessItemIds: [],
      checkinAccessIds: [],
      includeGlobalCheckin: false,
      includeTransactions: false,
      includeDroppedAccess: false,
      formFieldIds: [],
      ...columns,
    },
  } satisfies ExportRegistrationsBody;
}

const everyColumn: Partial<ExportRegistrationsBody["columns"]> = {
  identity: ["id", "referenceNumber", "email", "firstName", "lastName", "phone", "role", "note"],
  submission: ["submittedAt", "createdAt", "updatedAt", "lastEditedAt", "formSchemaVersion"],
  payment: [
    "paymentStatus",
    "paymentMethod",
    "currency",
    "totalAmount",
    "paidAmount",
    "baseAmount",
    "accessAmount",
    "discountAmount",
    "sponsorshipAmount",
    "paymentReference",
    "paymentProofUrl",
    "paidAt",
  ],
  sponsorship: [
    "sponsorshipCode",
    "labName",
    "labContactName",
    "labEmail",
    "labPhone",
    "beneficiaryAddress",
  ],
  accessItemIds: [ACCESS_LUNCH, ACCESS_WORKSHOP],
  checkinAccessIds: [ACCESS_LUNCH, ACCESS_WORKSHOP],
  includeGlobalCheckin: true,
  includeTransactions: true,
  includeDroppedAccess: true,
  formFieldIds: ["specialty", "topics", "bio", "city", "specialty_other", "not-a-field"],
};

beforeEach(() => {
  vi.clearAllMocks();
  m.getEventSlugAndName.mockResolvedValue({ slug: "congres-2026", name: "Congrès 2026" });
  m.getRegistrationTableColumns.mockResolvedValue(tableColumns);
  m.getEventAccessNames.mockResolvedValue(accessItems);
  m.getSponsorshipLabDetails.mockImplementation(async (_eventId: string, codes: string[]) =>
    labDetails.filter((d) => codes.includes(d.code)),
  );
});

// ----------------------------------------------------------------------------
// POST modular workbook
// ----------------------------------------------------------------------------

describe("modular registrations workbook parity (3.7)", () => {
  async function both(requestBody: ExportRegistrationsBody, rows: ModularRegistrationRow[]) {
    m.iterateRegistrationsForModularExport.mockImplementation(pagesOf(rows));
    const legacy = await legacyBuildRegistrationsWorkbook(requestBody, {
      event: { slug: "congres-2026", name: "Congrès 2026" },
      tableColumns,
      accessItems,
      registrations: rows,
      labDetails: labDetails.filter((d) => rows.some((r) => r.sponsorshipCode === d.code)),
    });
    const download = await prepareRegistrationsWorkbook("event-1", requestBody);
    const streamed = await collect(download);
    return { legacy, download, streamed };
  }

  it.each(["fr", "en", "ar"] as const)(
    "every column group reads back like the in-memory workbook (%s)",
    async (language) => {
      const { legacy, download, streamed } = await both(body(language, everyColumn), registrations);

      expect(download.filename).toBe(legacy.filename);
      const expected = await readBack(legacy.data);
      expect(expected[0]!.rows).toHaveLength(registrations.length + 2);
      expect(await readBack(streamed)).toEqual(expected);
    },
  );

  it("matches for the email fallback and for an empty result", async () => {
    const fallback = await both(body("fr"), registrations);
    expect(await readBack(fallback.streamed)).toEqual(await readBack(fallback.legacy.data));

    const empty = await both(body("en", everyColumn), []);
    expect(await readBack(empty.streamed)).toEqual(await readBack(empty.legacy.data));
  });

  it("looks lab details up once per new code, page by page", async () => {
    await both(body("fr", everyColumn), registrations);

    const calls = m.getSponsorshipLabDetails.mock.calls.map((call) => call[1]);
    // Page 1 (rows 1-3): LAB-A; page 2 (rows 4-6): LAB-B and LAB-MISSING
    // (LAB-A already known); page 3 (row 7): no code, no query.
    expect(calls).toEqual([["LAB-A"], ["LAB-B", "LAB-MISSING"]]);
  });

  it("reads no lab details when no lab column is selected", async () => {
    await both(body("fr", { sponsorship: ["sponsorshipCode", "labName"] }), registrations);
    expect(m.getSponsorshipLabDetails).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// GET CSV / JSON / XLSX
// ----------------------------------------------------------------------------

describe("GET registrations export parity (3.7)", () => {
  const service = new ReportsService();

  const exportRows: ExportRegistrationRow[] = registrations.map((r) => ({
    id: r.id,
    email: r.email,
    firstName: r.firstName,
    lastName: r.lastName,
    phone: r.phone,
    paymentStatus: r.paymentStatus,
    paymentMethod: r.paymentMethod,
    totalAmount: r.totalAmount,
    paidAmount: r.paidAmount,
    baseAmount: r.baseAmount,
    accessAmount: r.accessAmount,
    discountAmount: r.discountAmount,
    sponsorshipCode: r.sponsorshipCode,
    sponsorshipAmount: r.sponsorshipAmount,
    submittedAt: r.submittedAt,
    paidAt: r.paidAt,
    formData: r.formData,
  }));

  function serve(rows: ExportRegistrationRow[]) {
    m.getEventSlug.mockResolvedValue({ slug: "congres-2026" });
    m.iterateRegistrationsForExport.mockImplementation(pagesOf(rows));
    const keys = new Set<string>();
    for (const row of rows) {
      if (row.formData && typeof row.formData === "object" && !Array.isArray(row.formData)) {
        for (const key of Object.keys(row.formData)) keys.add(key);
      }
    }
    m.getRegistrationFormDataKeys.mockResolvedValue([...keys].sort());
  }

  it.each([
    ["rows", exportRows],
    ["no rows", []],
  ] as const)("CSV and JSON are byte-identical (%s)", async (_label, rows) => {
    serve([...rows]);
    const csv = await collect(await service.exportRegistrations("event-1", { format: "csv" }));
    expect(csv.toString("utf8")).toBe(legacyCsv([...rows]));

    const json = await collect(await service.exportRegistrations("event-1", { format: "json" }));
    expect(json.toString("utf8")).toBe(legacyJson([...rows]));
  });

  it.each([
    ["rows", exportRows],
    ["no rows", []],
  ] as const)("XLSX reads back like the in-memory workbook (%s)", async (_label, rows) => {
    serve([...rows]);
    const xlsx = await collect(await service.exportRegistrations("event-1", { format: "xlsx" }));
    expect(await readBack(xlsx)).toEqual(await readBack(await legacyXlsx([...rows])));
  });
});
