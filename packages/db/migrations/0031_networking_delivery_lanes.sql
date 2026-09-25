-- migrate: transaction per-statement
-- migrate: idempotent
-- Networking delivery lanes (plan 4.2). Sign-in codes (OTP) have dedicated
-- worker lanes, so each kind of delivery is claimed from its own partial
-- index, oldest due first; the claim query repeats each predicate.
-- networking_deliveries (event_id) serves the retention purge and the
-- withdrawal erasure (4.4). The erasure scan reads withdrawn profiles that are
-- not yet erased, so its index leaves the tombstones out; it replaces
-- networking_profiles_withdrawn_idx from 0025.
-- One statement per transaction: CockroachDB must commit each schema change
-- before a later statement relies on it. A plain CREATE INDEX briefly blocks
-- writes to the table on PostgreSQL.
CREATE INDEX IF NOT EXISTS networking_deliveries_claim_idx ON networking_deliveries (available_at)
 WHERE type <> 'OTP' AND status IN ('PENDING', 'PROCESSING', 'FAILED') AND attempts < 5;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS networking_deliveries_otp_claim_idx ON networking_deliveries (available_at)
 WHERE type = 'OTP' AND status IN ('PENDING', 'PROCESSING', 'FAILED') AND attempts < 5;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS networking_deliveries_event_idx ON networking_deliveries (event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS networking_profiles_erasure_due_idx ON networking_profiles (withdrawn_at)
 WHERE withdrawn_at IS NOT NULL AND erased_at IS NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS networking_profiles_withdrawn_idx;
