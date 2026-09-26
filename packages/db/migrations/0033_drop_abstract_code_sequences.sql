-- migrate: transaction per-statement
-- migrate: idempotent
-- 6.5: abstract_code_sequences was a global per-final-type code counter from
-- the legacy app. Abstract codes are allocated per event and theme from
-- abstract_code_counters, and no code path reads or writes this table any
-- more, so it is dropped with any rows it still holds.
--
-- The unique index is dropped first by name so the catalog check (verify
-- --schema and adopt) sees this migration remove both objects 0000 created;
-- DROP TABLE alone would remove the index too. One statement per transaction,
-- and IF EXISTS makes a rerun after a crash a no-op.
DROP INDEX IF EXISTS abstract_code_sequences_final_type_key;
--> statement-breakpoint
DROP TABLE IF EXISTS abstract_code_sequences;
