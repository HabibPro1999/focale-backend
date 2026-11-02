# @app/db

Drizzle schema, queries, the settlement writer, the outbox and lease queue,
the SQL migrations and their runner, and the cutover tooling, on PostgreSQL and
CockroachDB.

- [Unified migrator](src/migrator/README.md): ledger, adoption, boot check,
  production rollout, how to write a migration and what each migration does to
  existing data.
- [Schema](src/schema/README.md): conventions and the indexes that live only in
  raw migrations.
- [Disposable database test helpers](src/testing/README.md).

## Concurrency control

Accepted 2026-05-30, revised 2026-09 for the NestJS/Drizzle backend (plan item
2.2). The helpers live in `src/txn.ts` and `src/locks.ts`.

Production runs on CockroachDB with `sql.txn.read_committed_isolation.enabled`
on. Its session default is SERIALIZABLE, so every application transaction asks
for its isolation explicitly; PostgreSQL (tests, local) defaults to READ
COMMITTED. The cutover preflight reports that setting and flags it when it is
off.

| Helper | Isolation | Use |
|---|---|---|
| `withTxn` | READ COMMITTED | The default. A lost update does not abort here, it silently overwrites, so any `read → compute → write` over rows another transaction can change is a bug unless a rule below makes it safe. |
| `withSerializableTxn` | SERIALIZABLE, with `withTxnRetry` | Multi-row invariants no single row lock expresses. Keep them short: they abort under contention. |
| `withLockingTxn` | READ COMMITTED, with `withTxnRetry` | The lock-first pattern (rule 2). The retry covers a deadlock between lockers (40P01 on PostgreSQL, 40001 on CockroachDB) and CockroachDB restarts. |

A retried transaction may run more than once, so its callback does database
work only. Email, storage and HTTP go through the outbox or happen after
commit.

### Rules

Every mutation of capacity, money or a denormalized aggregate follows them.

1. **Counters use CAS.** A counter changes in one guarded statement,
   `UPDATE … SET n = n + 1 WHERE <guard> RETURNING …`, which checks and writes
   at once and is correct at any isolation level (`casIncrementRegisteredTx`,
   `casIncrementAccessRegisteredCount`, `casIncrementAccessPaidCount`,
   `casSetSponsorshipUsed`). Never read a counter, add to it in code and write
   it back.
2. **Lock first, then re-read.** A transaction that recomputes a row from other
   rows (settlement from sponsorship usages, a score aggregate from reviews) or
   validates a status before changing it runs in `withLockingTxn`, locks its
   rows first with the `locks.ts` helpers (`lockRegistrationForUpdate` /
   `lockRegistrationsForUpdate`, `lockSponsorshipForUpdate` /
   `lockSponsorshipsForUpdate` / `lockSponsorshipByCodeForUpdate`,
   `lockAbstractForUpdate` / `lockAbstractsForUpdate`,
   `lockEventAccessRowsForUpdate`, `lockEventForUpdate`), then re-reads the
   locked rows and decides only from that read. A value read before the lock,
   or passed in by the caller, is stale.
   - Lock order: **sponsorships → registrations → abstracts**, then the counter
     CAS updates, which also lock the counter row until commit. Several rows of
     one table go through the plural helper, which locks them in ascending id
     order, so two transactions with overlapping sets queue instead of
     deadlocking.
   - `lockEventForUpdate` serializes whole-event work such as networking. Take
     it before anything else, and only in transactions that lock no
     sponsorship, registration or abstract row afterwards: registration writers
     reach the event row last, through its counter CAS.
   - Access rows carry the paid and registered counters, so
     `lockEventAccessRowsForUpdate` sits in the counter position: nothing is
     locked after it. An access edit locks its row before it checks a lower
     capacity against `paid_count`, so a payment's CAS waits and then meets the
     new capacity. An edit that sets prerequisites locks every access row of the
     event, because a cycle can close through items neither of two concurrent
     edits names.
   - Each helper is a bare `SELECT id … FOR UPDATE` on one table and throws
     outside a transaction, where the lock would be released at once. Never put
     `FOR UPDATE` on a joined read: it also locks the joined event and client
     rows, which serializes unrelated work and breaks the lock order.
3. **Other registrations go through the outbox.** A transaction that settles or
   locks one registration never changes another one. A capacity drop that
   re-settles every holder of an access item enqueues an outbox event, and the
   worker handles each registration in its own locking transaction. The one
   exception is a change to one sponsorship (link, unlink, cancel, delete,
   coverage edit; `src/settlement/sponsorship-link.ts`): it locks that
   sponsorship, then every registration linked to it in ascending id order, and
   settles each in the same transaction, so a refusal on one rolls the whole
   change back. That set is bounded by the sponsorship's usages and follows the
   lock order.
4. **Only the settlement writer writes money columns.** `total_amount`,
   `paid_amount`, `sponsorship_amount`, `payment_status`, `paid_at` and the
   `price_breakdown` JSON are written by `applyRegistrationSettlement` /
   `settleRegistrationTxn` (`src/settlement/`, plan item 2.6) under the
   registration lock. No other writer of these columns may be added. Migration
   0011 is the one data repair that rewrote `total_amount` outside it.
5. **Final abstract statuses are guarded in SQL.** Every UPDATE that changes an
   abstract's status carries `status NOT IN (FINAL_STATUSES)` in its WHERE
   clause, as `finalizeAbstractTxn` does, and treats "no row updated" as
   "already final". A status check in code alone is a race.

Shared status sets have one definition each: `FULLY_SETTLED_STATUSES` /
`isFullySettled` (`@app/shared`, `payment-status.ts`: PAID, SPONSORED and
WAIVED, nothing owed and every item in paid capacity) and `FINAL_STATUSES`
(`@app/contracts`) for abstracts.

### Consequences

- Reviewers reject `find → compute → update` on these rows unless it follows
  rule 1, rule 2, or a SERIALIZABLE transaction with retry.
- Row locks are held until commit, so locking transactions stay short and make
  no network calls.

### Verification

- `tests/db/locks.db.test.ts` (both engines): each lock blocks a second locker
  of the same row until commit and locks nothing else (not the event, not
  other registrations); the locked row is re-read with the first transaction's
  committed write; `[b, a]` and `[a, b]` lock requests queue without
  deadlocking; `withLockingTxn` re-runs the victim of a real deadlock.
- The concurrency tier (`tests/concurrency/**`) runs oversell, settlement drift
  and score aggregation with real parallel transactions.
  `apps/api/src/modules/access/access.concurrency.test.ts` races a capacity
  edit against a payment, and two prerequisite edits that together would form
  a cycle.
