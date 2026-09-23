-- migrate: transaction per-file
-- migrate: idempotent
CREATE INDEX IF NOT EXISTS "committee_invite_tokens_user_id_event_id_idx" ON "committee_invite_tokens" ("user_id", "event_id");
