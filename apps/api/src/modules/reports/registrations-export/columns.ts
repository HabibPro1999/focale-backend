import type { ExportRegistrationsBody, ExportLanguage, IdentityField, SubmissionField, PaymentField, SponsorshipField } from "@app/contracts";
import type { ModularRegistrationRow, RegistrationFormColumn } from "@app/db";
import { formatDateTime } from "@app/shared";
import { asFormRecord } from "../export-values";
import { GROUP_LABELS, IDENTITY_HEADERS, SUBMISSION_HEADERS, PAYMENT_HEADERS, SPONSORSHIP_HEADERS, PAYMENT_STATUS_LABELS, PAYMENT_METHOD_LABELS, ROLE_LABELS, TX_TYPE_LABELS, YES_NO, TRANSACTIONS_HEADER, DROPPED_ACCESS_HEADER, GLOBAL_CHECKIN_AT, GLOBAL_CHECKIN_BY, CHECKIN_SUFFIX } from "./labels";

// ============================================================================
// Helpers — value formatting
// ============================================================================

/** Event-local date and time (shared export format). */
function fmtDateTime(d: Date | null | undefined, lang: ExportLanguage): string {
  return d ? formatDateTime(d, lang) : "";
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

function buildColumns(
  body: ExportRegistrationsBody,
  formColumns: RegistrationFormColumn[],
  lang: ExportLanguage,
  accessNameById: Map<string, string>,
): ColumnDescriptor[] {
  const out: ColumnDescriptor[] = [];
  const { columns } = body;

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
        const fd = asFormRecord(ctx.registration.formData);
        return resolveFormFieldValue(col, fd);
      },
    });
  }

  return out;
}

// ── individual column builders ────────────────────────────────────────────

type ColumnSpec = Pick<ColumnDescriptor, "kind" | "width" | "getValue"> & { needsLab?: boolean };

function fromSpec(group: ColumnDescriptor["group"], header: string, spec: ColumnSpec): ColumnDescriptor {
  return { group, header, kind: spec.kind, width: spec.width, getValue: spec.getValue };
}

const IDENTITY_SPECS: Record<IdentityField, ColumnSpec> = {
  id: {
    kind: "text",
    width: 38,
    getValue: (ctx) => ctx.registration.id,
  },
  referenceNumber: {
    kind: "text",
    width: 16,
    getValue: (ctx) => ctx.registration.referenceNumber ?? "",
  },
  email: {
    kind: "text",
    width: 32,
    getValue: (ctx) => ctx.registration.email,
  },
  firstName: {
    kind: "text",
    width: 22,
    getValue: (ctx) => ctx.registration.firstName ?? "",
  },
  lastName: {
    kind: "text",
    width: 22,
    getValue: (ctx) => ctx.registration.lastName ?? "",
  },
  phone: {
    kind: "text",
    width: 18,
    getValue: (ctx) => ctx.registration.phone ?? "",
  },
  role: {
    kind: "text",
    width: 18,
    getValue: (ctx) => enumLabel(ROLE_LABELS, ctx.registration.role, ctx.lang),
  },
  note: {
    kind: "longtext",
    width: 40,
    getValue: (ctx) => ctx.registration.note ?? "",
  },
};

function buildIdentityColumn(field: IdentityField, lang: ExportLanguage): ColumnDescriptor {
  return fromSpec("identity", IDENTITY_HEADERS[field][lang], IDENTITY_SPECS[field]);
}

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

const money = (field: "totalAmount" | "paidAmount" | "baseAmount" | "accessAmount" | "discountAmount" | "sponsorshipAmount"): ColumnSpec => ({
  kind: "money", width: 14, getValue: (ctx) => ctx.registration[field] as number,
});
const PAYMENT_SPECS: Record<PaymentField, ColumnSpec> = {
  paymentStatus: { kind: "text", width: 20, getValue: (ctx) => enumLabel(PAYMENT_STATUS_LABELS, ctx.registration.paymentStatus, ctx.lang) },
  paymentMethod: { kind: "text", width: 20, getValue: (ctx) => enumLabel(PAYMENT_METHOD_LABELS, ctx.registration.paymentMethod, ctx.lang) },
  currency: { kind: "text", width: 10, getValue: (ctx) => ctx.registration.currency },
  paidAt: { kind: "datetime", width: 22, getValue: (ctx) => fmtDateTime(ctx.registration.paidAt, ctx.lang) },
  paymentReference: { kind: "text", width: 22, getValue: (ctx) => ctx.registration.paymentReference ?? "" },
  paymentProofUrl: { kind: "url", width: 34, getValue: (ctx) => ctx.registration.paymentProofUrl ?? "" },
  totalAmount: money("totalAmount"), paidAmount: money("paidAmount"), baseAmount: money("baseAmount"),
  accessAmount: money("accessAmount"), discountAmount: money("discountAmount"), sponsorshipAmount: money("sponsorshipAmount"),
};
function buildPaymentColumn(field: PaymentField, lang: ExportLanguage): ColumnDescriptor {
  return fromSpec("payment", PAYMENT_HEADERS[field][lang], PAYMENT_SPECS[field]);
}

function labDetail(ctx: RowContext) {
  const code = ctx.registration.sponsorshipCode;
  return code ? ctx.sponsorshipByCode.get(code) : undefined;
}
const SPONSORSHIP_SPECS: Record<SponsorshipField, ColumnSpec> = {
  sponsorshipCode: { kind: "text", width: 16, getValue: (ctx) => ctx.registration.sponsorshipCode ?? "" },
  labName: { kind: "text", width: 26, getValue: (ctx) => ctx.registration.labName ?? "" },
  labContactName: { kind: "text", width: 24, needsLab: true, getValue: (ctx) => labDetail(ctx)?.batch.contactName ?? "" },
  labEmail: { kind: "text", width: 28, needsLab: true, getValue: (ctx) => labDetail(ctx)?.batch.email ?? "" },
  labPhone: { kind: "text", width: 18, needsLab: true, getValue: (ctx) => labDetail(ctx)?.batch.phone ?? "" },
  beneficiaryAddress: { kind: "longtext", width: 34, needsLab: true, getValue: (ctx) => labDetail(ctx)?.beneficiaryAddress ?? "" },
};
function buildSponsorshipColumn(field: SponsorshipField, lang: ExportLanguage): ColumnDescriptor {
  return fromSpec("sponsorship", SPONSORSHIP_HEADERS[field][lang], SPONSORSHIP_SPECS[field]);
}
export function needsSponsorshipLabDetails(fields: SponsorshipField[]): boolean {
  return fields.some((field) => SPONSORSHIP_SPECS[field].needsLab);
}

/** The selected columns, or email alone when nothing was selected. */
export function resolveExportColumns(
  body: ExportRegistrationsBody,
  accessItems: { id: string; name: string }[],
  formColumns: RegistrationFormColumn[],
  accessNameById = new Map(accessItems.map((a) => [a.id, a.name])),
): ColumnDescriptor[] {
  const lang = body.language;
  const columns = buildColumns(body, formColumns, lang, accessNameById);

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
  return columns;
}
