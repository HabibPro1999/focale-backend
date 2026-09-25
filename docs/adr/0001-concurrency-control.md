# ADR 0001: Concurrency control (isolation, row locks, retries)

Status: Accepted 2026-05-30. Revised 2026-09 for the NestJS/Drizzle backend
(`apps/` + `packages/`, remediation plan item 2.2). The helpers named here live
in `packages/db/src/txn.ts` and `packages/db/src/locks.ts`.

## Context

Production runs on CockroachDB with `sql.txn.read_committed_isolation.enabled`
on. Its session default is SERIALIZABLE, so every application transaction asks
for its isolation explicitly. PostgreSQL (tests, local) defaults to READ
COMMITTED.

- `withTxn` is READ COMMITTED: the fast default. Under it a lost update does
  not abort; it silently overwrites. Any `read → compute → write` over rows
  that another transaction can change at the same time is a bug unless one of
  the rules below makes it safe.
- `withSerializableTxn` is SERIALIZABLE with `withTxnRetry`. It is for
  multi-row invariants that no single row lock expresses. Keep these
  transactions short, because they abort under contention.
- `withLockingTxn` is READ COMMITTED with `withTxnRetry`, for the lock-first
  pattern below. The retry covers a deadlock between lockers (40P01 on
  PostgreSQL, 40001 on CockroachDB) and CockroachDB restarts.

Every retried transaction may run more than once, so its callback does
database work only. Email, storage and HTTP go through the outbox or happen
after commit.

## Decision

Every mutation of capacity, money, or a denormalized aggregate follows these
rules.

1. **Counters use CAS.** A counter changes in one guarded statement,
   `UPDATE … SET n = n + 1 WHERE <guard> RETURNING …`, which checks and writes
   at once and is correct at any isolation level. Examples:
   `casIncrementRegisteredTx`, `casIncrementAccessRegisteredCount`,
   `casIncrementAccessPaidCount`, `casSetSponsorshipUsed`. Never read a
   counter, add to it in code and write it back.

2. **Lock first, then re-read.** A transaction that recomputes a row from
   other rows (settlement from sponsorship usages, a score aggregate from
   reviews) or validates a status before changing it:
   - runs in `withLockingTxn`;
   - locks its rows first, with the helpers in `locks.ts`:
     `lockRegistrationForUpdate` / `lockRegistrationsForUpdate`,
     `lockSponsorshipForUpdate` / `lockSponsorshipsForUpdate` /
     `lockSponsorshipByCodeForUpdate`,
     `lockAbstractForUpdate` / `lockAbstractsForUpdate`, and
     `lockEventForUpdate`;
   - then re-reads the locked rows and decides only from what it read after
     the lock. A value read before the lock, or passed in by the caller, is
     stale.

   Lock order is **sponsorships → registrations → abstracts**, then counter
   CAS updates, which also lock the counter row until commit. Several rows of
   one table are locked with the plural helper, which takes them in ascending
   id order. Two transactions that lock overlapping sets then queue instead of
   deadlocking. `lockEventForUpdate` serializes whole-event work, such as
   networking. Take it before anything else, and only in transactions that
   lock no sponsorship, registration or abstract rows afterwards: registration
   writers reach the event row last, through its counter CAS.

   Each helper is a bare `SELECT id … FOR UPDATE` on one table. It throws
   outside a transaction, where the lock would be released at once. Never put
   `FOR UPDATE` on a joined read. It would also lock the joined event and
   client rows, which serializes unrelated work and breaks the lock order.

3. **Other registrations go through the outbox.** A transaction that settles
   or locks one registration never changes another registration. An example
   is a capacity drop that re-settles every registration holding an access
   item. It enqueues an outbox event instead. The worker then handles each
   affected registration in its own locking transaction. This keeps the lock
   order and keeps each transaction small.

   The exception is a change to one sponsorship (link, unlink, cancel, delete,
   coverage edit; `packages/db/src/settlement/sponsorship-link.ts`): it locks
   that sponsorship first, then every registration it is linked to in
   ascending id order, and settles each in the same transaction, so a refusal
   on one of them rolls the whole change back. That set is bounded by the
   sponsorship's own usages and follows the lock order.

4. **Only the settlement writer writes money columns.** `total_amount`,
   `paid_amount`, `sponsorship_amount`, `payment_status`, `paid_at` and the
   `price_breakdown` JSON are written by the one settlement writer
   (`applyRegistrationSettlement` / `settleRegistrationTxn` in
   `packages/db/src/settlement/`, plan item 2.6), under the registration lock.
   New code must not add another writer of these columns.

5. **Final abstract statuses are guarded in SQL.** Every UPDATE that changes
   an abstract's status also carries
   `status NOT IN (FINAL_STATUSES)` in its WHERE clause, as
   `finalizeAbstractTxn` does. It treats "no row updated" as "already final".
   A status check in code alone is a race.

Shared status sets have one definition each:
- `FULLY_SETTLED_STATUSES` / `isFullySettled` (`@app/shared`,
  `payment-status.ts`): PAID, SPONSORED and WAIVED, meaning nothing is owed
  and every item occupies paid capacity;
- `FINAL_STATUSES` (`@app/contracts`) for abstracts.

## Consequences

- Reviewers reject `find → compute → update` on these rows unless it follows
  rule 1, rule 2, or a SERIALIZABLE transaction with retry.
- Plan items 2.6, 2.8 and 2.9 move the existing registration, sponsorship,
  access and abstract writers onto these helpers. Some writers still take raw
  locks or none at all until then (see the `it.fails` concurrency tests).
- Row locks are held until commit, so locking transactions stay short and
  contain no network calls.

## Verification

- `packages/db/tests/db/locks.db.test.ts` (both engines):
  - each lock blocks a second locker of the same row until commit;
  - it locks nothing else (not the event or other registrations);
  - the locked row is re-read with the first transaction's committed write;
  - `[b, a]` and `[a, b]` lock requests queue without deadlocking;
  - `withLockingTxn` re-runs the victim of a real deadlock.
- The concurrency tier (`packages/db/tests/concurrency/**`) exercises
  oversell, settlement drift and score aggregation with real parallel
  transactions.
