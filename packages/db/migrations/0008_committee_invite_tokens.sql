-- migrate: transaction per-file
-- migrate: idempotent
-- Inline constraints work on both Postgres and CockroachDB. The secondary
-- index is in 0009, after the create transaction commits (CRDB schema_locked).
CREATE TABLE IF NOT EXISTS "committee_invite_tokens" (
  "id" text PRIMARY KEY,
  "token_hash" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "event_id" text NOT NULL REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "expires_at" timestamp(3) NOT NULL,
  "used_at" timestamp(3),
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" text,
  CONSTRAINT "committee_invite_tokens_token_hash_key" UNIQUE ("token_hash")
);
