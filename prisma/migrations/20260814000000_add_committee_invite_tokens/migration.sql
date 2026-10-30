-- CreateTable
-- Single statement: CockroachDB v26 creates new tables with schema_locked=true,
-- which rejects follow-up CREATE INDEX / ADD CONSTRAINT statements inside the
-- migration transaction — so indexes and FKs are declared inline.
CREATE TABLE IF NOT EXISTS "committee_invite_tokens" (
    "id" STRING NOT NULL,
    "token_hash" STRING NOT NULL,
    "user_id" STRING NOT NULL,
    "event_id" STRING NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" STRING,

    CONSTRAINT "committee_invite_tokens_pkey" PRIMARY KEY ("id"),
    UNIQUE INDEX "committee_invite_tokens_token_hash_key" ("token_hash"),
    INDEX "committee_invite_tokens_user_id_event_id_idx" ("user_id", "event_id"),
    CONSTRAINT "committee_invite_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "committee_invite_tokens_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
