import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../client";
import { rowCountOf, rowsOf } from "../helpers";

/**
 * Database time as a naive UTC timestamp, the format of the queue tables'
 * `timestamp(3)` columns. Every lease time comes from the database, so
 * workers and the API never compare their own clocks. The queue runs one
 * autocommit statement per call, so the statement start is exact enough, and
 * unlike clock_timestamp() it is stable (usable in index conditions).
 */
export const DB_NOW: SQL = sql.raw(`(statement_timestamp() AT TIME ZONE 'UTC')`);

/** An interval parameter of `ms` milliseconds (typed for both engines). */
export function intervalMs(ms: number): SQL {
  return sql`${`${Math.max(0, Math.round(ms)) / 1000} seconds`}::interval`;
}

/**
 * A retry delay keyed on an attempt number (a SQL expression): the n-th
 * delay for attempt n, the last one for every later attempt. An interval, for
 * `DB_NOW + backoffInterval(…)`.
 */
export function backoffInterval(attempt: SQL, delaysMs: readonly number[]): SQL {
  const last = delaysMs.length - 1;
  if (last < 0) throw new Error("backoffInterval needs at least one delay");
  if (last === 0) return intervalMs(delaysMs[0]!);
  const steps = delaysMs
    .slice(0, last)
    .map((ms, i) => sql`WHEN ${attempt} <= ${sql.raw(String(i + 1))} THEN ${intervalMs(ms)}`);
  return sql`(CASE ${sql.join(steps, sql` `)} ELSE ${intervalMs(delaysMs[last]!)} END)`;
}

/**
 * A table leased row by row. Every queue table has the lease columns `id`,
 * `status`, `attempt_count`, `locked_at`, `locked_until`, `locked_by`,
 * `last_attempt_at` and `updated_at`; the spec supplies the queue's own
 * states as trusted SQL fragments (constants, never user input).
 *
 * Ownership is `status = leasedStatus AND locked_by = workerId`. Only
 * recoverStale takes a row away from its owner (it moves the row out of the
 * leased status and clears locked_by), so every owner write is fenced by it.
 */
export interface LeaseQueueSpec {
  /** Name for logs. */
  name: string;
  /** Table name (a trusted constant). */
  table: string;
  /** Status of a leased row. */
  leasedStatus: string;
  /** Lease length; runLeased's heartbeat renews it while rows are processed. */
  leaseMs: number;
  /** Rows that may be claimed now (status, due time, attempt cap, scope). Use DB_NOW for time. */
  claimable: SQL;
  /** Which claimable rows are claimed first, e.g. sql`"created_at" ASC`. */
  order: SQL;
  /** Extra assignments made on claim, e.g. sql`"error_message" = NULL`. */
  claimSet?: SQL;
  /**
   * Assignments that put a released row back in the queue (at least
   * `status`). Evaluated against the claimed row: `attempt_count` still
   * includes the claim being refunded.
   */
  releaseSet: SQL;
  /**
   * Owned rows that release may put back (default all). A row outside it
   * stays leased until stale-lease recovery handles it: e.g. an email whose
   * provider call may already have gone out must not be requeued for free.
   */
  releasable?: SQL;
  /** Stale-lease recovery of rows whose lease expired (their worker died or hung). */
  recovery: {
    /** Rows that used up their attempts: dead-lettered instead of requeued. */
    exhausted: SQL;
    /** Assignments for an expired row with attempts left (back to claimable). */
    retrySet: SQL;
    /** Assignments for an expired row without attempts left. */
    deadSet: SQL;
    /**
     * Expired rows whose work may already have taken effect and must not run
     * again (`where`), parked with `set` instead of requeued or dead-lettered.
     */
    uncertain?: { where: SQL; set: SQL };
    /** Leased rows this queue does not own (e.g. email rows dispatched by networking). */
    exclude?: SQL;
  };
}

export interface LeaseQueueHealth {
  /** Rows claimable now. */
  claimable: number;
  /** Rows currently leased. */
  leased: number;
  /** Leased rows whose lease expired (awaiting recovery). */
  expiredLeases: number;
  /** Age of the oldest lease in ms (0 when nothing is leased). */
  oldestLeaseAgeMs: number;
}

export interface RecoverStaleResult {
  requeued: number;
  deadLettered: number;
  /** Rows parked by `recovery.uncertain` (only for a queue that has it). */
  uncertain?: number;
}

export interface LeaseQueue {
  readonly spec: LeaseQueueSpec;
  /**
   * Lease up to `limit` claimable rows, first in spec order, for `workerId`
   * (attempt_count + 1). Returns their ids in no particular order (UPDATE …
   * RETURNING keeps none); the caller's load orders the rows. On
   * CockroachDB, SKIP LOCKED can transiently skip rows just written by a
   * committed transaction (cockroachdb/cockroach#167582); the next claim
   * gets them.
   */
  claim(workerId: string, limit: number, leaseMs?: number): Promise<string[]>;
  /** Extend the lease of every id still owned by `workerId`; returns the ids still owned. */
  renew(workerId: string, ids: string[], leaseMs?: number): Promise<string[]>;
  /** Ownership check right before handling a row; extends its lease. */
  confirm(workerId: string, id: string, leaseMs?: number): Promise<boolean>;
  /** Terminal success write (`set`) while `workerId` owns the row; clears the lease. False when not owned. */
  complete(workerId: string, id: string, set: SQL): Promise<boolean>;
  /** Failure write (`set`: retry or dead letter) while owned; clears the lease. False when not owned. */
  fail(workerId: string, id: string, set: SQL): Promise<boolean>;
  /** Put owned, unprocessed (and releasable) rows back without charging the attempt. Returns how many. */
  release(workerId: string, ids: string[]): Promise<number>;
  /**
   * Requeue, or dead-letter once attempts are exhausted, leased rows whose
   * lease expired (or park them, per `recovery.uncertain`); `where` narrows
   * it to some rows (e.g. one event's job).
   */
  recoverStale(where?: SQL): Promise<RecoverStaleResult>;
  health(): Promise<LeaseQueueHealth>;
}

const CLEAR_LEASE = sql.raw(`"locked_at" = NULL, "locked_until" = NULL, "locked_by" = NULL`);

function idList(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

export function createLeaseQueue(spec: LeaseQueueSpec): LeaseQueue {
  const table = sql.identifier(spec.table);
  const leased = spec.leasedStatus;
  const leaseFor = (ms?: number) => intervalMs(ms ?? spec.leaseMs);
  const owned = (workerId: string) => sql`"status" = ${leased} AND "locked_by" = ${workerId}`;

  const finish = async (workerId: string, id: string, set: SQL): Promise<boolean> => {
    const res = await getDb().execute(sql`
      UPDATE ${table}
      SET ${set}, ${CLEAR_LEASE}, "updated_at" = ${DB_NOW}
      WHERE "id" = ${id} AND ${owned(workerId)}
      RETURNING "id"
    `);
    return rowCountOf(res) > 0;
  };

  const renew = async (workerId: string, ids: string[], leaseMs?: number): Promise<string[]> => {
    if (ids.length === 0) return [];
    const res = await getDb().execute(sql`
      UPDATE ${table}
      SET "locked_until" = ${DB_NOW} + ${leaseFor(leaseMs)}
      WHERE "id" IN (${idList(ids)}) AND ${owned(workerId)}
      RETURNING "id"
    `);
    return rowsOf<{ id: string }>(res).map((row) => row.id);
  };

  // Stale: the lease expired. A leased row without a lease end (written by
  // older code) is stale once it was locked (or last touched) a lease ago.
  const stale = sql`(
    "locked_until" < ${DB_NOW}
    OR ("locked_until" IS NULL AND COALESCE("locked_at", "updated_at") < ${DB_NOW} - ${leaseFor()})
  )`;
  const recoverable = spec.recovery.exclude
    ? sql`"status" = ${leased} AND ${stale} AND NOT (${spec.recovery.exclude})`
    : sql`"status" = ${leased} AND ${stale}`;

  return {
    spec,

    async claim(workerId, limit, leaseMs) {
      if (limit <= 0) return [];
      const res = await getDb().execute(sql`
        UPDATE ${table}
        SET "status" = ${leased},
            "locked_at" = ${DB_NOW},
            "locked_until" = ${DB_NOW} + ${leaseFor(leaseMs)},
            "locked_by" = ${workerId},
            "last_attempt_at" = ${DB_NOW},
            "attempt_count" = "attempt_count" + 1,
            "updated_at" = ${DB_NOW}
            ${spec.claimSet ? sql`, ${spec.claimSet}` : sql``}
        WHERE "id" IN (
          SELECT "id" FROM ${table}
          WHERE (${spec.claimable})
          ORDER BY ${spec.order}
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING "id"
      `);
      return rowsOf<{ id: string }>(res).map((row) => row.id);
    },

    renew,

    async confirm(workerId, id, leaseMs) {
      return (await renew(workerId, [id], leaseMs)).length === 1;
    },

    complete: finish,
    fail: finish,

    async release(workerId, ids) {
      if (ids.length === 0) return 0;
      const res = await getDb().execute(sql`
        UPDATE ${table}
        SET ${spec.releaseSet},
            "attempt_count" = GREATEST("attempt_count" - 1, 0),
            ${CLEAR_LEASE},
            "updated_at" = ${DB_NOW}
        WHERE "id" IN (${idList(ids)}) AND ${owned(workerId)}
          ${spec.releasable ? sql`AND (${spec.releasable})` : sql``}
        RETURNING "id"
      `);
      return rowCountOf(res);
    },

    async recoverStale(where) {
      const scoped = where ? sql`${recoverable} AND (${where})` : recoverable;
      const parked = spec.recovery.uncertain;
      let uncertain: number | undefined;
      if (parked) {
        uncertain = rowCountOf(
          await getDb().execute(sql`
            UPDATE ${table}
            SET ${parked.set}, ${CLEAR_LEASE}, "updated_at" = ${DB_NOW}
            WHERE ${scoped} AND COALESCE((${parked.where}), FALSE)
          `),
        );
      }
      const rows = parked ? sql`${scoped} AND NOT COALESCE((${parked.where}), FALSE)` : scoped;
      const requeued = rowCountOf(
        await getDb().execute(sql`
          UPDATE ${table}
          SET ${spec.recovery.retrySet}, ${CLEAR_LEASE}, "updated_at" = ${DB_NOW}
          WHERE ${rows} AND NOT (${spec.recovery.exhausted})
        `),
      );
      const deadLettered = rowCountOf(
        await getDb().execute(sql`
          UPDATE ${table}
          SET ${spec.recovery.deadSet}, ${CLEAR_LEASE}, "updated_at" = ${DB_NOW}
          WHERE ${rows} AND (${spec.recovery.exhausted})
        `),
      );
      return uncertain === undefined ? { requeued, deadLettered } : { requeued, deadLettered, uncertain };
    },

    async health() {
      // Ages in SQL: raw execute() returns naive timestamps as strings, and
      // parsing them in JS would skew by the host offset.
      const res = await getDb().execute(sql`
        SELECT
          COALESCE(SUM(CASE WHEN (${spec.claimable}) THEN 1 ELSE 0 END), 0)::int AS claimable,
          COALESCE(SUM(CASE WHEN "status" = ${leased} THEN 1 ELSE 0 END), 0)::int AS leased,
          COALESCE(SUM(CASE WHEN "status" = ${leased} AND ${stale} THEN 1 ELSE 0 END), 0)::int AS expired,
          COALESCE(EXTRACT(EPOCH FROM (${DB_NOW} - MIN(CASE WHEN "status" = ${leased}
            THEN COALESCE("locked_at", "updated_at") END))) * 1000, 0)::float8 AS age
        FROM ${table}
        WHERE (${spec.claimable}) OR "status" = ${leased}
      `);
      const row = rowsOf<{ claimable: number | string; leased: number | string; expired: number | string; age: number | string }>(res)[0];
      return {
        claimable: Number(row?.claimable ?? 0),
        leased: Number(row?.leased ?? 0),
        expiredLeases: Number(row?.expired ?? 0),
        oldestLeaseAgeMs: Math.max(0, Math.round(Number(row?.age ?? 0))),
      };
    },
  };
}
