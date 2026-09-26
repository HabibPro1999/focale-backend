import { asc, gt } from "drizzle-orm";
import {
  PriceBreakdownSchema,
  StoredCertificateZonesSchema,
  StoredEmailContextSnapshotSchema,
  StoredFormSchemaJsonSchema,
  StoredPricingRulesSchema,
  type StoredCertificateZones,
  type StoredEmailContextSnapshot,
  type StoredFormSchemaJson,
  type PriceBreakdown,
  type StoredPricingRules,
} from "@app/contracts";
import { getDb } from "../client";
import { parseJsonb } from "../jsonb";
import { certificateTemplates } from "../schema/certificates";
import { emailLogs } from "../schema/email";
import { forms } from "../schema/forms";
import { eventPricing } from "../schema/pricing";
import { registrations } from "../schema/registrations";

// The typed JSONB columns (plan 5.2) and their read-boundary checks. Every
// query that hands one of these columns to a caller runs it through the
// matching reader (JSONB_VALIDATION decides what an invalid document does).
// Rows returned by a write (`RETURNING`) are not re-checked: the write path
// validated what it stored.
//
// `registrations.price_breakdown` is checked where it is used: the
// registration reads of the admin, public and sponsorship routes and the
// settlement reads (settle, access drop, sponsorship link). Two kinds of read
// are left out on purpose: the repair tools (paid-repair,
// sponsorship-code-repair) classify a breakdown they cannot settle themselves
// instead of being refused, and whole-row reads that never use the breakdown
// (email and certificate contexts, exports, networking) are typed by the
// column only.

/** Every typed JSONB column, for the read-only stored-JSON audit. */
export const STORED_JSONB_COLUMNS = [
  {
    name: "event_pricing.rules",
    table: eventPricing,
    id: eventPricing.id,
    column: eventPricing.rules,
    schema: StoredPricingRulesSchema,
  },
  {
    name: "certificate_templates.zones",
    table: certificateTemplates,
    id: certificateTemplates.id,
    column: certificateTemplates.zones,
    schema: StoredCertificateZonesSchema,
  },
  {
    name: "forms.schema",
    table: forms,
    id: forms.id,
    column: forms.schema,
    schema: StoredFormSchemaJsonSchema,
  },
  {
    name: "email_logs.context_snapshot",
    table: emailLogs,
    id: emailLogs.id,
    column: emailLogs.contextSnapshot,
    schema: StoredEmailContextSnapshotSchema,
  },
  {
    name: "registrations.price_breakdown",
    table: registrations,
    id: registrations.id,
    column: registrations.priceBreakdown,
    schema: PriceBreakdownSchema,
  },
] as const;

export type StoredJsonbColumn = (typeof STORED_JSONB_COLUMNS)[number];

/**
 * One keyset page (ids after `afterId`, ascending) of a typed JSONB column,
 * read raw in its own READ ONLY transaction: the stored-JSON audit's read.
 */
export async function readStoredJsonbPage(
  entry: StoredJsonbColumn,
  afterId: string | undefined,
  limit: number,
): Promise<{ id: string; value: unknown }[]> {
  return getDb().transaction(
    (tx) =>
      tx
        .select({ id: entry.id, value: entry.column })
        .from(entry.table)
        .where(afterId === undefined ? undefined : gt(entry.id, afterId))
        .orderBy(asc(entry.id))
        .limit(limit),
    { accessMode: "read only" },
  );
}

export function readPricingRules(value: unknown, id?: string | null): StoredPricingRules {
  return parseJsonb(StoredPricingRulesSchema, value, { column: "event_pricing.rules", id });
}

export function readCertificateZones(value: unknown, id?: string | null): StoredCertificateZones {
  return parseJsonb(StoredCertificateZonesSchema, value, {
    column: "certificate_templates.zones",
    id,
  });
}

export function readFormSchema(value: unknown, id?: string | null): StoredFormSchemaJson {
  return parseJsonb(StoredFormSchemaJsonSchema, value, { column: "forms.schema", id });
}

export function readEmailContextSnapshot(
  value: unknown,
  id?: string | null,
): StoredEmailContextSnapshot {
  return parseJsonb(StoredEmailContextSnapshotSchema, value, {
    column: "email_logs.context_snapshot",
    id,
  });
}

export function readPriceBreakdown(value: unknown, id?: string | null): PriceBreakdown {
  return parseJsonb(PriceBreakdownSchema, value, { column: "registrations.price_breakdown", id });
}

/** Check a pricing row's `rules` (null passes: a left join without pricing). Returns the row. */
export function checkPricingRow<T extends { id: string; rules: unknown } | null>(row: T): T {
  if (row) readPricingRules(row.rules, row.id);
  return row;
}

/** Check a form row's `schema`. Returns the row. */
export function checkFormRow<T extends { id: string; schema: unknown } | null | undefined>(
  row: T,
): T {
  if (row) readFormSchema(row.schema, row.id);
  return row;
}

/** Check a certificate template row's `zones`. Returns the row. */
export function checkCertificateTemplateRow<T extends { id: string; zones: unknown }>(row: T): T {
  readCertificateZones(row.zones, row.id);
  return row;
}

/** Check a registration row's `priceBreakdown`. Returns the row. */
export function checkRegistrationRow<
  T extends { id: string; priceBreakdown: unknown } | null | undefined,
>(row: T): T {
  if (row) readPriceBreakdown(row.priceBreakdown, row.id);
  return row;
}
