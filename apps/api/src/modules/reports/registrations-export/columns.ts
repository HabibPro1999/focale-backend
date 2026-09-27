import type { ExportRegistrationsBody, ExportLanguage, IdentityField, SubmissionField, PaymentField, SponsorshipField } from "@app/contracts";
import type { ModularRegistrationRow, RegistrationFormColumn } from "@app/db";
import { asFormRecord } from "../export-values";
import {
  GROUP_LABELS, IDENTITY_HEADERS, SUBMISSION_HEADERS, PAYMENT_HEADERS,
  SPONSORSHIP_HEADERS, PAYMENT_STATUS_LABELS, PAYMENT_METHOD_LABELS, ROLE_LABELS,
  TX_TYPE_LABELS, YES_NO, DROPPED_ACCESS_HEADER, GLOBAL_CHECKIN_AT,
  GLOBAL_CHECKIN_BY, CHECKIN_SUFFIX, type GroupKey,
} from "./labels";

// ============================================================================
// Helpers — value formatting
// ============================================================================

function fmtDateTime(d: Date | null | undefined, lang: ExportLanguage): string {
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

function yesNo(b: boolean, lang: ExportLanguage): string {
  return b ? YES_NO[lang].yes : YES_NO[lang].no;
}

function enumLabel(
  map: Record<string, Record<ExportLanguage, string>>,
  value: string | null | undefined,
  lang: ExportLanguage,
): string {
  if (!value) return "";
  return map[value]?.[lang] ?? value;
}

// ============================================================================
// Column descriptor — internal representation of a single output column
// ============================================================================

type ColumnKind = "text" | "datetime" | "money" | "boolean" | "url" | "longtext"; // wraps, wider

export interface ColumnDescriptor {
  group: keyof typeof GROUP_LABELS;
  header: string;
  kind: ColumnKind;
  width: number;
  getValue: (ctx: RowContext) => string | number;
}

export interface RowContext {
  registration: ModularRegistrationRow;
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
  lang: ExportLanguage;
}

// ============================================================================
// Form field value resolution (honors smart-merge, dropdown/checkbox labels)
// ============================================================================

function resolveFormFieldValue(
  column: RegistrationFormColumn,
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

// ============================================================================
// Column composition — turn a selection into an ordered list of ColumnDescriptors
// ============================================================================

export function buildColumns(
  body: ExportRegistrationsBody,
  accessNameById: Map<string, string>,
  formColumns: RegistrationFormColumn[],
  lang: ExportLanguage,
): ColumnDescriptor[] {
  const out: ColumnDescriptor[] = [];
  const { columns } = body;

  // ── Identity ──
  for (const field of columns.identity) {
    out.push(fromSpec("identity", IDENTITY_HEADERS, IDENTITY_SPECS, field, lang));
  }

  // ── Submission ──
  for (const field of columns.submission) {
    out.push(buildSubmissionColumn(field, lang));
  }

  // ── Payment ──
  for (const field of columns.payment) {
    out.push(fromSpec("payment", PAYMENT_HEADERS, PAYMENT_SPECS, field, lang));
  }

  // ── Sponsorship ──
  for (const field of columns.sponsorship) {
    out.push(fromSpec("sponsorship", SPONSORSHIP_HEADERS, SPONSORSHIP_SPECS, field, lang));
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
      header: GROUP_LABELS.transactions[lang],
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
        const fd = asFormRecord(ctx.registration.formData);
        return resolveFormFieldValue(col, fd);
      },
    });
  }

  // Preserve the empty-selection fallback, including unknown/merged form fields.
  if (out.length === 0) {
    out.push(fromSpec("identity", IDENTITY_HEADERS, IDENTITY_SPECS, "email", lang));
  }
  return out;
}

// ── individual column builders ────────────────────────────────────────────

type ColumnSpec = Pick<ColumnDescriptor, "kind" | "width" | "getValue">;

function fromSpec<Field extends string>(
  group: GroupKey,
  headers: Record<Field, Record<ExportLanguage, string>>,
  specs: Record<Field, ColumnSpec>,
  field: Field,
  lang: ExportLanguage,
): ColumnDescriptor {
  return { group, header: headers[field][lang], ...specs[field] };
}

const IDENTITY_SPECS: Record<IdentityField, ColumnSpec> = {
  id: { kind: "text", width: 38, getValue: (ctx) => ctx.registration.id },
  referenceNumber: { kind: "text", width: 16, getValue: (ctx) => ctx.registration.referenceNumber ?? "" },
  email: { kind: "text", width: 32, getValue: (ctx) => ctx.registration.email },
  firstName: { kind: "text", width: 22, getValue: (ctx) => ctx.registration.firstName ?? "" },
  lastName: { kind: "text", width: 22, getValue: (ctx) => ctx.registration.lastName ?? "" },
  phone: { kind: "text", width: 18, getValue: (ctx) => ctx.registration.phone ?? "" },
  role: { kind: "text", width: 18, getValue: (ctx) => enumLabel(ROLE_LABELS, ctx.registration.role, ctx.lang) },
  note: { kind: "longtext", width: 40, getValue: (ctx) => ctx.registration.note ?? "" },
};

function buildSubmissionColumn(field: SubmissionField, lang: ExportLanguage): ColumnDescriptor {
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

type MoneyField = "totalAmount" | "paidAmount" | "baseAmount" | "accessAmount" | "discountAmount" | "sponsorshipAmount";

function moneySpec(field: MoneyField): ColumnSpec {
  return { kind: "money", width: 14, getValue: (ctx) => ctx.registration[field] };
}

const PAYMENT_SPECS: Record<PaymentField, ColumnSpec> = {
  paymentStatus: { kind: "text", width: 20, getValue: (ctx) => enumLabel(PAYMENT_STATUS_LABELS, ctx.registration.paymentStatus, ctx.lang) },
  paymentMethod: { kind: "text", width: 20, getValue: (ctx) => enumLabel(PAYMENT_METHOD_LABELS, ctx.registration.paymentMethod, ctx.lang) },
  currency: { kind: "text", width: 10, getValue: (ctx) => ctx.registration.currency },
  paidAt: { kind: "datetime", width: 22, getValue: (ctx) => fmtDateTime(ctx.registration.paidAt, ctx.lang) },
  paymentReference: { kind: "text", width: 22, getValue: (ctx) => ctx.registration.paymentReference ?? "" },
  paymentProofUrl: { kind: "url", width: 34, getValue: (ctx) => ctx.registration.paymentProofUrl ?? "" },
  totalAmount: moneySpec("totalAmount"),
  paidAmount: moneySpec("paidAmount"),
  baseAmount: moneySpec("baseAmount"),
  accessAmount: moneySpec("accessAmount"),
  discountAmount: moneySpec("discountAmount"),
  sponsorshipAmount: moneySpec("sponsorshipAmount"),
};

function labDetail(ctx: RowContext) {
  const code = ctx.registration.sponsorshipCode;
  return code ? ctx.sponsorshipByCode.get(code) : undefined;
}

const SPONSORSHIP_SPECS: Record<SponsorshipField, ColumnSpec & { needsLab?: boolean }> = {
  sponsorshipCode: { kind: "text", width: 16, getValue: (ctx) => ctx.registration.sponsorshipCode ?? "" },
  labName: { kind: "text", width: 26, getValue: (ctx) => ctx.registration.labName ?? "" },
  labContactName: { kind: "text", width: 24, needsLab: true, getValue: (ctx) => labDetail(ctx)?.batch.contactName ?? "" },
  labEmail: { kind: "text", width: 28, needsLab: true, getValue: (ctx) => labDetail(ctx)?.batch.email ?? "" },
  labPhone: { kind: "text", width: 18, needsLab: true, getValue: (ctx) => labDetail(ctx)?.batch.phone ?? "" },
  beneficiaryAddress: { kind: "longtext", width: 34, needsLab: true, getValue: (ctx) => labDetail(ctx)?.beneficiaryAddress ?? "" },
};

export function needsSponsorshipLabDetails(fields: SponsorshipField[]): boolean {
  return fields.some((field) => SPONSORSHIP_SPECS[field].needsLab);
}
