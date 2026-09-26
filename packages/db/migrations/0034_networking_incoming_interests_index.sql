-- migrate: transaction per-statement
-- migrate: idempotent
-- Networking incoming interests (plan 4.9): an exhibitor's "who liked me"
-- list pages newest first by keyset on (created_at, id). The partial index
-- holds only likes; the query repeats `action = 'LIKE'` and reads the index
-- backwards for the descending order, stopping after one page.
-- One statement per transaction (CockroachDB schema changes). A plain CREATE
-- INDEX briefly blocks writes to the table on PostgreSQL.
CREATE INDEX IF NOT EXISTS networking_interests_incoming_idx ON networking_interests (event_id, target_id, created_at, id)
 WHERE action = 'LIKE';
