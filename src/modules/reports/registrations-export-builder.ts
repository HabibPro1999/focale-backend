import ExcelJS from "exceljs";
import { prisma } from "@/database/client.js";
import { buildRegistrationWhere, getRegistrationTableColumns } from "@registrations";
import type {
  ExportRegistrationsBody,
  ExportLanguage,
  IdentityField,
  SubmissionField,
  PaymentField,
  SponsorshipField,
} from "./reports.schema.js";

// ============================================================================
// Styling constants
// ============================================================================

const GROUP_HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  size: 11,
  color: { argb: "FF1F4E79" },
};
const COLUMN_HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F4E79" },
};
const COLUMN_HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  color: { argb: "FFFFFFFF" },
  size: 11,
};
const BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
};
const GROUP_FILLS: ExcelJS.Fill[] = [
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFD6E4F0" } }, // soft blue
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFEADAF0" } }, // soft violet
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EDD4" } }, // soft green
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE5B6" } }, // soft amber
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAD4D4" } }, // soft rose
  { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDE7EC" } }, // soft slate
];

// ============================================================================
// Localized labels
// ============================================================================

type Lang = ExportLanguage;

const GROUP_LABELS: Record<string, Record<Lang, string>> = {
  identity: { fr: "Identité", en: "Identity", ar: "الهوية" },
  submission: { fr: "Soumission", en: "Submission", ar: "الإرسال" },
  payment: { fr: "Paiement", en: "Payment", ar: "الدفع" },
  sponsorship: { fr: "Sponsoring", en: "Sponsorship", ar: "الرعاية" },
  access: { fr: "Accès", en: "Access items", ar: "الوصول" },
  checkins: { fr: "Pointages", en: "Check-ins", ar: "التسجيلات" },
  transactions: { fr: "Transactions", en: "Transactions", ar: "المعاملات" },
  form: {
    fr: "Questions du formulaire",
    en: "Form questions",
    ar: "أسئلة النموذج",
  },
};

const IDENTITY_HEADERS: Record<IdentityField, Record<Lang, string>> = {
  id: { fr: "ID", en: "ID", ar: "المعرف" },
  referenceNumber: { fr: "N° de référence", en: "Reference #", ar: "المرجع" },
  email: { fr: "Email", en: "Email", ar: "البريد" },
  firstName: { fr: "Prénom", en: "First name", ar: "الاسم" },
  lastName: { fr: "Nom", en: "Last name", ar: "اللقب" },
  phone: { fr: "Téléphone", en: "Phone", ar: "الهاتف" },
  role: { fr: "Rôle", en: "Role", ar: "الدور" },
  note: { fr: "Note admin", en: "Admin note", ar: "ملاحظة" },
};

const SUBMISSION_HEADERS: Record<SubmissionField, Record<Lang, string>> = {
  submittedAt: { fr: "Soumis le", en: "Submitted at", ar: "تاريخ الإرسال" },
  createdAt: { fr: "Créé le", en: "Created at", ar: "تاريخ الإنشاء" },
  updatedAt: { fr: "Mis à jour le", en: "Updated at", ar: "آخر تحديث" },
  lastEditedAt: {
    fr: "Dernière édition",
    en: "Last edited",
    ar: "آخر تعديل",
  },
  formSchemaVersion: {
    fr: "Version du formulaire",
    en: "Form version",
    ar: "إصدار النموذج",
  },
};

const PAYMENT_HEADERS: Record<PaymentField, Record<Lang, string>> = {
  paymentStatus: { fr: "Statut de paiement", en: "Payment status", ar: "حالة" },
  paymentMethod: { fr: "Méthode", en: "Method", ar: "الطريقة" },
  currency: { fr: "Devise", en: "Currency", ar: "العملة" },
  totalAmount: { fr: "Total", en: "Total", ar: "المجموع" },
  paidAmount: { fr: "Payé", en: "Paid", ar: "المدفوع" },
  baseAmount: { fr: "Base", en: "Base", ar: "الأساس" },
  accessAmount: { fr: "Accès (mt)", en: "Access amount", ar: "مبلغ الوصول" },
  discountAmount: { fr: "Remise", en: "Discount", ar: "خصم" },
  sponsorshipAmount: { fr: "Sponsoring (mt)", en: "Sponsorship", ar: "رعاية" },
  paymentReference: { fr: "Référence", en: "Reference", ar: "مرجع" },
  paymentProofUrl: { fr: "Preuve (URL)", en: "Proof URL", ar: "إثبات" },
  paidAt: { fr: "Payé le", en: "Paid at", ar: "تاريخ الدفع" },
};

const SPONSORSHIP_HEADERS: Record<SponsorshipField, Record<Lang, string>> = {
  sponsorshipCode: { fr: "Code", en: "Code", ar: "رمز" },
  labName: { fr: "Laboratoire", en: "Lab", ar: "مخبر" },
  labContactName: { fr: "Contact labo", en: "Lab contact", ar: "جهة الاتصال" },
  labEmail: { fr: "Email labo", en: "Lab email", ar: "بريد" },
  labPhone: { fr: "Téléphone labo", en: "Lab phone", ar: "هاتف" },
  beneficiaryAddress: {
    fr: "Adresse bénéficiaire",
    en: "Beneficiary address",
    ar: "عنوان",
  },
};

const PAYMENT_STATUS_LABELS: Record<string, Record<Lang, string>> = {
  PENDING: { fr: "En attente", en: "Pending", ar: "معلق" },
  VERIFYING: { fr: "En vérification", en: "Verifying", ar: "قيد التحقق" },
  PARTIAL: { fr: "Partiel", en: "Partial", ar: "جزئي" },
  PAID: { fr: "Payé", en: "Paid", ar: "مدفوع" },
  SPONSORED: { fr: "Sponsorisé", en: "Sponsored", ar: "مرعي" },
  WAIVED: { fr: "Exonéré", en: "Waived", ar: "معفى" },
  REFUNDED: { fr: "Remboursé", en: "Refunded", ar: "مسترد" },
};

const PAYMENT_METHOD_LABELS: Record<string, Record<Lang, string>> = {
  BANK_TRANSFER: { fr: "Virement", en: "Bank transfer", ar: "تحويل" },
  ONLINE: { fr: "En ligne", en: "Online", ar: "عبر الإنترنت" },
  CASH: { fr: "Espèces", en: "Cash", ar: "نقدا" },
  LAB_SPONSORSHIP: {
    fr: "Sponsoring labo",
    en: "Lab sponsorship",
    ar: "رعاية مخبر",
  },
};

const ROLE_LABELS: Record<string, Record<Lang, string>> = {
  PARTICIPANT: { fr: "Participant", en: "Participant", ar: "مشارك" },
  SPEAKER: { fr: "Intervenant", en: "Speaker", ar: "متحدث" },
  MODERATOR: { fr: "Modérateur", en: "Moderator", ar: "مشرف" },
  ORGANIZER: { fr: "Organisateur", en: "Organizer", ar: "منظم" },
};

const TX_TYPE_LABELS: Record<string, Record<Lang, string>> = {
  PAYMENT: { fr: "Paiement", en: "Payment", ar: "دفع" },
  REFUND: { fr: "Remboursement", en: "Refund", ar: "استرداد" },
  WAIVER: { fr: "Exonération", en: "Waiver", ar: "إعفاء" },
  ADJUSTMENT: { fr: "Ajustement", en: "Adjustment", ar: "تعديل" },
};

const YES_NO: Record<Lang, { yes: string; no: string }> = {
  fr: { yes: "Oui", no: "Non" },
  en: { yes: "Yes", no: "No" },
  ar: { yes: "نعم", no: "لا" },
};

const SHEET_NAME: Record<Lang, string> = {
  fr: "Inscriptions",
  en: "Registrations",
  ar: "التسجيلات",
};

const TRANSACTIONS_HEADER: Record<Lang, string> = {
  fr: "Transactions",
  en: "Transactions",
  ar: "المعاملات",
};

const DROPPED_ACCESS_HEADER: Record<Lang, string> = {
  fr: "Accès retirés",
  en: "Dropped access",
  ar: "الوصول المزال",
};

const GLOBAL_CHECKIN_AT: Record<Lang, string> = {
  fr: "Pointage global",
  en: "Global check-in",
  ar: "تسجيل عام",
};
const GLOBAL_CHECKIN_BY: Record<Lang, string> = {
  fr: "Pointé par",
  en: "Checked in by",
  ar: "تم تسجيله بواسطة",
};
const CHECKIN_SUFFIX: Record<Lang, string> = {
  fr: "— Pointage",
  en: "— Check-in",
  ar: "— تسجيل",
};

// ============================================================================
// Helpers — value formatting
// ============================================================================

function fmtDateTime(d: Date | null | undefined, lang: Lang): string {
  if (!d) return "";
  const locale = lang === "fr" ? "fr-FR" : lang === "ar" ? "ar-TN" : "en-US";
  return d.toLocaleString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function yesNo(b: boolean, lang: Lang): string {
  return b ? YES_NO[lang].yes : YES_NO[lang].no;
}

function enumLabel(
  map: Record<string, Record<Lang, string>>,
  value: string | null | undefined,
  lang: Lang,
): string {
  if (!value) return "";
  return map[value]?.[lang] ?? value;
}

// ============================================================================
// Column descriptor — internal representation of a single output column
// ============================================================================

type ColumnKind =
  | "text"
  | "datetime"
  | "money"
  | "boolean"
  | "url"
  | "longtext"; // wraps, wider

interface ColumnDescriptor {
  group: keyof typeof GROUP_LABELS;
  header: string;
  kind: ColumnKind;
  width: number;
  getValue: (ctx: RowContext) => string | number;
}

interface RowContext {
  registration: RegistrationWithRelations;
  accessNameById: Map<string, string>;
  sponsorshipByCode: Map<
    string,
    {
      batch: {
        labName: string;
        contactName: string;
        email: string;
        phone: string | null;
      };
      beneficiaryAddress: string | null;
    }
  >;
  lang: Lang;
}

type RegistrationWithRelations = Awaited<
  ReturnType<typeof fetchRegistrations>
>[number];

// ============================================================================
// Data fetching — dynamic selects
// ============================================================================

async function fetchRegistrations(
  eventId: string,
  body: ExportRegistrationsBody,
) {
  const { filters, columns } = body;

  const where = buildRegistrationWhere(eventId, {
    paymentStatus: filters.paymentStatus,
    paymentMethod: filters.paymentMethod,
    search: filters.search,
  });
  if (filters.startDate) {
    where.submittedAt = { gte: new Date(filters.startDate) };
  }
  if (filters.endDate) {
    where.submittedAt = {
      ...(where.submittedAt as Record<string, Date> | undefined),
      lte: new Date(filters.endDate),
    };
  }

  const needCheckIns =
    columns.checkinAccessIds.length > 0 || columns.includeGlobalCheckin;
  const needTransactions = columns.includeTransactions;
  const needFormData = columns.formFieldIds.length > 0;

  return prisma.registration.findMany({
    where,
    orderBy: { submittedAt: "desc" },
    select: {
      // Always-available minimal columns — cheap to include
      id: true,
      referenceNumber: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      role: true,
      note: true,
      submittedAt: true,
      createdAt: true,
      updatedAt: true,
      lastEditedAt: true,
      formSchemaVersion: true,
      paymentStatus: true,
      paymentMethod: true,
      currency: true,
      totalAmount: true,
      paidAmount: true,
      baseAmount: true,
      accessAmount: true,
      discountAmount: true,
      sponsorshipAmount: true,
      sponsorshipCode: true,
      labName: true,
      paymentReference: true,
      paymentProofUrl: true,
      paidAt: true,
      accessTypeIds: true,
      droppedAccessIds: true,
      checkedInAt: true,
      checkedInBy: true,
      formData: needFormData,
      accessCheckIns: needCheckIns
        ? { select: { accessId: true, checkedInAt: true } }
        : false,
      transactions: needTransactions
        ? {
            select: {
              type: true,
              amount: true,
              method: true,
              reference: true,
              note: true,
              performedBy: true,
              createdAt: true,
            },
            orderBy: { createdAt: "asc" },
          }
        : false,
    },
  });
}

// ============================================================================
// Form field value resolution (honors smart-merge, dropdown/checkbox labels)
// ============================================================================

type FormColumn = Awaited<
  ReturnType<typeof getRegistrationTableColumns>
>["formColumns"][number];

function resolveFormFieldValue(
  column: FormColumn,
  formData: Record<string, unknown>,
): string {
  const raw = formData[column.id];

  // Smart-merge "specify other": if parent selected the trigger value,
  // render the child's textual answer instead of the option label.
  if (column.mergeWith && raw === column.mergeWith.triggerValue) {
    const childValue = formData[column.mergeWith.fieldId];
    if (childValue == null) return "";
    return typeof childValue === "object"
      ? JSON.stringify(childValue)
      : String(childValue);
  }

  if (raw == null) return "";

  // Dropdown / radio: map option id → option label when available.
  if (
    (column.type === "dropdown" || column.type === "radio") &&
    column.options &&
    typeof raw === "string"
  ) {
    const opt = column.options.find((o) => o.id === raw);
    return opt?.label ?? raw;
  }

  // Checkbox: array of option ids → comma-joined labels.
  if (column.type === "checkbox" && Array.isArray(raw) && column.options) {
    return raw
      .map((id) => {
        const opt = column.options?.find((o) => o.id === id);
        return opt?.label ?? String(id);
      })
      .join(", ");
  }

  if (Array.isArray(raw)) return raw.map((v) => String(v)).join(", ");
  if (typeof raw === "object") return JSON.stringify(raw);
  return String(raw);
}

async function fetchSponsorshipLabDetails(
  eventId: string,
  codes: string[],
): Promise<RowContext["sponsorshipByCode"]> {
  const map: RowContext["sponsorshipByCode"] = new Map();
  if (codes.length === 0) return map;
  const uniqueCodes = Array.from(new Set(codes.filter(Boolean)));
  const sponsorships = await prisma.sponsorship.findMany({
    where: { code: { in: uniqueCodes }, batch: { eventId } },
    select: {
      code: true,
      beneficiaryAddress: true,
      batch: {
        select: {
          labName: true,
          contactName: true,
          email: true,
          phone: true,
        },
      },
    },
  });
  for (const s of sponsorships) {
    map.set(s.code, {
      beneficiaryAddress: s.beneficiaryAddress,
      batch: s.batch,
    });
  }
  return map;
}

// ============================================================================
// Column composition — turn a selection into an ordered list of ColumnDescriptors
// ============================================================================

function buildColumns(
  body: ExportRegistrationsBody,
  accessItems: { id: string; name: string }[],
  formColumns: FormColumn[],
  lang: Lang,
): ColumnDescriptor[] {
  const out: ColumnDescriptor[] = [];
  const { columns } = body;
  const accessNameById = new Map(accessItems.map((a) => [a.id, a.name]));

  // ── Identity ──
  for (const field of columns.identity) {
    out.push(buildIdentityColumn(field, lang));
  }

  // ── Submission ──
  for (const field of columns.submission) {
    out.push(buildSubmissionColumn(field, lang));
  }

  // ── Payment ──
  for (const field of columns.payment) {
    out.push(buildPaymentColumn(field, lang));
  }

  // ── Sponsorship ──
  for (const field of columns.sponsorship) {
    out.push(buildSponsorshipColumn(field, lang));
  }

  // ── Access items (Oui/Non per selected access) ──
  for (const accessId of columns.accessItemIds) {
    const name = accessNameById.get(accessId) ?? accessId;
    out.push({
      group: "access",
      header: name,
      kind: "boolean",
      width: 18,
      getValue: (ctx) =>
        yesNo(ctx.registration.accessTypeIds.includes(accessId), ctx.lang),
    });
  }
  if (columns.includeDroppedAccess) {
    out.push({
      group: "access",
      header: DROPPED_ACCESS_HEADER[lang],
      kind: "longtext",
      width: 30,
      getValue: (ctx) =>
        ctx.registration.droppedAccessIds
          .map((id) => ctx.accessNameById.get(id) ?? id)
          .join(", "),
    });
  }

  // ── Check-ins ──
  if (columns.includeGlobalCheckin) {
    out.push({
      group: "checkins",
      header: GLOBAL_CHECKIN_AT[lang],
      kind: "datetime",
      width: 22,
      getValue: (ctx) => fmtDateTime(ctx.registration.checkedInAt, ctx.lang),
    });
    out.push({
      group: "checkins",
      header: GLOBAL_CHECKIN_BY[lang],
      kind: "text",
      width: 22,
      getValue: (ctx) => ctx.registration.checkedInBy ?? "",
    });
  }
  for (const accessId of columns.checkinAccessIds) {
    const name = accessNameById.get(accessId) ?? accessId;
    out.push({
      group: "checkins",
      header: `${name} ${CHECKIN_SUFFIX[lang]}`,
      kind: "datetime",
      width: 22,
      getValue: (ctx) => {
        const aci = ctx.registration.accessCheckIns?.find(
          (c) => c.accessId === accessId,
        );
        return fmtDateTime(aci?.checkedInAt ?? null, ctx.lang);
      },
    });
  }

  // ── Transactions (summary in one cell) ──
  if (columns.includeTransactions) {
    out.push({
      group: "transactions",
      header: TRANSACTIONS_HEADER[lang],
      kind: "longtext",
      width: 50,
      getValue: (ctx) => {
        const txs = ctx.registration.transactions ?? [];
        if (txs.length === 0) return "";
        return txs
          .map((t) => {
            const parts = [
              fmtDateTime(t.createdAt, ctx.lang),
              enumLabel(TX_TYPE_LABELS, t.type, ctx.lang),
              String(t.amount),
              t.method ? enumLabel(PAYMENT_METHOD_LABELS, t.method, ctx.lang) : "",
              t.reference ?? "",
              t.performedBy ?? "",
            ];
            return parts.filter((p) => p !== "").join(" | ");
          })
          .join("\n");
      },
    });
  }

  // ── Form questions ──
  const formColumnById = new Map(formColumns.map((c) => [c.id, c]));
  for (const fieldId of columns.formFieldIds) {
    const col = formColumnById.get(fieldId);
    if (!col) continue; // skip unknown/merged-child ids silently
    out.push({
      group: "form",
      header: col.label,
      kind: col.type === "textarea" ? "longtext" : "text",
      width: col.type === "textarea" ? 40 : 28,
      getValue: (ctx) => {
        const fd =
          ctx.registration.formData &&
          typeof ctx.registration.formData === "object" &&
          !Array.isArray(ctx.registration.formData)
            ? (ctx.registration.formData as Record<string, unknown>)
            : {};
        return resolveFormFieldValue(col, fd);
      },
    });
  }

  return out;
}

// ── individual column builders ────────────────────────────────────────────

function buildIdentityColumn(
  field: IdentityField,
  lang: Lang,
): ColumnDescriptor {
  const header = IDENTITY_HEADERS[field][lang];
  const byField: Record<IdentityField, ColumnDescriptor> = {
    id: {
      group: "identity",
      header,
      kind: "text",
      width: 38,
      getValue: (ctx) => ctx.registration.id,
    },
    referenceNumber: {
      group: "identity",
      header,
      kind: "text",
      width: 16,
      getValue: (ctx) => ctx.registration.referenceNumber ?? "",
    },
    email: {
      group: "identity",
      header,
      kind: "text",
      width: 32,
      getValue: (ctx) => ctx.registration.email,
    },
    firstName: {
      group: "identity",
      header,
      kind: "text",
      width: 22,
      getValue: (ctx) => ctx.registration.firstName ?? "",
    },
    lastName: {
      group: "identity",
      header,
      kind: "text",
      width: 22,
      getValue: (ctx) => ctx.registration.lastName ?? "",
    },
    phone: {
      group: "identity",
      header,
      kind: "text",
      width: 18,
      getValue: (ctx) => ctx.registration.phone ?? "",
    },
    role: {
      group: "identity",
      header,
      kind: "text",
      width: 18,
      getValue: (ctx) => enumLabel(ROLE_LABELS, ctx.registration.role, ctx.lang),
    },
    note: {
      group: "identity",
      header,
      kind: "longtext",
      width: 40,
      getValue: (ctx) => ctx.registration.note ?? "",
    },
  };
  return byField[field];
}

function buildSubmissionColumn(
  field: SubmissionField,
  lang: Lang,
): ColumnDescriptor {
  const header = SUBMISSION_HEADERS[field][lang];
  if (field === "formSchemaVersion") {
    return {
      group: "submission",
      header,
      kind: "text",
      width: 10,
      getValue: (ctx) => ctx.registration.formSchemaVersion,
    };
  }
  return {
    group: "submission",
    header,
    kind: "datetime",
    width: 22,
    getValue: (ctx) => fmtDateTime(ctx.registration[field], ctx.lang),
  };
}

function buildPaymentColumn(
  field: PaymentField,
  lang: Lang,
): ColumnDescriptor {
  const header = PAYMENT_HEADERS[field][lang];
  switch (field) {
    case "paymentStatus":
      return {
        group: "payment",
        header,
        kind: "text",
        width: 20,
        getValue: (ctx) =>
          enumLabel(PAYMENT_STATUS_LABELS, ctx.registration.paymentStatus, ctx.lang),
      };
    case "paymentMethod":
      return {
        group: "payment",
        header,
        kind: "text",
        width: 20,
        getValue: (ctx) =>
          enumLabel(PAYMENT_METHOD_LABELS, ctx.registration.paymentMethod, ctx.lang),
      };
    case "currency":
      return {
        group: "payment",
        header,
        kind: "text",
        width: 10,
        getValue: (ctx) => ctx.registration.currency,
      };
    case "paidAt":
      return {
        group: "payment",
        header,
        kind: "datetime",
        width: 22,
        getValue: (ctx) => fmtDateTime(ctx.registration.paidAt, ctx.lang),
      };
    case "paymentReference":
      return {
        group: "payment",
        header,
        kind: "text",
        width: 22,
        getValue: (ctx) => ctx.registration.paymentReference ?? "",
      };
    case "paymentProofUrl":
      return {
        group: "payment",
        header,
        kind: "url",
        width: 34,
        getValue: (ctx) => ctx.registration.paymentProofUrl ?? "",
      };
    default:
      // All remaining fields are money (integers stored in minor units).
      return {
        group: "payment",
        header,
        kind: "money",
        width: 14,
        getValue: (ctx) => ctx.registration[field] as number,
      };
  }
}

function buildSponsorshipColumn(
  field: SponsorshipField,
  lang: Lang,
): ColumnDescriptor {
  const header = SPONSORSHIP_HEADERS[field][lang];
  switch (field) {
    case "sponsorshipCode":
      return {
        group: "sponsorship",
        header,
        kind: "text",
        width: 16,
        getValue: (ctx) => ctx.registration.sponsorshipCode ?? "",
      };
    case "labName":
      return {
        group: "sponsorship",
        header,
        kind: "text",
        width: 26,
        getValue: (ctx) => ctx.registration.labName ?? "",
      };
    case "labContactName":
      return {
        group: "sponsorship",
        header,
        kind: "text",
        width: 24,
        getValue: (ctx) => {
          const code = ctx.registration.sponsorshipCode;
          return code
            ? ctx.sponsorshipByCode.get(code)?.batch.contactName ?? ""
            : "";
        },
      };
    case "labEmail":
      return {
        group: "sponsorship",
        header,
        kind: "text",
        width: 28,
        getValue: (ctx) => {
          const code = ctx.registration.sponsorshipCode;
          return code
            ? ctx.sponsorshipByCode.get(code)?.batch.email ?? ""
            : "";
        },
      };
    case "labPhone":
      return {
        group: "sponsorship",
        header,
        kind: "text",
        width: 18,
        getValue: (ctx) => {
          const code = ctx.registration.sponsorshipCode;
          return code
            ? ctx.sponsorshipByCode.get(code)?.batch.phone ?? ""
            : "";
        },
      };
    case "beneficiaryAddress":
      return {
        group: "sponsorship",
        header,
        kind: "longtext",
        width: 34,
        getValue: (ctx) => {
          const code = ctx.registration.sponsorshipCode;
          return code
            ? ctx.sponsorshipByCode.get(code)?.beneficiaryAddress ?? ""
            : "";
        },
      };
  }
}

// ============================================================================
// Workbook assembly
// ============================================================================

interface GroupSpan {
  group: keyof typeof GROUP_LABELS;
  startCol: number;
  endCol: number;
  fillIndex: number;
}

function computeGroupSpans(columns: ColumnDescriptor[]): GroupSpan[] {
  const spans: GroupSpan[] = [];
  const fillByGroup = new Map<string, number>();
  let nextFillIdx = 0;

  let current: GroupSpan | null = null;
  columns.forEach((col, i) => {
    const excelCol = i + 1;
    if (!current || current.group !== col.group) {
      if (current) spans.push(current);
      let fillIdx = fillByGroup.get(col.group);
      if (fillIdx === undefined) {
        fillIdx = nextFillIdx++ % GROUP_FILLS.length;
        fillByGroup.set(col.group, fillIdx);
      }
      current = {
        group: col.group,
        startCol: excelCol,
        endCol: excelCol,
        fillIndex: fillIdx,
      };
    } else {
      current.endCol = excelCol;
    }
  });
  if (current) spans.push(current);
  return spans;
}

function colLetter(col: number): string {
  let s = "";
  let n = col;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function writeHeaderRows(
  sheet: ExcelJS.Worksheet,
  columns: ColumnDescriptor[],
  lang: Lang,
): void {
  // Row 1 — group headers (merged per span)
  const groupSpans = computeGroupSpans(columns);
  const groupRow = sheet.getRow(1);
  groupRow.height = 22;
  for (const span of groupSpans) {
    const range = `${colLetter(span.startCol)}1:${colLetter(span.endCol)}1`;
    if (span.startCol !== span.endCol) sheet.mergeCells(range);
    const cell = sheet.getCell(`${colLetter(span.startCol)}1`);
    cell.value = GROUP_LABELS[span.group][lang];
    cell.fill = GROUP_FILLS[span.fillIndex];
    cell.font = GROUP_HEADER_FONT;
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = BORDER;
  }

  // Row 2 — column headers
  const headerRow = sheet.getRow(2);
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.fill = COLUMN_HEADER_FILL;
    cell.font = COLUMN_HEADER_FONT;
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = BORDER;
  });
  headerRow.height = 24;
}

function applyColumnFormatting(
  sheet: ExcelJS.Worksheet,
  columns: ColumnDescriptor[],
): void {
  columns.forEach((col, i) => {
    const excelCol = sheet.getColumn(i + 1);
    excelCol.width = col.width;
    if (col.kind === "money") excelCol.numFmt = "#,##0";
  });
}

// ============================================================================
// Public entry
// ============================================================================

export async function buildRegistrationsWorkbook(
  eventId: string,
  body: ExportRegistrationsBody,
): Promise<{ filename: string; data: Buffer }> {
  const lang = body.language;

  // Parallel fetch: event metadata, form columns, access items, registrations.
  const [event, tableColumns, accessItems, registrations] = await Promise.all([
    prisma.event.findUnique({
      where: { id: eventId },
      select: { slug: true, name: true },
    }),
    getRegistrationTableColumns(eventId),
    prisma.eventAccess.findMany({
      where: { eventId },
      select: { id: true, name: true },
      orderBy: { sortOrder: "asc" },
    }),
    fetchRegistrations(eventId, body),
  ]);

  // Lab details only when sponsorship-deep columns are requested.
  const needsLabDetails = body.columns.sponsorship.some((f) =>
    ["labContactName", "labEmail", "labPhone", "beneficiaryAddress"].includes(
      f,
    ),
  );
  const sponsorshipByCode = needsLabDetails
    ? await fetchSponsorshipLabDetails(
        eventId,
        registrations
          .map((r) => r.sponsorshipCode)
          .filter((c): c is string => Boolean(c)),
      )
    : new Map();

  const columns = buildColumns(body, accessItems, tableColumns.formColumns, lang);

  // Safety fallback — if nothing was selected, expose at least email so the
  // exported file isn't empty / confusing.
  if (columns.length === 0) {
    columns.push({
      group: "identity",
      header: IDENTITY_HEADERS.email[lang],
      kind: "text",
      width: 32,
      getValue: (ctx) => ctx.registration.email,
    });
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Focale OS";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(SHEET_NAME[lang]);

  writeHeaderRows(sheet, columns, lang);

  const accessNameById = new Map(accessItems.map((a) => [a.id, a.name]));
  for (const registration of registrations) {
    const ctx: RowContext = {
      registration,
      accessNameById,
      sponsorshipByCode,
      lang,
    };
    const row = sheet.addRow(columns.map((c) => c.getValue(ctx)));
    row.eachCell((cell, colNumber) => {
      const col = columns[colNumber - 1];
      cell.border = BORDER;
      cell.alignment = {
        vertical: "top",
        wrapText: col.kind === "longtext" || col.kind === "text",
      };
    });
  }

  applyColumnFormatting(sheet, columns);

  // Freeze the two header rows; apply autoFilter on row 2 across all data cols.
  sheet.views = [{ state: "frozen", ySplit: 2 }];
  sheet.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: 2, column: columns.length },
  };

  const slug = event?.slug ?? "event";
  const timestamp = new Date().toISOString().split("T")[0];
  const filename = `${slug}-registrations-${timestamp}.xlsx`;

  const data = Buffer.from(await workbook.xlsx.writeBuffer());
  return { filename, data };
}
