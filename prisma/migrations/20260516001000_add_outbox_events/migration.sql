CREATE TABLE IF NOT EXISTS "outbox_events" (
  "id" STRING NOT NULL DEFAULT gen_random_uuid()::STRING,
  "type" STRING NOT NULL,
  "aggregate_type" STRING NULL,
  "aggregate_id" STRING NULL,
  "client_id" STRING NULL,
  "event_id" STRING NULL,
  "dedupe_key" STRING NULL,
  "payload" JSONB NOT NULL,
  "status" STRING NOT NULL DEFAULT 'PENDING',
  "attempt_count" INT4 NOT NULL DEFAULT 0,
  "max_attempts" INT4 NOT NULL DEFAULT 5,
  "last_attempt_at" TIMESTAMP(3) NULL,
  "next_attempt_at" TIMESTAMP(3) NULL,
  "locked_at" TIMESTAMP(3) NULL,
  "locked_until" TIMESTAMP(3) NULL,
  "locked_by" STRING NULL,
  "error_message" STRING NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3) NULL,
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "outbox_events_status_next_attempt_at_created_at_idx"
  ON "outbox_events" ("status", "next_attempt_at", "created_at");

CREATE INDEX IF NOT EXISTS "outbox_events_status_locked_until_idx"
  ON "outbox_events" ("status", "locked_until");

CREATE INDEX IF NOT EXISTS "outbox_events_locked_by_idx"
  ON "outbox_events" ("locked_by");

CREATE INDEX IF NOT EXISTS "outbox_events_type_idx"
  ON "outbox_events" ("type");

CREATE INDEX IF NOT EXISTS "outbox_events_aggregate_type_aggregate_id_idx"
  ON "outbox_events" ("aggregate_type", "aggregate_id");

CREATE INDEX IF NOT EXISTS "outbox_events_client_id_event_id_idx"
  ON "outbox_events" ("client_id", "event_id");

CREATE UNIQUE INDEX IF NOT EXISTS "outbox_events_dedupe_key_key"
  ON "outbox_events" ("dedupe_key")
  WHERE "dedupe_key" IS NOT NULL;
