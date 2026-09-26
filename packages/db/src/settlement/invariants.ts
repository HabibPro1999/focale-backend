import { sql, type SQL } from "drizzle-orm";
import { getDb, type DbExecutor } from "../client";
import { rowsOf } from "../helpers";

// Settlement invariant checks (plan 2.4): read-only SQL over registrations,
// sponsorships and access counters, for the PAID repair's before/after
// report and for a staging or CI job (checkSettlementInvariants is the entry
// point; nothing schedules it). Each check lists the offending rows with a
// problem label; the rules are the settlement writer's (2.6) and
// deriveSettlement's (2.5):
// - breakdown_vs_columns: the price_breakdown JSON is complete, internally
//   consistent, and matches sponsorship_amount/base_amount/access_amount,
//   with subtotal ≤ total_amount;
// - status_vs_amounts: each status agrees with the amounts and paid_at
//   (PAID means paid in full; PARTIAL has something covered and something
//   due; PENDING/PARTIAL have no paid_at; nothing is overpaid);
// - sponsorship_vs_usages: a registration's sponsorship_amount is its linked
//   usages' sum (capped at the subtotal), or 0 without usages; a sponsorship
//   is USED exactly when a registration is linked to it;
// - duplicate_codes: a signup code stored by several registrations of an
//   event, a sponsorship linked to several registrations;
// - count_drift: events.registered_count, event_access.registered_count and
//   event_access.paid_count against the registrations (paid places as the
//   writer counts them: every item when PAID/SPONSORED/WAIVED, the
//   sponsorship-covered items when PARTIAL).
// Both engines (PostgreSQL, CockroachDB): JSON values are type-checked
// before any cast, and set-returning calls only see arrays.

export const SETTLEMENT_INVARIANT_CHECKS = [
  "breakdown_vs_columns",
  "status_vs_amounts",
  "sponsorship_vs_usages",
  "duplicate_codes",
  "count_drift",
] as const;

export type SettlementInvariantCheckName = (typeof SETTLEMENT_INVARIANT_CHECKS)[number];

export interface SettlementInvariantCheck {
  name: SettlementInvariantCheckName;
  description: string;
  /** Number of offending rows. */
  violations: number;
  /** The first offending rows (sampleLimit), each with a `problem` label. */
  samples: Record<string, unknown>[];
}

export interface SettlementInvariantReport {
  ok: boolean;
  checkedAt: string;
  eventId: string | null;
  checks: SettlementInvariantCheck[];
}

export interface SettlementInvariantOptions {
  /** Limit every check to one event. */
  eventId?: string;
  /** Offending rows kept per check (default 50). */
  sampleLimit?: number;
}

/**
 * A price_breakdown number field as DECIMAL, NULL when it is not a JSON
 * number. The field name is an inline literal (an untyped placeholder after
 * -> is ambiguous on CockroachDB); only the constants below are passed.
 */
function num(json: SQL, field: "subtotal" | "calculatedBasePrice" | "accessTotal" | "sponsorshipTotal" | "total"): SQL {
  const key = sql.raw(`'${field}'`);
  return sql`(CASE WHEN jsonb_typeof(${json}->${key}) = 'number' THEN (${json}->>${key})::DECIMAL END)`;
}

/** The breakdown's accessItems when it is an array, else NULL (no rows from jsonb_array_elements). */
const ACCESS_ITEMS = sql`(CASE WHEN jsonb_typeof(r.price_breakdown->'accessItems') = 'array' THEN r.price_breakdown->'accessItems' END)`;
const PB = sql`r.price_breakdown`;
const NET = sql`GREATEST(0, r.total_amount - r.sponsorship_amount)`;

/** Columns returned as numbers (node-postgres gives COUNT/SUM/DECIMAL as strings). */
const NUMERIC_KEYS = new Set([
  "count",
  "net",
  "totalAmount",
  "sponsorshipAmount",
  "paidAmount",
  "usagesApplied",
  "linkedUsages",
  "orphanUsages",
  "storedRegistered",
  "actualRegistered",
  "storedPaid",
  "actualPaid",
]);

function normalize(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (NUMERIC_KEYS.has(key) && value !== null && value !== undefined) out[key] = Number(value);
    else if (Array.isArray(value)) out[key] = value.map(String).sort();
    else out[key] = value;
  }
  return out;
}

async function rows(db: DbExecutor, query: SQL): Promise<Record<string, unknown>[]> {
  return rowsOf<Record<string, unknown>>(await db.execute(query)).map(normalize);
}

function registrationFilter(eventId: string | undefined, column: SQL = sql`r.event_id`): SQL {
  return eventId ? sql`AND ${column} = ${eventId}` : sql``;
}

async function breakdownVsColumns(db: DbExecutor, eventId?: string) {
  // A missing key makes jsonb_typeof NULL, hence the IS NOT TRUE below (NOT NULL is not true).
  const complete = sql`(
    jsonb_typeof(${PB}->'subtotal') = 'number'
    AND jsonb_typeof(${PB}->'calculatedBasePrice') = 'number'
    AND jsonb_typeof(${PB}->'accessTotal') = 'number'
    AND jsonb_typeof(${PB}->'sponsorshipTotal') = 'number'
    AND jsonb_typeof(${PB}->'total') = 'number'
    AND jsonb_typeof(${PB}->'accessItems') = 'array')`;
  const subtotal = num(PB, "subtotal");
  const base = num(PB, "calculatedBasePrice");
  const accessTotal = num(PB, "accessTotal");
  const sponsorshipTotal = num(PB, "sponsorshipTotal");
  const total = num(PB, "total");
  return rows(
    db,
    sql`
      WITH items AS (
        SELECT r.id AS registration_id,
          SUM(CASE WHEN jsonb_typeof(item->'subtotal') = 'number' THEN (item->>'subtotal')::DECIMAL END) AS items_total,
          SUM(CASE WHEN jsonb_typeof(item->'subtotal') = 'number' THEN 0 ELSE 1 END) AS bad_items
        FROM registrations r, LATERAL jsonb_array_elements(${ACCESS_ITEMS}) AS item
        WHERE TRUE ${registrationFilter(eventId)}
        GROUP BY r.id
      ), checked AS (
        SELECT r.id, r.event_id AS "eventId", r.total_amount AS "totalAmount",
          r.sponsorship_amount AS "sponsorshipAmount",
          CASE
            WHEN ${complete} IS NOT TRUE THEN 'BREAKDOWN_INCOMPLETE'
            WHEN COALESCE(i.bad_items, 0) > 0 THEN 'ACCESS_ITEM_WITHOUT_SUBTOTAL'
            WHEN ${sponsorshipTotal} <> r.sponsorship_amount THEN 'SPONSORSHIP_TOTAL_MISMATCH'
            WHEN ${sponsorshipTotal} > ${subtotal} THEN 'SPONSORSHIP_EXCEEDS_SUBTOTAL'
            WHEN ${total} <> ${subtotal} - ${sponsorshipTotal} THEN 'TOTAL_NOT_SUBTOTAL_MINUS_SPONSORSHIP'
            WHEN ${subtotal} <> ${base} + ${accessTotal} THEN 'SUBTOTAL_NOT_BASE_PLUS_ACCESS'
            WHEN ${accessTotal} <> COALESCE(i.items_total, 0) THEN 'ACCESS_TOTAL_NOT_ITEMS_SUM'
            WHEN ${subtotal} > r.total_amount THEN 'SUBTOTAL_EXCEEDS_TOTAL_AMOUNT'
            WHEN ${base} <> r.base_amount THEN 'BASE_AMOUNT_MISMATCH'
            WHEN ${accessTotal} <> r.access_amount THEN 'ACCESS_AMOUNT_MISMATCH'
          END AS problem
        FROM registrations r
        LEFT JOIN items i ON i.registration_id = r.id
        WHERE TRUE ${registrationFilter(eventId)}
      )
      SELECT * FROM checked WHERE problem IS NOT NULL ORDER BY "eventId", id
    `,
  );
}

async function statusVsAmounts(db: DbExecutor, eventId?: string) {
  return rows(
    db,
    sql`
      SELECT * FROM (
        SELECT r.id, r.event_id AS "eventId", r.payment_status::TEXT AS "paymentStatus",
          r.total_amount AS "totalAmount", r.sponsorship_amount AS "sponsorshipAmount",
          r.paid_amount AS "paidAmount", ${NET} AS net,
          CASE
            WHEN r.sponsorship_amount > r.total_amount THEN 'SPONSORSHIP_EXCEEDS_TOTAL'
            WHEN r.payment_status::TEXT <> 'REFUNDED' AND r.paid_amount > ${NET} THEN 'OVERPAID'
            WHEN r.payment_status::TEXT = 'PAID' AND r.paid_amount < ${NET} THEN 'PAID_BELOW_NET'
            WHEN r.payment_status::TEXT = 'PAID' AND r.paid_at IS NULL THEN 'PAID_WITHOUT_PAID_AT'
            WHEN r.payment_status::TEXT = 'SPONSORED' AND (r.total_amount = 0 OR r.sponsorship_amount < r.total_amount)
              THEN 'SPONSORED_NOT_COVERED'
            WHEN r.payment_status::TEXT = 'SPONSORED' AND r.paid_at IS NULL THEN 'SPONSORED_WITHOUT_PAID_AT'
            WHEN r.payment_status::TEXT = 'PARTIAL' AND r.paid_amount + r.sponsorship_amount = 0 THEN 'PARTIAL_WITHOUT_COVERAGE'
            WHEN r.payment_status::TEXT = 'PARTIAL' AND r.paid_amount >= ${NET} THEN 'PARTIAL_NOTHING_DUE'
            WHEN r.payment_status::TEXT IN ('PENDING', 'PARTIAL') AND r.paid_at IS NOT NULL THEN 'UNSETTLED_WITH_PAID_AT'
            WHEN r.payment_status::TEXT = 'PENDING' AND r.paid_amount > 0 THEN 'PENDING_WITH_PAYMENT'
            WHEN r.payment_status::TEXT = 'PENDING' AND r.total_amount > 0 AND r.sponsorship_amount >= r.total_amount
              THEN 'PENDING_FULLY_SPONSORED'
            WHEN r.payment_status::TEXT = 'PENDING' AND r.sponsorship_amount > 0 THEN 'PENDING_WITH_SPONSORSHIP'
          END AS problem
        FROM registrations r
        WHERE TRUE ${registrationFilter(eventId)}
      ) checked
      WHERE problem IS NOT NULL
      ORDER BY "eventId", id
    `,
  );
}

async function sponsorshipVsUsages(db: DbExecutor, eventId?: string) {
  const subtotal = sql`COALESCE(${num(PB, "subtotal")}, r.total_amount::DECIMAL)`;
  const registrationRows = await rows(
    db,
    sql`
      WITH linked AS (
        SELECT su.registration_id, SUM(su.amount_applied) AS applied
        FROM sponsorship_usages su
        WHERE su.registration_id IS NOT NULL
        GROUP BY su.registration_id
      )
      SELECT 'registration' AS entity, r.id, r.event_id AS "eventId",
        r.sponsorship_amount AS "sponsorshipAmount", l.applied AS "usagesApplied",
        CASE WHEN l.registration_id IS NULL THEN 'AMOUNT_WITHOUT_USAGE' ELSE 'AMOUNT_NOT_USAGE_SUM' END AS problem
      FROM registrations r
      LEFT JOIN linked l ON l.registration_id = r.id
      WHERE (
          (l.registration_id IS NULL AND r.sponsorship_amount > 0)
          OR (l.registration_id IS NOT NULL AND r.sponsorship_amount <> LEAST(l.applied::DECIMAL, ${subtotal}))
        ) ${registrationFilter(eventId)}
      ORDER BY r.event_id, r.id
    `,
  );
  const sponsorshipRows = await rows(
    db,
    sql`
      SELECT * FROM (
        SELECT 'sponsorship' AS entity, s.id, s.event_id AS "eventId", s.code, s.status::TEXT AS status,
          SUM(CASE WHEN su.registration_id IS NOT NULL THEN 1 ELSE 0 END) AS "linkedUsages",
          SUM(CASE WHEN su.id IS NOT NULL AND su.registration_id IS NULL THEN 1 ELSE 0 END) AS "orphanUsages"
        FROM sponsorships s
        LEFT JOIN sponsorship_usages su ON su.sponsorship_id = s.id
        WHERE TRUE ${registrationFilter(eventId, sql`s.event_id`)}
        GROUP BY s.id, s.event_id, s.code, s.status
      ) counted
      WHERE (status = 'USED' AND "linkedUsages" = 0) OR (status <> 'USED' AND "linkedUsages" > 0) OR "orphanUsages" > 0
      ORDER BY "eventId", id
    `,
  );
  return [
    ...registrationRows,
    ...sponsorshipRows.map((row) => ({
      ...row,
      problem:
        Number(row.orphanUsages) > 0 && (row.status === "USED") === Number(row.linkedUsages) > 0
          ? "USAGE_WITHOUT_REGISTRATION"
          : row.status === "USED"
            ? "USED_WITHOUT_USAGE"
            : `${String(row.status)}_WITH_USAGE`,
    })),
  ];
}

async function duplicateCodes(db: DbExecutor, eventId?: string) {
  const stored = await rows(
    db,
    sql`
      SELECT 'registration_code' AS entity, r.event_id AS "eventId", upper(trim(r.sponsorship_code)) AS code,
        COUNT(*) AS count, array_agg(r.id) AS "registrationIds", 'CODE_STORED_BY_SEVERAL' AS problem
      FROM registrations r
      WHERE nullif(trim(r.sponsorship_code), '') IS NOT NULL ${registrationFilter(eventId)}
      GROUP BY r.event_id, upper(trim(r.sponsorship_code))
      HAVING COUNT(*) > 1
      ORDER BY "eventId", code
    `,
  );
  const linked = await rows(
    db,
    sql`
      SELECT 'sponsorship' AS entity, s.id, s.event_id AS "eventId", s.code,
        COUNT(DISTINCT su.registration_id) AS count, array_agg(DISTINCT su.registration_id) AS "registrationIds",
        'LINKED_TO_SEVERAL' AS problem
      FROM sponsorships s
      JOIN sponsorship_usages su ON su.sponsorship_id = s.id AND su.registration_id IS NOT NULL
      WHERE TRUE ${registrationFilter(eventId, sql`s.event_id`)}
      GROUP BY s.id, s.event_id, s.code
      HAVING COUNT(DISTINCT su.registration_id) > 1
      ORDER BY "eventId", s.id
    `,
  );
  return [...stored, ...linked];
}

async function countDrift(db: DbExecutor, eventId?: string) {
  const eventRows = await rows(
    db,
    sql`
      SELECT 'event' AS entity, e.id, e.id AS "eventId", e.registered_count AS "storedRegistered",
        COUNT(r.id) AS "actualRegistered", 'EVENT_REGISTERED_COUNT_DRIFT' AS problem
      FROM events e
      LEFT JOIN registrations r ON r.event_id = e.id
      WHERE TRUE ${registrationFilter(eventId, sql`e.id`)}
      GROUP BY e.id, e.registered_count
      HAVING e.registered_count <> COUNT(r.id)
      ORDER BY e.id
    `,
  );
  const accessRows = await rows(
    db,
    sql`
      WITH items AS (
        SELECT r.id AS registration_id, r.payment_status::TEXT AS payment_status,
          item->>'accessId' AS access_id,
          CASE WHEN jsonb_typeof(item->'quantity') = 'number' THEN (item->>'quantity')::DECIMAL ELSE 0 END AS quantity
        FROM registrations r, LATERAL jsonb_array_elements(${ACCESS_ITEMS}) AS item
        WHERE TRUE ${registrationFilter(eventId)}
      ), covered AS (
        SELECT DISTINCT pairs.registration_id, pairs.access_id FROM (
          SELECT su.registration_id, unnest(s.covered_access_ids) AS access_id
          FROM sponsorship_usages su
          JOIN sponsorships s ON s.id = su.sponsorship_id
          WHERE su.registration_id IS NOT NULL
        ) pairs
      ), counted AS (
        SELECT i.access_id,
          SUM(i.quantity) AS registered,
          SUM(CASE
            WHEN i.payment_status IN ('PAID', 'SPONSORED', 'WAIVED') THEN i.quantity
            WHEN i.payment_status = 'PARTIAL' AND c.access_id IS NOT NULL THEN i.quantity
            ELSE 0 END) AS paid
        FROM items i
        LEFT JOIN covered c ON c.registration_id = i.registration_id AND c.access_id = i.access_id
        GROUP BY i.access_id
      )
      SELECT * FROM (
        SELECT 'access' AS entity, a.id, a.event_id AS "eventId", a.name,
          a.registered_count AS "storedRegistered", COALESCE(c.registered, 0) AS "actualRegistered",
          a.paid_count AS "storedPaid", COALESCE(c.paid, 0) AS "actualPaid",
          CASE
            WHEN a.paid_count <> COALESCE(c.paid, 0) AND a.registered_count <> COALESCE(c.registered, 0)
              THEN 'ACCESS_REGISTERED_AND_PAID_COUNT_DRIFT'
            WHEN a.paid_count <> COALESCE(c.paid, 0) THEN 'ACCESS_PAID_COUNT_DRIFT'
            WHEN a.registered_count <> COALESCE(c.registered, 0) THEN 'ACCESS_REGISTERED_COUNT_DRIFT'
          END AS problem
        FROM event_access a
        LEFT JOIN counted c ON c.access_id = a.id
        WHERE TRUE ${registrationFilter(eventId, sql`a.event_id`)}
      ) drift
      WHERE problem IS NOT NULL
      ORDER BY "eventId", id
    `,
  );
  return [...eventRows, ...accessRows];
}

const CHECKS: Record<
  SettlementInvariantCheckName,
  { description: string; run: (db: DbExecutor, eventId?: string) => Promise<Record<string, unknown>[]> }
> = {
  breakdown_vs_columns: {
    description: "price_breakdown complete, consistent, and matching the amount columns",
    run: breakdownVsColumns,
  },
  status_vs_amounts: {
    description: "payment status agrees with the amounts and paid_at",
    run: statusVsAmounts,
  },
  sponsorship_vs_usages: {
    description: "sponsorship amounts match linked usages; USED exactly when linked",
    run: sponsorshipVsUsages,
  },
  duplicate_codes: {
    description: "a signup code stored by several registrations; a sponsorship linked to several",
    run: duplicateCodes,
  },
  count_drift: {
    description: "event and access registered/paid counters match the registrations",
    run: countDrift,
  },
};

/**
 * Run every settlement invariant check (read-only). `ok` is true when no
 * check found an offending row. Suitable for a staging job or a CI step
 * against a restored snapshot; the repair script's `invariants` subcommand
 * prints it.
 */
export async function checkSettlementInvariants(
  options: SettlementInvariantOptions = {},
  db: DbExecutor = getDb(),
): Promise<SettlementInvariantReport> {
  const sampleLimit = options.sampleLimit ?? 50;
  const checks: SettlementInvariantCheck[] = [];
  for (const name of SETTLEMENT_INVARIANT_CHECKS) {
    const { description, run } = CHECKS[name];
    const found = await run(db, options.eventId);
    checks.push({ name, description, violations: found.length, samples: found.slice(0, sampleLimit) });
  }
  return {
    ok: checks.every((check) => check.violations === 0),
    checkedAt: new Date().toISOString(),
    eventId: options.eventId ?? null,
    checks,
  };
}
