import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportRegistrationsBody, ExportLanguage } from "@app/contracts";
import type { ModularRegistrationRow, RegistrationFormColumn } from "@app/db";

const exportTx = vi.hoisted(() => ({ exportTransaction: true }));
vi.mock("@app/db", () => ({
  withExportStatementTimeout: vi.fn((run: (tx: unknown) => unknown) => run(exportTx)),
  getRegistrationsForModularExport: vi.fn(), getRegistrationTableColumns: vi.fn(),
  getEventAccessNames: vi.fn(), getEventSlugAndName: vi.fn(), getSponsorshipLabDetails: vi.fn(),
}));
import * as db from "@app/db";
import { buildRegistrationsWorkbook } from "./registrations-export-builder";
import { accessItems, event, expectHeader, paidAt, readWorkbook, rowValues, submittedAt, useExportClock } from "../../../tests/reports/exports.test-support";

useExportClock();

const formColumns: RegistrationFormColumn[] = [
  { id: "specialty", label: "Specialty", type: "dropdown", options: [{ id: "cardio", label: "Cardiology" }, { id: "other", label: "Other" }], mergeWith: { fieldId: "specialty-other", triggerValue: "other" } },
  { id: "diet", label: "Diet", type: "checkbox", options: [{ id: "veg", label: "Vegetarian" }] },
  { id: "choice", label: "Choice", type: "radio", options: [{ id: "yes", label: "Confirmed" }] },
  { id: "details", label: "Details", type: "textarea" },
  { id: "tags", label: "Tags", type: "text" },
  { id: "quantity", label: "Quantity", type: "number" },
  { id: "consent", label: "Consent", type: "text" },
];

function registration(overrides: Partial<ModularRegistrationRow> = {}): ModularRegistrationRow {
  return {
    id: "reg-1", eventId: "evt", formId: "form-1", referenceNumber: "REF-001",
    email: "amina@example.test", firstName: "=Amina", lastName: "Ben Ali", phone: "+216123",
    role: "SPEAKER", note: "@admin note", paymentStatus: "SPONSORED", paymentMethod: "BANK_TRANSFER",
    currency: "TND", totalAmount: 12500, paidAmount: 10000, baseAmount: 10000, accessAmount: 3000,
    discountAmount: 500, sponsorshipAmount: 2500, paymentReference: "TRANSFER-1",
    paymentProofUrl: "https://example.test/proof", sponsorshipCode: "SP-1", labName: "Alpha",
    submittedAt, createdAt: submittedAt, updatedAt: paidAt, lastEditedAt: null, paidAt,
    formSchemaVersion: 3, checkedInAt: paidAt, checkedInBy: "staff@example.test",
    accessTypeIds: ["access-workshop"], droppedAccessIds: ["access-dinner", "removed"],
    accessCheckIns: [{ accessId: "access-workshop", checkedInAt: submittedAt }],
    transactions: [
      { type: "PAYMENT", amount: 10000, method: "CASH", reference: "RECEIPT", performedBy: "staff@example.test", createdAt: submittedAt, note: "not exported" },
      { type: "REFUND", amount: -500, method: null, reference: null, performedBy: null, createdAt: paidAt, note: null },
    ],
    formData: { specialty: "other", "specialty-other": "Rare diseases", diet: ["veg", "unknown"], choice: "yes", details: { note: "free text" }, tags: ["one", "two"], quantity: 0, consent: false },
    networkingOptIn: null, priceBreakdown: {}, editToken: null, linkBaseUrl: null, idempotencyKey: null,
    ...overrides,
  };
}

function body(language: ExportLanguage, columns: Partial<ExportRegistrationsBody["columns"]> = {}): ExportRegistrationsBody {
  return { language, filters: {}, columns: {
    identity: [], submission: [], payment: [], sponsorship: [], accessItemIds: [], checkinAccessIds: [],
    includeGlobalCheckin: false, includeTransactions: false, includeDroppedAccess: false, formFieldIds: [], ...columns,
  } };
}

beforeEach(() => {
  vi.mocked(db.getEventSlugAndName).mockResolvedValue(event);
  vi.mocked(db.getEventAccessNames).mockResolvedValue(accessItems);
  vi.mocked(db.getRegistrationTableColumns).mockResolvedValue({ fixedColumns: [], formColumns });
  vi.mocked(db.getRegistrationsForModularExport).mockResolvedValue([registration()]);
  vi.mocked(db.getSponsorshipLabDetails).mockResolvedValue([{
    code: "SP-1", beneficiaryAddress: "Tunis",
    batch: { labName: "Alpha", contactName: "Lab contact", email: "lab@example.test", phone: "+216999" },
  }]);
});

const locales = [
  {
    language: "fr", sheet: "Inscriptions", groups: ["Identité", "Soumission", "Paiement", "Sponsoring", "Accès", "Pointages", "Transactions", "Questions du formulaire"],
    identity: ["ID", "N° de référence", "Email", "Prénom", "Nom", "Téléphone", "Rôle", "Note admin"],
    submission: ["Soumis le", "Créé le", "Mis à jour le", "Dernière édition", "Version du formulaire"],
    payment: ["Statut de paiement", "Méthode", "Devise", "Total", "Payé", "Base", "Accès (mt)", "Remise", "Sponsoring (mt)", "Référence", "Preuve (URL)", "Payé le"],
    sponsorship: ["Code", "Laboratoire", "Contact labo", "Email labo", "Téléphone labo", "Adresse bénéficiaire"],
    dropped: "Accès retirés", checkins: ["Pointage global", "Pointé par", "Workshop — Pointage", "Dinner — Pointage"],
    submitted: "03/06/2026 08:15", paid: "04/06/2026 09:30", role: "Intervenant", status: "Sponsorisé", method: "Virement", yes: "Oui", no: "Non",
    transactions: "03/06/2026 08:15 | Paiement | 10000 | Espèces | RECEIPT | staff@example.test\n04/06/2026 09:30 | Remboursement | -500",
  },
  {
    language: "en", sheet: "Registrations", groups: ["Identity", "Submission", "Payment", "Sponsorship", "Access items", "Check-ins", "Transactions", "Form questions"],
    identity: ["ID", "Reference #", "Email", "First name", "Last name", "Phone", "Role", "Admin note"],
    submission: ["Submitted at", "Created at", "Updated at", "Last edited", "Form version"],
    payment: ["Payment status", "Method", "Currency", "Total", "Paid", "Base", "Access amount", "Discount", "Sponsorship", "Reference", "Proof URL", "Paid at"],
    sponsorship: ["Code", "Lab", "Lab contact", "Lab email", "Lab phone", "Beneficiary address"],
    dropped: "Dropped access", checkins: ["Global check-in", "Checked in by", "Workshop — Check-in", "Dinner — Check-in"],
    submitted: "06/03/2026, 08:15 AM", paid: "06/04/2026, 09:30 AM", role: "Speaker", status: "Sponsored", method: "Bank transfer", yes: "Yes", no: "No",
    transactions: "06/03/2026, 08:15 AM | Payment | 10000 | Cash | RECEIPT | staff@example.test\n06/04/2026, 09:30 AM | Refund | -500",
  },
  {
    language: "ar", sheet: "التسجيلات", groups: ["الهوية", "الإرسال", "الدفع", "الرعاية", "الوصول", "التسجيلات", "المعاملات", "أسئلة النموذج"],
    identity: ["المعرف", "المرجع", "البريد", "الاسم", "اللقب", "الهاتف", "الدور", "ملاحظة"],
    submission: ["تاريخ الإرسال", "تاريخ الإنشاء", "آخر تحديث", "آخر تعديل", "إصدار النموذج"],
    payment: ["حالة", "الطريقة", "العملة", "المجموع", "المدفوع", "الأساس", "مبلغ الوصول", "خصم", "رعاية", "مرجع", "إثبات", "تاريخ الدفع"],
    sponsorship: ["رمز", "مخبر", "جهة الاتصال", "بريد", "هاتف", "عنوان"],
    dropped: "الوصول المزال", checkins: ["تسجيل عام", "تم تسجيله بواسطة", "Workshop — تسجيل", "Dinner — تسجيل"],
    submitted: "03‏/06‏/2026، 08:15 ص", paid: "04‏/06‏/2026، 09:30 ص", role: "متحدث", status: "مرعي", method: "تحويل", yes: "نعم", no: "لا",
    transactions: "03‏/06‏/2026، 08:15 ص | دفع | 10000 | نقدا | RECEIPT | staff@example.test\n04‏/06‏/2026، 09:30 ص | استرداد | -500",
  },
] as const;

describe.each(locales)("modular XLSX ($language)", (locale) => {
  it("falls back to one email column for an empty selection without fetching lab details or relations", async () => {
    const result = await buildRegistrationsWorkbook("evt", body(locale.language));
    const workbook = await readWorkbook(result.data);
    expect(workbook.worksheets.map((s) => s.name)).toEqual([locale.sheet]);
    const sheet = workbook.worksheets[0];
    expect([1, 2, 3].map((n) => rowValues(sheet, n))).toEqual([[locale.groups[0]], [locale.identity[2]], ["amina@example.test"]]);
    expect(sheet.model.merges).toEqual([]);
    expect(sheet.getColumn(1).width).toBe(32);
    expect(sheet.autoFilter).toBe("A2:A2");
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 2 });
    expectHeader(sheet.getCell("A2"));
    expect(db.getSponsorshipLabDetails).not.toHaveBeenCalled();
    expect(db.getRegistrationsForModularExport).toHaveBeenCalledWith("evt", expect.objectContaining({ needCheckIns: false, needTransactions: false }), exportTx);
  });

  it("preserves every group, localized headers, raw values, merges, formats and multiline transactions", async () => {
    const input = body(locale.language, {
      identity: ["id", "referenceNumber", "email", "firstName", "lastName", "phone", "role", "note"],
      submission: ["submittedAt", "createdAt", "updatedAt", "lastEditedAt", "formSchemaVersion"],
      payment: ["paymentStatus", "paymentMethod", "currency", "totalAmount", "paidAmount", "baseAmount", "accessAmount", "discountAmount", "sponsorshipAmount", "paymentReference", "paymentProofUrl", "paidAt"],
      sponsorship: ["sponsorshipCode", "labName", "labContactName", "labEmail", "labPhone", "beneficiaryAddress"],
      accessItemIds: ["access-workshop", "access-dinner"], includeDroppedAccess: true,
      includeGlobalCheckin: true, checkinAccessIds: ["access-workshop", "access-dinner"], includeTransactions: true,
      formFieldIds: [...formColumns.map((c) => c.id), "specialty-other", "unknown-field"],
    });
    input.filters = { search: "Amina", paymentStatus: "SPONSORED", paymentMethod: "BANK_TRANSFER", startDate: "2026-06-01T00:00:00Z", endDate: "2026-06-05T00:00:00Z" };
    const result = await buildRegistrationsWorkbook("evt", input);
    expect(result.filename).toBe("medical-congress-registrations-2026-06-04.xlsx");
    const workbook = await readWorkbook(result.data);
    expect(workbook.worksheets.map((s) => s.name)).toEqual([locale.sheet]);
    const sheet = workbook.worksheets[0];
    expect(rowValues(sheet, 2)).toEqual([
      ...locale.identity, ...locale.submission, ...locale.payment, ...locale.sponsorship,
      "Workshop", "Dinner", locale.dropped, ...locale.checkins, locale.groups[6], ...formColumns.map((c) => c.label),
    ]);
    expect(rowValues(sheet, 3)).toEqual([
      "reg-1", "REF-001", "amina@example.test", "=Amina", "Ben Ali", "+216123", locale.role, "@admin note",
      locale.submitted, locale.submitted, locale.paid, "", 3,
      locale.status, locale.method, "TND", 12500, 10000, 10000, 3000, 500, 2500, "TRANSFER-1", "https://example.test/proof", locale.paid,
      "SP-1", "Alpha", "Lab contact", "lab@example.test", "+216999", "Tunis",
      locale.yes, locale.no, "Dinner, removed", locale.paid, "staff@example.test", locale.submitted, "", locale.transactions,
      "Rare diseases", "Vegetarian, unknown", "Confirmed", '{"note":"free text"}', "one, two", "0", "false",
    ]);
    // ExcelJS stores these strings verbatim, as legacy code deliberately does.
    expect(sheet.getCell("D3").formula).toBeUndefined();
    expect(sheet.getCell("D3").value).toBe("=Amina");
    expect(sheet.model.merges).toEqual(["A1:H1", "I1:M1", "N1:Y1", "Z1:AE1", "AF1:AH1", "AI1:AL1", "AN1:AT1"]);
    const starts = ["A1", "I1", "N1", "Z1", "AF1", "AI1", "AM1", "AN1"];
    expect(starts.map((a) => sheet.getCell(a).value)).toEqual(locale.groups);
    const fills = ["FFD6E4F0", "FFEADAF0", "FFD9EDD4", "FFFCE5B6", "FFFAD4D4", "FFDDE7EC", "FFD6E4F0", "FFEADAF0"];
    starts.forEach((a, i) => expect(sheet.getCell(a).fill).toMatchObject({ fgColor: { argb: fills[i] } }));
    expect(sheet.getRow(1).height).toBe(22);
    expect(sheet.getRow(2).height).toBe(24);
    expectHeader(sheet.getCell("A2"));
    expect(sheet.autoFilter).toBe("A2:AT2");
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 2 });
    for (const c of [17, 18, 19, 20, 21, 22]) expect(sheet.getCell(3, c).numFmt).toBe("#,##0");
    expect(sheet.getCell("I3").type).toBe(3); // Locale dates are strings.
    expect(sheet.getCell("I3").numFmt).toBeUndefined();
    expect(sheet.getCell("AM3").alignment).toEqual({ vertical: "top", wrapText: true });
    expect(sheet.getColumn("AM").width).toBe(50);
    expect(sheet.getColumn("AQ").width).toBe(40);
    expect(db.getSponsorshipLabDetails).toHaveBeenCalledWith("evt", ["SP-1"], exportTx);
    expect(db.getRegistrationsForModularExport).toHaveBeenCalledWith("evt", { ...input.filters, needCheckIns: true, needTransactions: true }, exportTx);
    for (const query of [db.getEventSlugAndName, db.getRegistrationTableColumns, db.getEventAccessNames]) expect(query).toHaveBeenCalledWith("evt", exportTx);
  });
});

it("resolves ordinary options, missing values, object 'other' answers, and ignores non-object form data", async () => {
  vi.mocked(db.getRegistrationsForModularExport).mockResolvedValue([
    registration({ id: "r1", formData: { specialty: "cardio", choice: "not-listed", diet: [] } }),
    registration({ id: "r2", formData: { specialty: "other", "specialty-other": { text: "rare" } } }),
    registration({ id: "r3", formData: { specialty: "other" } }),
    registration({ id: "r4", formData: ["not", "a record"] }),
  ]);
  const sheet = (await readWorkbook((await buildRegistrationsWorkbook("evt", body("en", {
    formFieldIds: ["specialty", "choice", "diet"],
  }))).data)).worksheets[0];
  expect([3, 4, 5, 6].map((r) => rowValues(sheet, r))).toEqual([
    ["Cardiology", "not-listed", ""], ['{"text":"rare"}', "", ""], ["", "", ""], ["", "", ""],
  ]);
});

it("uses row lab names without deep lookup and preserves requested column order", async () => {
  const sheet = (await readWorkbook((await buildRegistrationsWorkbook("evt", body("en", {
    identity: ["lastName", "email"], sponsorship: ["labName", "sponsorshipCode"],
  }))).data)).worksheets[0];
  expect(rowValues(sheet, 2)).toEqual(["Last name", "Email", "Lab", "Code"]);
  expect(rowValues(sheet, 3)).toEqual(["Ben Ali", "amina@example.test", "Alpha", "SP-1"]);
  expect(db.getSponsorshipLabDetails).not.toHaveBeenCalled();
});
